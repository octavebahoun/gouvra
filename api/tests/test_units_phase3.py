"""Unit tests: secret encryption, pricing, built-in tools, schema rules, SSRF guard."""

from __future__ import annotations

import socket
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from gouvra.core.config import get_settings
from gouvra.core.crypto import SecretDecryptionError, decrypt_secret, encrypt_secret
from gouvra.core.errors import ValidationFailed
from gouvra.core.netguard import (
    BlockedDestination,
    _is_public,
    _never_allowed,
    resolve_public,
    validate_base_url,
)
from gouvra.modules.providers.catalog import find_model
from gouvra.modules.providers.gateway.types import Usage
from gouvra.modules.providers.pricing import Cost, CostSource, combine, estimate
from gouvra.modules.tools.builtins import BUILTINS, ToolInputError, safe_eval
from gouvra.modules.tools.schema_rules import check_input_schema, strict, validate_arguments

WS, RES = uuid.uuid4(), uuid.uuid4()


# ---------------------------------------------------------------- crypto


def test_secret_round_trip_and_binding() -> None:
    sealed = encrypt_secret(
        "sk-live-0123456789abcdef", workspace_id=WS, resource_id=RES, purpose="provider_api_key"
    )
    assert b"sk-live" not in sealed.ciphertext
    assert sealed.last4 == "cdef"
    assert (
        decrypt_secret(
            sealed.ciphertext,
            sealed.key_id,
            workspace_id=WS,
            resource_id=RES,
            purpose="provider_api_key",
        )
        == "sk-live-0123456789abcdef"
    )
    with pytest.raises(SecretDecryptionError):
        decrypt_secret(
            sealed.ciphertext,
            sealed.key_id,
            workspace_id=uuid.uuid4(),
            resource_id=RES,
            purpose="provider_api_key",
        )
    with pytest.raises(SecretDecryptionError):
        decrypt_secret(
            sealed.ciphertext,
            sealed.key_id,
            workspace_id=WS,
            resource_id=RES,
            purpose="tool_secret",
        )
    tampered = sealed.ciphertext[:-1] + bytes([sealed.ciphertext[-1] ^ 1])
    with pytest.raises(SecretDecryptionError):
        decrypt_secret(
            tampered, sealed.key_id, workspace_id=WS, resource_id=RES, purpose="provider_api_key"
        )


def test_key_rotation_keeps_old_secrets_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = get_settings()
    old = encrypt_secret("short", workspace_id=WS, resource_id=RES, purpose="p")
    assert old.last4 == ""  # too short to show any character
    rotated = "knew:" + "B" * 43 + "," + settings.encryption_keys.get_secret_value()
    monkeypatch.setattr(settings, "encryption_keys", type(settings.encryption_keys)(rotated))
    new = encrypt_secret("fresh-secret-value", workspace_id=WS, resource_id=RES, purpose="p")
    assert new.key_id == "knew"
    assert (
        decrypt_secret(old.ciphertext, old.key_id, workspace_id=WS, resource_id=RES, purpose="p")
        == "short"
    )
    with pytest.raises(SecretDecryptionError, match="unknown key id"):
        decrypt_secret(old.ciphertext, "kgone", workspace_id=WS, resource_id=RES, purpose="p")


# ---------------------------------------------------------------- pricing


def test_deepseek_peak_and_off_peak_pricing() -> None:
    model = find_model("deepseek", "deepseek-flash")
    usage = Usage(input_tokens=1_000_000, output_tokens=1_000_000, cached_input_tokens=500_000)
    peak = estimate(model, usage, datetime(2026, 10, 12, 7, 30, tzinfo=UTC))  # Monday 07:30 UTC
    off = estimate(model, usage, datetime(2026, 10, 11, 7, 30, tzinfo=UTC))  # Sunday
    assert peak.price_period == "peak"
    assert off.price_period == "off_peak"
    assert peak.amount == Decimal("0.5") * Decimal("0.3") + Decimal("0.5") * Decimal(
        "0.006"
    ) + Decimal("1.2")
    assert off.amount is not None
    assert peak.amount is not None
    assert off.amount * 2 == peak.amount
    assert peak.source == CostSource.ESTIMATED


