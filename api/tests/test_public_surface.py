"""Fail closed: every route needs a session or a service key, except a short reviewed list."""

from __future__ import annotations

import re
from typing import Any

PLACEHOLDER = "00000000-0000-4000-8000-000000000000"

# Reviewed public surface: (method, path) → why it may answer without credentials.
PUBLIC: dict[tuple[str, str], str] = {
    ("GET", "/api/v1/meta"): "instance facts the sign-in page needs (sign-up open, OAuth buttons)",
    ("GET", "/api/v1/billing/plans"): "the public price list",
    ("POST", "/api/v1/auth/register"): "sign-up (rate limited, no account enumeration)",
    ("POST", "/api/v1/auth/login"): "sign-in (rate limited, neutral answers)",
    ("POST", "/api/v1/auth/verify-email"): "single-use e-mailed token",
    ("POST", "/api/v1/auth/verify-email/resend"): "rate limited, neutral answer",
    ("POST", "/api/v1/auth/email/confirm"): "single-use e-mailed token (address change)",
    ("POST", "/api/v1/auth/password/forgot"): "rate limited, neutral answer",
    ("POST", "/api/v1/auth/password/reset"): "single-use e-mailed token",
    ("GET", "/api/v1/auth/oauth/{provider}/start"): "OAuth redirect with PKCE and signed state",
    ("GET", "/api/v1/auth/oauth/{provider}/callback"): "OAuth return, state checked",
    ("POST", "/api/v1/invitations/preview"): "who invites to what, for the holder of the token",
    ("POST", "/api/v1/hooks/{token}"): "inbound webhook: 192-bit address and HMAC signature",
    ("POST", "/api/v1/billing/stripe/webhook"): "Stripe events, signature verified",
}


def _routes() -> list[tuple[str, str]]:
    from gouvra.main import create_app

    methods = {"get", "post", "put", "patch", "delete"}
    paths = create_app().openapi()["paths"]
    return sorted(
        (method.upper(), path)
        for path, operations in paths.items()
        for method in operations
        if method in methods
    )


async def test_only_reviewed_routes_answer_without_credentials(make_client: Any) -> None:
    client = make_client(csrf=False)
    routes = _routes()
    assert len(routes) > 100, "the route table could not be read"
    assert set(PUBLIC) <= set(routes), "a reviewed public route no longer exists"
    open_routes = []
    for method, path in routes:
        url = re.sub(r"\{[^}]+\}", PLACEHOLDER, path)
        body = {} if method in {"POST", "PUT", "PATCH"} else None
        response = await client.request(method, url, json=body)
        if response.status_code != 401:
            open_routes.append((method, path))
    # A new route without authentication fails here until it is reviewed and listed.
    assert sorted(open_routes) == sorted(PUBLIC)
