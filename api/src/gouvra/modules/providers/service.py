"""Provider configurations: create, update, test, delete — with encrypted secrets."""

from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import WorkspaceContext
from gouvra.core.config import get_settings
from gouvra.core.crypto import EncryptedSecret, decrypt_secret, encrypt_secret
from gouvra.core.db import utcnow
from gouvra.core.errors import Conflict, ValidationFailed
from gouvra.core.ids import uuid7
from gouvra.core.netguard import validate_base_url
from gouvra.modules.audit.service import record_for
from gouvra.modules.providers.gateway.types import (
    ConnectionTest,
    GatewayError,
    GatewayErrorCode,
    ModelAdapter,
)
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.providers.registry import KINDS, build_adapter
from gouvra.modules.providers.schemas import ProviderCreateIn, ProviderUpdateIn

SECRET_PURPOSE = "provider_api_key"  # noqa: S105 - key purpose label, not a secret


def _store_secret(provider: ProviderConfig, api_key: str) -> None:
    sealed: EncryptedSecret = encrypt_secret(
        api_key, workspace_id=provider.workspace_id, resource_id=provider.id, purpose=SECRET_PURPOSE
    )
    provider.secret_ciphertext = sealed.ciphertext
    provider.secret_key_id = sealed.key_id
    provider.secret_last4 = sealed.last4
    provider.secret_updated_at = utcnow()


def provider_secret(provider: ProviderConfig) -> str:
    """Decrypt the API key — only ever used server-side to call the provider."""
    if provider.secret_ciphertext is None or provider.secret_key_id is None:
        return ""
    return decrypt_secret(
        provider.secret_ciphertext,
        provider.secret_key_id,
        workspace_id=provider.workspace_id,
        resource_id=provider.id,
        purpose=SECRET_PURPOSE,
    )


def _check_base_url(kind: str, base_url: str | None) -> str | None:
    spec = KINDS[kind]
    if spec.requires_base_url and not base_url:
        raise ValidationFailed(
            errors=[
                {
                    "field": "base_url",
                    "code": "required",
                    "message": "This provider needs a base URL.",
                }
            ]
        )
    if not base_url:
        return None
    return validate_base_url(base_url, allow_private=get_settings().provider_allow_private_networks)


async def create_provider(
    db: AsyncSession, ctx: WorkspaceContext, payload: ProviderCreateIn
) -> ProviderConfig:
    spec = KINDS[payload.kind]
    if spec.requires_api_key and not payload.api_key:
        raise ValidationFailed(
            errors=[
                {"field": "api_key", "code": "required", "message": "Enter the provider API key."}
            ]
        )
    provider = ProviderConfig(
        id=uuid7(),
        workspace_id=ctx.workspace_id,
        name=payload.name,
        kind=payload.kind,
        base_url=_check_base_url(payload.kind, payload.base_url),
        default_model=payload.default_model,
        settings={},
        status="untested",
        models=[],
        created_by_id=ctx.actor.user_id,
    )
    if payload.api_key:
        _store_secret(provider, payload.api_key)
    db.add(provider)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ValidationFailed(
            errors=[
                {
                    "field": "name",
                    "code": "taken",
                    "message": "A provider with this name already exists.",
                }
            ]
        ) from exc
    await record_for(
        db,
        ctx.actor,
        "provider.created",
        workspace_id=ctx.workspace_id,
        target_type="provider",
        target_id=provider.id,
        data={"name": provider.name, "kind": provider.kind},
    )
    await db.commit()
    return provider