def test_cost_sources() -> None:
    assert (
        estimate(None, Usage(input_tokens=10), datetime.now(UTC)).source == CostSource.UNAVAILABLE
    )
    assert (
        estimate(
            find_model("test", "gouvra-test-1"), Usage(input_tokens=10), datetime.now(UTC)
        ).amount
        is None
    )
    reported = estimate(
        None,
        Usage(provider_cost=Decimal("0.0123"), provider_cost_currency="USD"),
        datetime.now(UTC),
    )
    assert reported.source == CostSource.PROVIDER_REPORTED
    total = combine([reported, Cost.unavailable()])
    assert total.partial is True
    assert total.source == CostSource.ESTIMATED
    assert combine([Cost.unavailable()]).source == CostSource.UNAVAILABLE


def test_anthropic_cache_pricing() -> None:
    model = find_model("anthropic", "claude-opus-5-5")
    cost = estimate(
        model,
        Usage(input_tokens=2_000_000, cached_input_tokens=1_000_000, output_tokens=0),
        datetime.now(UTC),
    )
    assert cost.amount == Decimal(4) + Decimal("0.20")


# ---------------------------------------------------------------- builtins


@pytest.mark.parametrize(
    ("expression", "result"),
    [
        ("1 + 2 * 3", 7),
        ("(12.5 * 4) / sqrt(16)", 12.5),
        ("2 ^ 10", 1024),
        ("max(3, 9, 4)", 9),
        ("-pi < 0", None),
    ],
)
def test_calculator(expression: str, result: float | None) -> None:
    if result is None:
        with pytest.raises(ToolInputError):
            safe_eval(expression)
    else:
        assert safe_eval(expression) == result


@pytest.mark.parametrize(
    "hostile",
    [
        "__import__('os').system('id')",
        "().__class__",
        "open('/etc/passwd')",
        "9**9**9",
        "1/0",
        "a" * 400,
        "lambda: 1",
        "[1,2]",
    ],
)
def test_calculator_refuses_code(hostile: str) -> None:
    with pytest.raises(ToolInputError):
        safe_eval(hostile)


async def test_clock_and_dates() -> None:
    clock = await BUILTINS["current_time"].run({"timezone": "Europe/Paris"}, {})
    assert clock["timezone"] == "Europe/Paris"
    with pytest.raises(ToolInputError):
        await BUILTINS["current_time"].run({"timezone": "Mars/Olympus"}, {})
    assert (
        await BUILTINS["date_calc"].run({"operation": "add", "date": "2026-02-27", "days": 2}, {})
    )["date"] == "2026-03-01"
    assert (
        await BUILTINS["date_calc"].run(
            {"operation": "diff", "date": "2026-01-01", "other_date": "2026-12-31"}, {}
        )
    )["days"] == 364


async def test_data_tools() -> None:
    data = {"items": [{"price": 4}, {"price": 9}]}
    assert (await BUILTINS["json_extract"].run({"data": data, "path": "items[1].price"}, {}))[
        "value"
    ] == 9
    assert (await BUILTINS["json_extract"].run({"data": data, "path": "items[5]"}, {}))[
        "found"
    ] is False
    stats = await BUILTINS["text_stats"].run({"text": "One two. Three!\nFour"}, {})
    assert (stats["words"], stats["sentences"], stats["lines"]) == (4, 3, 2)
    numbers = await BUILTINS["random"].run({"kind": "integer", "count": 5, "min": 1, "max": 3}, {})
    assert all(1 <= n <= 3 for n in numbers["values"])


# ---------------------------------------------------------------- schema rules


def test_tool_schemas_are_strict() -> None:
    schema = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    assert validate_arguments(schema, {"city": "Paris"}) == []
    assert validate_arguments(schema, {"city": "Paris", "extra": 1})  # unknown property refused
    assert validate_arguments(schema, {})  # missing required
    assert strict(schema)["additionalProperties"] is False
    assert "additionalProperties" not in schema  # original untouched
    with pytest.raises(ValidationFailed):
        check_input_schema({"type": "array"})
    with pytest.raises(ValidationFailed):
        check_input_schema({"type": "object", "properties": {"a": {"type": "nonsense"}}})
    with pytest.raises(ValidationFailed):
        check_input_schema(
            {"type": "object", "properties": {"a": {"$ref": "https://evil.example/schema.json"}}}
        )


# ---------------------------------------------------------------- SSRF guard


