"""Authentication & account routes: /auth/* and /me/*."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core import ratelimit
from gouvra.core.authz import AnyActor, DbSession
from gouvra.core.config import get_settings
from gouvra.core.context import current_client_ip
from gouvra.core.errors import AppError, NotFound, Unauthorized
from gouvra.core.security import clear_session_cookies, set_session_cookies
from gouvra.modules.audit.service import record
from gouvra.modules.identity import oauth, service
from gouvra.modules.identity.auth import check_origin
from gouvra.modules.identity.models import User
from gouvra.modules.identity.schemas import (
    Accepted,
    ChangePasswordIn,
    EmailChangeIn,
    EmailIn,
    LoginIn,
    ProfileUpdateIn,
    RegisterIn,
    ResetPasswordIn,
    SessionItem,
    SessionOut,
    TokenIn,
    UserOut,
    WorkspaceSummary,
)
from gouvra.modules.workspaces.models import Membership, Workspace

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(check_origin)])
me_router = APIRouter(prefix="/me", tags=["me"])

NEUTRAL_REGISTER = "If this address can be used, we sent a confirmation link to it."
NEUTRAL_FORGOT = "If an account exists for this address, we sent a password reset link to it."


class SignupDisabled(AppError):
    status_code = 403
    code = "signup_disabled"
    title = "Sign-up is disabled on this instance"


async def user_out(db: AsyncSession, user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified=user.email_verified,
        locale=user.locale,
        theme=user.theme,
        is_superadmin=user.is_superadmin,
        is_demo=user.is_demo,
        has_password=user.password_hash is not None,
        oauth_providers=await service.oauth_providers_of(db, user.id),
        created_at=user.created_at,
    )


async def session_out(db: AsyncSession, user: User) -> SessionOut:
    rows = (
        await db.execute(
            select(Workspace, Membership.role)
            .join(Membership, Membership.workspace_id == Workspace.id)
            .where(Membership.user_id == user.id)
            .order_by(Workspace.name)
        )
    ).all()
    return SessionOut(
        user=await user_out(db, user),
        workspaces=[
            WorkspaceSummary(id=w.id, name=w.name, slug=w.slug, role=role, is_demo=w.is_demo)
            for w, role in rows
        ],
    )


async def _open_session(
    db: AsyncSession, response: Response, request: Request, user: User, method: str
) -> None:
    token, session = await service.create_session(
        db,
        user,
        ip_address=current_client_ip(),
        user_agent=request.headers.get("user-agent"),
        auth_method=method,
    )
    await db.commit()
    from gouvra.core.ids import hash_token

    set_session_cookies(response, token, hash_token(token), service.session_max_age(session))


# ---------------------------------------------------------------- auth


@router.post("/register", status_code=status.HTTP_202_ACCEPTED, summary="Create an account")
async def register(payload: RegisterIn, db: DbSession) -> Accepted:
    """Always answers 202 with the same message: it never reveals whether the address exists."""
    if not get_settings().signup_enabled:
        raise SignupDisabled()
    await ratelimit.hit(ratelimit.REGISTER_PER_IP, current_client_ip())
    await ratelimit.hit(ratelimit.EMAIL_PER_ADDRESS, payload.email)
    await service.register(
        db,
        email=payload.email,
        password=payload.password,
        display_name=payload.display_name,
        locale=payload.locale,
    )
    return Accepted(message=NEUTRAL_REGISTER)


@router.post("/login", summary="Sign in with e-mail and password")
async def login(
    payload: LoginIn, request: Request, response: Response, db: DbSession
) -> SessionOut:
    await ratelimit.hit(ratelimit.LOGIN_PER_IP, current_client_ip())
    await ratelimit.hit(ratelimit.LOGIN_PER_ACCOUNT, payload.email)
    user = await service.authenticate_password(db, payload.email, payload.password)
    await _open_session(db, response, request, user, "password")
    await ratelimit.reset(ratelimit.LOGIN_PER_ACCOUNT, payload.email)
    return await session_out(db, user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Sign out")
async def logout(actor: AnyActor, response: Response, db: DbSession) -> None:
    if actor.session is not None and actor.user is not None:
        await service.revoke_session(db, actor.user, actor.session.id)
        await db.commit()
    clear_session_cookies(response)


@router.get("/session", summary="Current user, workspaces and roles")
async def current_session(actor: AnyActor, db: DbSession) -> SessionOut:
    if actor.user is None:
        raise Unauthorized()
    return await session_out(db, actor.user)


@router.post("/verify-email", summary="Confirm an e-mail address (signs the user in)")
async def verify_email(
    payload: TokenIn, request: Request, response: Response, db: DbSession
) -> SessionOut:
    await ratelimit.hit(ratelimit.RESET_PER_IP, current_client_ip())
    user = await service.verify_email(db, payload.token)
    await _open_session(db, response, request, user, "email_link")
    return await session_out(db, user)


@router.post(
    "/verify-email/resend",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Send the confirmation link again",
)
async def resend_verification(
    request: Request, db: DbSession, payload: EmailIn | None = None
) -> Accepted:
    from gouvra.modules.identity.auth import authenticate_request

    await ratelimit.hit(ratelimit.EMAIL_PER_IP, current_client_ip())
    actor = await authenticate_request(request, db)
    user = actor.user if actor else None
    if user is None and payload is not None:
        user = await service.get_user_by_email(db, payload.email)
    if user is not None:
        await ratelimit.hit(ratelimit.EMAIL_PER_ADDRESS, user.email)
        await service.resend_verification(db, user)
    return Accepted(message=NEUTRAL_REGISTER)


@router.post(
    "/password/forgot",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request a password reset link",
)
async def forgot_password(payload: EmailIn, db: DbSession) -> Accepted:
    await ratelimit.hit(ratelimit.EMAIL_PER_IP, current_client_ip())
    await ratelimit.hit(ratelimit.EMAIL_PER_ADDRESS, payload.email)
    await service.forgot_password(db, payload.email)
    return Accepted(message=NEUTRAL_FORGOT)


@router.post("/password/reset", summary="Set a new password with a reset link (signs the user in)")
async def reset_password(
    payload: ResetPasswordIn, request: Request, response: Response, db: DbSession
) -> SessionOut:
    await ratelimit.hit(ratelimit.RESET_PER_IP, current_client_ip())
    user = await service.reset_password(db, payload.token, payload.password)
    await _open_session(db, response, request, user, "password")
    return await session_out(db, user)


@router.post("/email/confirm", summary="Confirm a new sign-in address")
async def confirm_email_change(
    payload: TokenIn, request: Request, response: Response, db: DbSession
) -> SessionOut:
    await ratelimit.hit(ratelimit.RESET_PER_IP, current_client_ip())
    user = await service.confirm_email_change(db, payload.token)
    await _open_session(db, response, request, user, "email_link")
    return await session_out(db, user)


@router.get(
    "/oauth/{provider}/start", summary="Start OAuth sign-in", response_class=RedirectResponse
)
async def oauth_start(
    provider: str,
    next_path: Annotated[str | None, Query(alias="next", max_length=512)] = None,
) -> RedirectResponse:
    if provider not in oauth.PROVIDERS or not oauth.enabled(provider):
        raise NotFound("Unknown sign-in provider")
    url, cookie = oauth.start(provider, next_path)
    response = RedirectResponse(url, status_code=status.HTTP_302_FOUND)
    response.set_cookie(
        oauth.STATE_COOKIE,
        cookie,
        max_age=oauth.STATE_TTL_S,
        path=oauth.STATE_COOKIE_PATH,
        secure=get_settings().cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return response


@router.get("/oauth/{provider}/callback", summary="OAuth callback", response_class=RedirectResponse)
async def oauth_callback(
    provider: str,
    request: Request,
    db: DbSession,
    *,
    code: Annotated[str | None, Query(max_length=2048)] = None,
    state: Annotated[str | None, Query(max_length=256)] = None,
    error: Annotated[str | None, Query(max_length=256)] = None,
) -> RedirectResponse:
    app_url = get_settings().app_url
    failure = RedirectResponse(
        f"{app_url}/login?oauth_error=denied", status_code=status.HTTP_302_FOUND
    )
    if provider not in oauth.PROVIDERS or not oauth.enabled(provider):
        raise NotFound("Unknown sign-in provider")
    try:
        verifier, next_path = oauth.read_state_cookie(
            request.cookies.get(oauth.STATE_COOKIE), provider, state
        )
        identity = await oauth.exchange_and_identify(
            provider, oauth.require_code(code, error), verifier
        )
        locale = (
            "fr" if request.headers.get("accept-language", "").lower().startswith("fr") else "en"
        )
        user = await oauth.sign_in_with(db, identity, locale)
    except oauth.OAuthError as exc:
        await db.rollback()
        failure = RedirectResponse(
            f"{app_url}/login?oauth_error={exc.reason}", status_code=status.HTTP_302_FOUND
        )
        failure.delete_cookie(oauth.STATE_COOKIE, path=oauth.STATE_COOKIE_PATH)
        return failure
    response = RedirectResponse(f"{app_url}{next_path}", status_code=status.HTTP_302_FOUND)
    response.delete_cookie(oauth.STATE_COOKIE, path=oauth.STATE_COOKIE_PATH)
    await _open_session(db, response, request, user, provider)
    return response


# ---------------------------------------------------------------- me


@me_router.get("", summary="My profile")
async def get_me(actor: AnyActor, db: DbSession) -> UserOut:
    if actor.user is None:
        raise Unauthorized()
    return await user_out(db, actor.user)


@me_router.patch("", summary="Update my profile and preferences")
async def update_me(payload: ProfileUpdateIn, actor: AnyActor, db: DbSession) -> UserOut:
    if actor.user is None:
        raise Unauthorized()
    user = await service.update_profile(
        db,
        actor.user,
        display_name=payload.display_name,
        locale=payload.locale,
        theme=payload.theme,
    )
    return await user_out(db, user)


@me_router.post(
    "/password", status_code=status.HTTP_204_NO_CONTENT, summary="Change or set my password"
)
async def change_password(payload: ChangePasswordIn, actor: AnyActor, db: DbSession) -> None:
    if actor.user is None:
        raise Unauthorized()
    await ratelimit.hit(ratelimit.LOGIN_PER_ACCOUNT, actor.user.email)
    await service.change_password(
        db, actor.user, actor.session, payload.current_password, payload.new_password
    )


@me_router.post("/email", status_code=status.HTTP_202_ACCEPTED, summary="Change my sign-in address")
async def change_email(payload: EmailChangeIn, actor: AnyActor, db: DbSession) -> Accepted:
    if actor.user is None:
        raise Unauthorized()
    await ratelimit.hit(ratelimit.EMAIL_PER_ADDRESS, actor.user.email)
    await service.request_email_change(db, actor.user, payload.new_email, payload.password)
    return Accepted(message="We sent a confirmation link to the new address.")


@me_router.get("/sessions", summary="My active sessions")
async def my_sessions(actor: AnyActor, db: DbSession) -> list[SessionItem]:
    if actor.user is None:
        raise Unauthorized()
    current_id = actor.session.id if actor.session else None
    return [
        SessionItem(
            id=s.id,
            created_at=s.created_at,
            last_seen_at=s.last_seen_at,
            expires_at=s.expires_at,
            ip_address=s.ip_address,
            user_agent=s.user_agent,
            auth_method=s.auth_method,
            current=s.id == current_id,
        )
        for s in await service.list_sessions(db, actor.user)
    ]


@me_router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Revoke one of my sessions",
)
async def revoke_my_session(
    session_id: uuid.UUID, actor: AnyActor, response: Response, db: DbSession
) -> None:
    if actor.user is None:
        raise Unauthorized()
    await service.revoke_session(db, actor.user, session_id)
    await db.commit()
    if actor.session is not None and actor.session.id == session_id:
        clear_session_cookies(response)


@me_router.post("/sessions/revoke-others", summary="Sign out every other session")
async def revoke_other_sessions(actor: AnyActor, db: DbSession) -> dict[str, int]:
    if actor.user is None:
        raise Unauthorized()
    count = await service.revoke_all_sessions(
        db, actor.user.id, except_id=actor.session.id if actor.session else None
    )
    await record(
        db,
        "user.sessions_revoked",
        actor_user_id=actor.user.id,
        actor_label=actor.user.email,
        data={"count": count},
    )
    await db.commit()
    return {"revoked": count}