async def update_provider(
    db: AsyncSession, ctx: WorkspaceContext, provider: ProviderConfig, payload: ProviderUpdateIn
) -> ProviderConfig:
    changed: list[str] = []
    if payload.name is not None and payload.name != provider.name:
        provider.name = payload.name
        changed.append("name")
    if payload.base_url is not None and payload.base_url != (provider.base_url or ""):
        provider.base_url = _check_base_url(provider.kind, payload.base_url or None)
        changed.append("base_url")
    if payload.default_model is not None and payload.default_model != provider.default_model:
        provider.default_model = payload.default_model
        changed.append("default_model")
    if payload.api_key:
        _store_secret(provider, payload.api_key)
        changed.append("api_key")
    if {"base_url", "api_key"} & set(changed):
        provider.status = "untested"
        provider.last_error = None
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ValidationFailed(
            errors=[
                {
                    "field": "name",
                    "code": "taken",
                    "message": "A provider with this name already exists.",
                }
            ]
        ) from exc
    if changed:
        await record_for(
            db,
            ctx.actor,
            "provider.updated",
            workspace_id=ctx.workspace_id,
            target_type="provider",
            target_id=provider.id,
            data={"fields": changed},
        )
    await db.commit()
    return provider


async def adapter_for(provider: ProviderConfig, *, timeout_s: float = 120.0) -> ModelAdapter:
    return await build_adapter(
        provider.kind,
        api_key=provider_secret(provider),
        base_url=provider.base_url,
        timeout_s=timeout_s,
    )


async def run_connection_test(provider: ProviderConfig) -> ConnectionTest:
    started = time.perf_counter()
    adapter: ModelAdapter | None = None
    try:
        adapter = await adapter_for(provider, timeout_s=20)
        models = await adapter.list_models()
        return ConnectionTest(
            ok=True, latency_ms=int((time.perf_counter() - started) * 1000), models=models
        )
    except GatewayError as exc:
        return ConnectionTest(
            ok=False, latency_ms=int((time.perf_counter() - started) * 1000), models=[], error=exc
        )
    finally:
        if adapter is not None:
            await adapter.aclose()


async def test_provider(
    db: AsyncSession, ctx: WorkspaceContext, provider: ProviderConfig
) -> ConnectionTest:
    result = await run_connection_test(provider)
    provider.last_tested_at = utcnow()
    provider.last_test_latency_ms = result.latency_ms
    if result.ok:
        provider.status = "ok"
        provider.last_error = None
        provider.models = result.models
        provider.models_fetched_at = utcnow()
        if not provider.default_model and result.models:
            from gouvra.modules.providers.catalog import models_for

            recommended = [
                m.id for m in models_for(provider.kind) if m.recommended and m.id in result.models
            ]
            provider.default_model = recommended[0] if recommended else result.models[0]
    else:
        assert result.error is not None  # noqa: S101 - set on failure
        provider.status = "error"
        provider.last_error = {"code": result.error.code.value, "message": result.error.message}
    await record_for(
        db,
        ctx.actor,
        "provider.tested",
        workspace_id=ctx.workspace_id,
        target_type="provider",
        target_id=provider.id,
        data={"ok": result.ok},
    )
    await db.commit()
    return result


async def provider_usage_count(db: AsyncSession, provider_id: uuid.UUID) -> int:
    from gouvra.modules.agents.models import Agent, AgentVersion

    query = (
        select(Agent.id)
        .join(AgentVersion, AgentVersion.id == Agent.current_version_id)
        .where(AgentVersion.provider_config_id == provider_id, Agent.archived_at.is_(None))
    )
    return len((await db.execute(query)).all())


async def delete_provider(
    db: AsyncSession, ctx: WorkspaceContext, provider: ProviderConfig
) -> None:
    in_use = await provider_usage_count(db, provider.id)
    if in_use:
        raise Conflict(
            f"{in_use} active agent(s) use this provider."
            " Point them to another provider or archive them first.",
            code="provider_in_use",
            details={"agent_count": in_use},
        )
    await record_for(
        db,
        ctx.actor,
        "provider.deleted",
        workspace_id=ctx.workspace_id,
        target_type="provider",
        target_id=provider.id,
        data={"name": provider.name},
    )
    await db.delete(provider)
    await db.commit()


def error_dict(exc: GatewayError | None) -> dict[str, Any] | None:
    return {"code": exc.code.value, "message": exc.message} if exc else None


def misconfigured(message: str) -> GatewayError:
    return GatewayError(GatewayErrorCode.MISCONFIGURED, message)