@pytest.mark.parametrize(
    ("address", "public"),
    [
        ("8.8.8.8", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("169.254.169.254", False),
        ("::1", False),
        ("::ffff:127.0.0.1", False),
        ("100.64.0.1", False),
        ("fd00::1", False),
    ],
)
def test_public_address_classification(address: str, public: bool) -> None:
    assert _is_public(address) is public


@pytest.mark.parametrize(
    ("address", "never"),
    [
        ("169.254.169.254", True),  # cloud metadata (AWS, GCP, Azure…)
        ("::ffff:169.254.169.254", True),
        ("fd00:ec2::254", True),  # AWS metadata over IPv6
        ("100.100.100.200", True),  # Alibaba Cloud metadata
        ("fe80::1", True),
        ("224.0.0.1", True),
        ("240.0.0.1", True),
        ("0.0.0.0", True),  # noqa: S104 - an address under test, not a bind
        ("127.0.0.1", False),
        ("::1", False),  # loopback, though inside IPv6's reserved ::/8
        ("192.168.1.10", False),
        ("172.17.0.1", False),  # Docker's host gateway
        ("100.64.0.1", False),  # carrier-grade NAT, e.g. a Tailscale peer
        ("fd00::1", False),
        ("8.8.8.8", False),
    ],
)
def test_addresses_no_setting_opens(address: str, never: bool) -> None:
    assert _never_allowed(address) is never


async def test_resolution_refuses_private_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(BlockedDestination):
        await resolve_public("localhost", 80)
    assert await resolve_public("localhost", 80, allow_private=True)

    # Allowing private networks never opens the cloud metadata endpoint.
    def metadata(host: str, port: int, *args: object, **kwargs: object) -> list[tuple[Any, ...]]:
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", port))]

    monkeypatch.setattr(socket, "getaddrinfo", metadata)
    with pytest.raises(BlockedDestination) as blocked:
        await resolve_public("metadata.google.internal", 80, allow_private=True)
    assert blocked.value.reason == "forbidden_address"


def test_base_url_validation() -> None:
    assert validate_base_url("https://api.example.com/v1/") == "https://api.example.com/v1"
    for bad in (
        "http://api.example.com",
        "https://127.0.0.1",
        "https://user:pw@api.example.com",
        "ftp://x.example",
        "https://localhost:8000",
        "https://svc.internal",
    ):
        with pytest.raises(ValidationFailed):
            validate_base_url(bad)
    assert validate_base_url("http://localhost:11434/v1", allow_private=True)
    assert validate_base_url("http://host.docker.internal:11434/v1", allow_private=True)
    with pytest.raises(ValidationFailed):
        validate_base_url("http://169.254.169.254/latest", allow_private=True)
    # The message names the setting that would allow a private host.
    with pytest.raises(ValidationFailed) as refused:
        validate_base_url("http://192.168.1.10:11434/v1", setting="PROVIDER_ALLOW_PRIVATE_NETWORKS")
    assert all(
        "PROVIDER_ALLOW_PRIVATE_NETWORKS=true" in error["message"] for error in refused.value.errors
    )


async def test_secret_rotation_command(lab, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    from sqlalchemy import select

    from gouvra.core.db import get_sessionmaker
    from gouvra.core.rotation import rotate_secrets
    from gouvra.modules.providers.models import ProviderConfig
    from tests.helpers import create_provider

    await create_provider(
        lab["owner"], lab["ws"]["id"], "deepseek", name="Keyed", api_key="sk-rotate-me-0123456789"
    )
    settings = get_settings()
    old_ring = settings.encryption_keys.get_secret_value()
    monkeypatch.setattr(
        settings,
        "encryption_keys",
        type(settings.encryption_keys)("k2026:" + "C" * 43 + "," + old_ring),
    )
    report = await rotate_secrets()
    assert (report.rotated, report.failed) == (1, 0)
    async with get_sessionmaker()() as db:
        row = (
            await db.execute(select(ProviderConfig).where(ProviderConfig.name == "Keyed"))
        ).scalar_one()
        assert row.secret_key_id == "k2026"
    from gouvra.modules.providers.service import provider_secret

    assert provider_secret(row) == "sk-rotate-me-0123456789"
    assert (await rotate_secrets()).rotated == 0  # idempotent
