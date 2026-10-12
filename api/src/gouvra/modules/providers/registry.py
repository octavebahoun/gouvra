"""Provider kinds, presets and the adapter factory."""

from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlsplit

from gouvra.core.config import get_settings
from gouvra.core.netguard import BlockedDestination, resolve_public
from gouvra.modules.providers.gateway.anthropic_adapter import AnthropicAdapter
from gouvra.modules.providers.gateway.openai_compatible import (
    DeepSeekAdapter,
    OpenAICompatibleAdapter,
)
from gouvra.modules.providers.gateway.testing import ScriptedModelAdapter
from gouvra.modules.providers.gateway.types import GatewayError, GatewayErrorCode, ModelAdapter


@dataclass(frozen=True)
class Preset:
    label: str
    base_url: str


@dataclass(frozen=True)
class ProviderKind:
    kind: str
    label: str
    requires_api_key: bool
    requires_base_url: bool
    default_base_url: str | None
    docs_url: str
    presets: tuple[Preset, ...] = field(default_factory=tuple)


KINDS: dict[str, ProviderKind] = {
    "deepseek": ProviderKind(
        "deepseek",
        "DeepSeek",
        True,
        False,
        DeepSeekAdapter.DEFAULT_BASE_URL,
        "https://api-docs.deepseek.com/",
    ),
    "anthropic": ProviderKind(
        "anthropic",
        "Anthropic",
        True,
        False,
        "https://api.anthropic.com",
        "https://docs.claude.com/",
    ),
    "openai_compatible": ProviderKind(
        "openai_compatible",
        "OpenAI-compatible",
        True,
        True,
        None,
        "https://platform.openai.com/docs/api-reference/chat",
        (
            Preset("OpenAI", "https://api.openai.com/v1"),
            Preset("OpenRouter", "https://openrouter.ai/api/v1"),
            Preset("Groq", "https://api.groq.com/openai/v1"),
            Preset("Mistral", "https://api.mistral.ai/v1"),
            Preset("Together AI", "https://api.together.xyz/v1"),
            # Inside the containers `localhost` is the container itself: the host machine is
            # host.docker.internal (PROVIDER_ALLOW_PRIVATE_NETWORKS=true is needed).
            Preset("Ollama (self-hosted)", "http://host.docker.internal:11434/v1"),
        ),
    ),
    "test": ProviderKind(
        "test",
        "Test (deterministic, offline)",
        False,
        False,
        None,
        "https://gouvra.dev/docs/providers#test",
    ),
}


async def build_adapter(
    kind: str, *, api_key: str, base_url: str | None, timeout_s: float = 120.0
) -> ModelAdapter:
    """Instantiate the adapter for a provider configuration (after an SSRF check of its host)."""
    if kind == "test":
        return ScriptedModelAdapter(api_key=api_key)
    if base_url:
        parts = urlsplit(base_url)
        try:
            await resolve_public(
                parts.hostname or "",
                parts.port or (443 if parts.scheme == "https" else 80),
                allow_private=get_settings().provider_allow_private_networks,
            )
        except BlockedDestination as exc:
            message = {
                "private_address": "The provider URL resolves to a private address, which this"
                " instance does not allow (PROVIDER_ALLOW_PRIVATE_NETWORKS=true).",
                "forbidden_address": "The provider URL resolves to a link-local, metadata or"
                " reserved address, which is never allowed.",
            }.get(exc.reason, "The provider host name does not resolve.")
            raise GatewayError(GatewayErrorCode.MISCONFIGURED, message) from exc
    if kind == "deepseek":
        return DeepSeekAdapter(api_key=api_key, base_url=base_url, timeout_s=timeout_s)
    if kind == "anthropic":
        return AnthropicAdapter(api_key=api_key, base_url=base_url, timeout_s=timeout_s)
    if kind == "openai_compatible":
        if not base_url:
            raise GatewayError(GatewayErrorCode.MISCONFIGURED, "This provider needs a base URL.")
        return OpenAICompatibleAdapter(base_url=base_url, api_key=api_key, timeout_s=timeout_s)
    raise GatewayError(GatewayErrorCode.MISCONFIGURED, f"Unknown provider kind {kind!r}.")
