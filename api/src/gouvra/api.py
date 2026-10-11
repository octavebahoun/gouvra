"""Versioned API router: every module plugs its routes here."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from gouvra.core.config import get_settings

api_router = APIRouter()


def _include_modules() -> None:
    from gouvra.modules.agents.routes import router as agents_router
    from gouvra.modules.api_keys.routes import router as api_keys_router
    from gouvra.modules.executions.routes import router as executions_router
    from gouvra.modules.identity.routes import me_router
    from gouvra.modules.identity.routes import router as auth_router
    from gouvra.modules.providers.routes import router as providers_router
    from gouvra.modules.tools.routes import router as tools_router
    from gouvra.modules.workspaces.routes import invitations_router
    from gouvra.modules.workspaces.routes import router as workspaces_router

    for router in (
        auth_router,
        me_router,
        workspaces_router,
        invitations_router,
        api_keys_router,
        providers_router,
        tools_router,
        agents_router,
        executions_router,
    ):
        api_router.include_router(router)


class MetaOut(BaseModel):
    name: str
    version: str
    environment: str
    signup_enabled: bool
    oauth_providers: list[str]
    billing_enabled: bool


@api_router.get("/meta", tags=["meta"], summary="Public instance metadata")
async def meta() -> MetaOut:
    """What the web app needs before sign-in: enabled sign-in methods and features."""
    s = get_settings()
    return MetaOut(
        name=s.app_name,
        version=s.app_version,
        environment=s.app_env.value,
        signup_enabled=s.signup_enabled,
        oauth_providers=s.oauth_providers,
        billing_enabled=s.billing_provider.value != "none",
    )


_include_modules()
