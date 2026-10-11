"""Versioned API router: every module plugs its routes here."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from gouvra.core.config import get_settings

api_router = APIRouter()


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
