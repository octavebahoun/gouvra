"""Provider routes: kinds catalogue, configurations, connection tests."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, status
from sqlalchemy import func, select

from gouvra.core import ratelimit
from gouvra.core.authz import (
    CurrentActor,
    DbSession,
    Permission,
    WorkspaceContext,
    load_in_workspace,
    workspace_access,
)
from gouvra.core.db import utcnow
from gouvra.modules.providers import service
from gouvra.modules.providers.catalog import ModelInfo, models_for
from gouvra.modules.providers.models import ProviderConfig
from gouvra.modules.providers.registry import KINDS
from gouvra.modules.providers.schemas import (
    ConnectionTestOut,
    ModelInfoOut,
    PresetOut,
    PriceOut,
    PricingOut,
    ProviderCreateIn,
    ProviderKindOut,
    ProviderOut,
    ProviderUpdateIn,
    error_out,
)

router = APIRouter(tags=["providers"])
PROVIDER_TESTS = ratelimit.Limit("providers:test", 30, 60)


def model_info_out(info: ModelInfo) -> ModelInfoOut:
    pricing = None
    if info.pricing:
        p = info.pricing
        peak_hours = None
        if p.peak_window:
            hours = sorted(p.peak_window.hours)
            peak_hours = ", ".join(f"{h:02d}:00-{h + 1:02d}:00" for h in hours) + " UTC, Mon-Fri"
        pricing = PricingOut(
            currency=p.currency,
            standard=PriceOut(
                input=p.standard.input,
                output=p.standard.output,
                cached_input=p.standard.cached_input,
            ),
            peak=PriceOut(
                input=p.peak.input, output=p.peak.output, cached_input=p.peak.cached_input
            )
            if p.peak
            else None,
            peak_hours_utc=peak_hours,
            source_url=p.source_url,
            as_of=p.as_of,
            notes=p.notes,
        )
    return ModelInfoOut(
        id=info.id,
        display_name=info.display_name,
        context_window=info.context_window,
        max_output_tokens=info.max_output_tokens,
        supports_tools=info.supports_tools,
        supports_json=info.supports_json,
        supports_vision=info.supports_vision,
        reasoning=info.reasoning,
        recommended=info.recommended,
        tags=list(info.tags),
        pricing=pricing,
    )


async def provider_out(db: DbSession, provider: ProviderConfig) -> ProviderOut:
    return ProviderOut(
        id=provider.id,
        workspace_id=provider.workspace_id,
        name=provider.name,
        kind=provider.kind,
        kind_label=KINDS[provider.kind].label if provider.kind in KINDS else provider.kind,
        base_url=provider.base_url,
        secret_set=provider.secret_ciphertext is not None,
        secret_hint=f"••••{provider.secret_last4}"
        if provider.secret_last4
        else ("••••" if provider.secret_ciphertext else None),
        secret_updated_at=provider.secret_updated_at,
        default_model=provider.default_model,
        status=provider.status,  # type: ignore[arg-type]
        last_tested_at=provider.last_tested_at,
        last_test_latency_ms=provider.last_test_latency_ms,
        last_error=error_out(provider.last_error),
        models=list(provider.models or []),
        models_fetched_at=provider.models_fetched_at,
        agent_count=await service.provider_usage_count(db, provider.id),
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


@router.get("/providers/kinds", summary="Supported provider kinds, presets and known models")
async def provider_kinds(_: CurrentActor) -> list[ProviderKindOut]:
    return [
        ProviderKindOut(
            kind=spec.kind,
            label=spec.label,
            requires_api_key=spec.requires_api_key,
            requires_base_url=spec.requires_base_url,
            default_base_url=spec.default_base_url,
            docs_url=spec.docs_url,
            presets=[PresetOut(label=p.label, base_url=p.base_url) for p in spec.presets],
            models=[model_info_out(m) for m in models_for(spec.kind)],
        )
        for spec in KINDS.values()
    ]


@router.get("/workspaces/{workspace_id}/providers", summary="List provider configurations")
async def list_providers(
    db: DbSession, ctx: Annotated[WorkspaceContext, workspace_access(Permission.PROVIDERS_READ)]
) -> list[ProviderOut]:
    rows = (
        await db.execute(
            select(ProviderConfig)
            .where(
                ProviderConfig.workspace_id == ctx.workspace_id,
                ProviderConfig.archived_at.is_(None),
            )
            .order_by(ProviderConfig.created_at)
        )
    ).scalars()
    return [await provider_out(db, p) for p in rows]


@router.post(
    "/workspaces/{workspace_id}/providers",
    status_code=status.HTTP_201_CREATED,
    summary="Add a provider",
)
async def create_provider(
    payload: ProviderCreateIn,
    db: DbSession,
    ctx: Annotated[WorkspaceContext, workspace_access(Permission.PROVIDERS_MANAGE)],
) -> ProviderOut:
    provider = await service.create_provider(db, ctx, payload)
    return await provider_out(db, provider)


@router.get("/providers/{provider_id}", summary="Get a provider configuration")
async def get_provider(provider_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> ProviderOut:
    provider, _ = await load_in_workspace(
        db, ProviderConfig, provider_id, actor, Permission.PROVIDERS_READ
    )
    return await provider_out(db, provider)


@router.patch(
    "/providers/{provider_id}", summary="Update a provider (the key is replaced only if sent)"
)
async def update_provider(
    provider_id: uuid.UUID, payload: ProviderUpdateIn, actor: CurrentActor, db: DbSession
) -> ProviderOut:
    provider, ctx = await load_in_workspace(
        db, ProviderConfig, provider_id, actor, Permission.PROVIDERS_MANAGE
    )
    provider = await service.update_provider(db, ctx, provider, payload)
    return await provider_out(db, provider)


@router.delete(
    "/providers/{provider_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a provider"
)
async def delete_provider(provider_id: uuid.UUID, actor: CurrentActor, db: DbSession) -> None:
    provider, ctx = await load_in_workspace(
        db, ProviderConfig, provider_id, actor, Permission.PROVIDERS_MANAGE
    )
    await service.delete_provider(db, ctx, provider)


@router.post(
    "/providers/{provider_id}/test", summary="Test the connection and refresh the model list"
)
async def test_provider(
    provider_id: uuid.UUID, actor: CurrentActor, db: DbSession
) -> ConnectionTestOut:
    provider, ctx = await load_in_workspace(
        db, ProviderConfig, provider_id, actor, Permission.PROVIDERS_MANAGE
    )
    await ratelimit.hit(PROVIDER_TESTS, str(ctx.workspace_id))
    result = await service.test_provider(db, ctx, provider)
    return ConnectionTestOut(
        ok=result.ok,
        latency_ms=result.latency_ms,
        models=result.models,
        error=error_out(service.error_dict(result.error)),
        tested_at=utcnow(),
    )


async def count_providers(db: DbSession, workspace_id: uuid.UUID) -> int:
    return int(
        (
            await db.execute(
                select(func.count())
                .select_from(ProviderConfig)
                .where(
                    ProviderConfig.workspace_id == workspace_id,
                    ProviderConfig.archived_at.is_(None),
                )
            )
        ).scalar_one()
    )
