"""Built-in model registry: capabilities and public prices, with their source and date.

Prices are per million tokens. They drive *estimated* costs only (labelled as such in the UI);
a provider-reported cost always wins. Unknown models have no price: their cost is shown as
"unavailable", never as zero. Workspaces and the instance admin can add or override entries
(see the registry module).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

D = Decimal


@dataclass(frozen=True)
class Price:
    input: Decimal
    output: Decimal
    cached_input: Decimal | None = None
    cache_write: Decimal | None = None


@dataclass(frozen=True)
class PeakWindow:
    """Weekly UTC window where `peak` prices apply (e.g. DeepSeek's peak hours)."""

    weekdays: frozenset[int]  # Monday = 0
    hours: frozenset[int]  # UTC hours, start inclusive


@dataclass(frozen=True)
class Pricing:
    standard: Price
    peak: Price | None = None
    peak_window: PeakWindow | None = None
    currency: str = "USD"
    source_url: str = ""
    as_of: date = date(2026, 10, 11)
    notes: str = ""

    def price_at(self, when: datetime) -> tuple[Price, str]:
        if self.peak and self.peak_window:
            moment = when.astimezone(UTC)
            if (
                moment.weekday() in self.peak_window.weekdays
                and moment.hour in self.peak_window.hours
            ):
                return self.peak, "peak"
            return self.standard, "off_peak"
        return self.standard, "standard"


@dataclass(frozen=True)
class ModelInfo:
    provider_kind: str
    id: str
    display_name: str
    context_window: int
    max_output_tokens: int
    supports_tools: bool = True
    supports_json: bool = True
    supports_vision: bool = False
    # "none": no reasoning; "optional": can be switched off; "always": cannot be switched off.
    reasoning: Literal["none", "optional", "always"] = "none"
    thinking_style: Literal["none", "adaptive_default", "adaptive_opt_in", "budget", "toggle"] = (
        "none"
    )
    thinking_off: Literal["disabled", "between_tools", "never", "toggle"] = "never"
    supports_effort: bool = False
    supports_sampling: bool = True
    pricing: Pricing | None = None
    recommended: bool = False
    tags: tuple[str, ...] = field(default_factory=tuple)


DEEPSEEK_PEAK = PeakWindow(weekdays=frozenset(range(5)), hours=frozenset({1, 2, 3, 6, 7, 8, 9}))
DEEPSEEK_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing"
ANTHROPIC_SOURCE = "https://docs.claude.com/en/docs/about-claude/pricing"
ANTHROPIC_NOTE = (
    "Cache prices not published in our source are estimated at 0.1x (read)"
    " and 1.25x (write) of input."
)


def _anthropic(input_: str, output: str, cached: str | None = None) -> Pricing:
    i = D(input_)
    return Pricing(
        standard=Price(
            input=i,
            output=D(output),
            cached_input=D(cached) if cached else i * D("0.1"),
            cache_write=i * D("1.25"),
        ),
        source_url=ANTHROPIC_SOURCE,
        as_of=date(2026, 10, 6),
        notes=ANTHROPIC_NOTE,
    )


CATALOG: tuple[ModelInfo, ...] = (
    # ------------------------------------------------------------------ DeepSeek (official API)
    ModelInfo(
        "deepseek",
        "deepseek-flash",
        "DeepSeek V4.1 Flash",
        1_000_000,
        384_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="toggle",
        thinking_off="toggle",
        pricing=Pricing(
            standard=Price(D("0.15"), D("0.6"), D("0.003")),
            peak=Price(D("0.3"), D("1.2"), D("0.006")),
            peak_window=DEEPSEEK_PEAK,
            source_url=DEEPSEEK_SOURCE,
            notes="Off-peak rates are half the peak rates (peak: 01-04 and 06-10 UTC, Mon-Fri).",
        ),
        recommended=True,
        tags=("fast", "cheap"),
    ),
    ModelInfo(
        "deepseek",
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        1_000_000,
        384_000,
        reasoning="optional",
        thinking_style="toggle",
        thinking_off="toggle",
        pricing=Pricing(
            standard=Price(D("0.66"), D("1.98"), D("0.022")),
            peak=Price(D("1.32"), D("3.96"), D("0.044")),
            peak_window=DEEPSEEK_PEAK,
            source_url=DEEPSEEK_SOURCE,
            notes="Off-peak rates are half the peak rates (peak: 01-04 and 06-10 UTC, Mon-Fri).",
        ),
        tags=("reasoning",),
    ),
    # ------------------------------------------------------------------ Anthropic
    ModelInfo(
        "anthropic",
        "claude-opus-5-5",
        "Claude Opus 5.5",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="always",
        thinking_style="adaptive_default",
        thinking_off="never",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("4", "20", "0.20"),
        recommended=True,
        tags=("reasoning",),
    ),
    ModelInfo(
        "anthropic",
        "claude-fable-5-1",
        "Claude Fable 5.1",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="always",
        thinking_style="adaptive_default",
        thinking_off="never",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("10", "50", "0.25"),
        tags=("most-capable",),
    ),
    ModelInfo(
        "anthropic",
        "claude-sonnet-5-5",
        "Claude Sonnet 5.5",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_default",
        thinking_off="between_tools",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("2", "10", "0.20"),
        tags=("balanced",),
    ),
    ModelInfo(
        "anthropic",
        "claude-haiku-5-5",
        "Claude Haiku 5.5",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_default",
        thinking_off="disabled",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("0.10", "0.50"),
        tags=("fast", "cheap"),
    ),
    ModelInfo(
        "anthropic",
        "claude-opus-5",
        "Claude Opus 5",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_default",
        thinking_off="disabled",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("5", "25"),
    ),
    ModelInfo(
        "anthropic",
        "claude-sonnet-5",
        "Claude Sonnet 5",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_default",
        thinking_off="disabled",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("2", "10"),
    ),
    ModelInfo(
        "anthropic",
        "claude-opus-4-8",
        "Claude Opus 4.8",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_opt_in",
        thinking_off="disabled",
        supports_effort=True,
        supports_sampling=False,
        pricing=_anthropic("5", "25"),
    ),
    ModelInfo(
        "anthropic",
        "claude-sonnet-4-6",
        "Claude Sonnet 4.6",
        1_000_000,
        128_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="adaptive_opt_in",
        thinking_off="disabled",
        supports_effort=True,
        pricing=_anthropic("3", "15"),
    ),
    ModelInfo(
        "anthropic",
        "claude-haiku-4-5",
        "Claude Haiku 4.5",
        200_000,
        64_000,
        supports_vision=True,
        reasoning="optional",
        thinking_style="budget",
        thinking_off="disabled",
        pricing=_anthropic("1", "5"),
    ),
    # ------------------------------------------------------------------ deterministic test adapter
    ModelInfo(
        "test",
        "gouvra-test-1",
        "Gouvra test model",
        128_000,
        8_000,
        reasoning="optional",
        thinking_style="toggle",
        thinking_off="toggle",
        recommended=True,
        tags=("offline", "deterministic"),
    ),
)

_INDEX = {(m.provider_kind, m.id): m for m in CATALOG}
# OpenAI-compatible gateways often expose the same model ids under other kinds.
_BY_ID = {m.id: m for m in CATALOG}


def find_model(provider_kind: str, model_id: str) -> ModelInfo | None:
    return _INDEX.get((provider_kind, model_id)) or (
        _BY_ID.get(model_id) if provider_kind == "openai_compatible" else None
    )


def models_for(provider_kind: str) -> list[ModelInfo]:
    return [m for m in CATALOG if m.provider_kind == provider_kind]
