"""`gouvra check-config`: verify that every configured variable is read and well-formed.

Values are never printed — only presence, format checks and (with --live) the outcome of a
read-only call to the provider.
"""

from __future__ import annotations

import asyncio
import re
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from email.utils import parseaddr

import httpx

from gouvra.core.config import Settings, get_settings


@dataclass
class Check:
    variable: str
    present: bool
    format_ok: bool | None
    note: str = ""
    live: str = ""


def _secret(settings: Settings, name: str) -> str:
    value = getattr(settings, name)
    return value.get_secret_value() if hasattr(value, "get_secret_value") else str(value or "")


FORMAT_RULES: dict[str, tuple[str, Callable[[str], bool]]] = {
    "resend_api_key": ("starts with re_", lambda v: v.startswith("re_") and len(v) > 10),
    "email_from": (
        "Name <address@domain>",
        lambda v: "@" in parseaddr(v)[1] and "." in parseaddr(v)[1].split("@")[-1],
    ),
    "deepseek_api_key": ("starts with sk-", lambda v: v.startswith("sk-") and len(v) > 20),
    "stripe_secret_key": ("test mode key sk_test_", lambda v: v.startswith("sk_test_")),
    "stripe_publishable_key": ("test mode key pk_test_", lambda v: v.startswith("pk_test_")),
    "stripe_webhook_secret": ("starts with whsec_", lambda v: v.startswith("whsec_")),
    "github_client_id": (
        "GitHub client id",
        lambda v: bool(re.fullmatch(r"[A-Za-z0-9._]{16,40}", v)),
    ),
    "github_client_secret": ("40 hex characters", lambda v: bool(re.fullmatch(r"[0-9a-f]{40}", v))),
    "google_client_id": (
        "*.apps.googleusercontent.com",
        lambda v: v.endswith(".apps.googleusercontent.com"),
    ),
    "google_client_secret": (
        "starts with GOCSPX-",
        lambda v: v.startswith("GOCSPX-") or len(v) >= 24,
    ),
    "anthropic_api_key": ("starts with sk-ant-", lambda v: v.startswith("sk-ant-")),
}


async def _live_deepseek(key: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            "https://api.deepseek.com/models", headers={"Authorization": f"Bearer {key}"}
        )
        if r.status_code != 200:
            return f"FAILED (HTTP {r.status_code})"
        models = [m.get("id") for m in r.json().get("data", [])]
        b = await client.get(
            "https://api.deepseek.com/user/balance", headers={"Authorization": f"Bearer {key}"}
        )
        available = b.json().get("is_available") if b.status_code == 200 else None
        return (
            f"OK — {len(models)} models ({', '.join(models[:4])}); balance available: {available}"
        )


async def _live_stripe(key: str) -> str:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get("https://api.stripe.com/v1/balance", auth=(key, ""))
        if r.status_code != 200:
            return f"FAILED (HTTP {r.status_code})"
        return f"OK — livemode={r.json().get('livemode')}"


async def _live_resend(key: str, sender: str) -> str:
    domain = parseaddr(sender)[1].split("@")[-1].lower()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            "https://api.resend.com/domains", headers={"Authorization": f"Bearer {key}"}
        )
        if r.status_code == 401 and "restricted" in r.text.lower():
            return "OK — key valid (sending-only key, domain list not readable)"
        if r.status_code != 200:
            return f"FAILED (HTTP {r.status_code})"
        for item in r.json().get("data", []):
            if str(item.get("name", "")).lower() == domain:
                return f"OK — sender domain status: {item.get('status')}"
        return "WARNING — sender domain not found in this Resend account"


async def _live_github(client_id: str) -> str:
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
        r = await client.get(
            "https://github.com/login/oauth/authorize",
            params={
                "client_id": client_id,
                "redirect_uri": "http://localhost:8000/api/v1/auth/oauth/github/callback",
            },
        )
        return (
            "OK — client id recognised"
            if r.status_code in (200, 302)
            else f"FAILED (HTTP {r.status_code})"
        )


async def run_checks(live: bool) -> list[Check]:
    settings = get_settings()
    checks: list[Check] = []
    for name, (rule, predicate) in FORMAT_RULES.items():
        value = _secret(settings, name)
        present = bool(value)
        checks.append(
            Check(
                variable=name.upper(),
                present=present,
                format_ok=predicate(value) if present else None,
                note=rule,
            )
        )
    by_name = {c.variable: c for c in checks}
    if live:
        tasks: dict[str, Awaitable[str]] = {}
        if by_name["DEEPSEEK_API_KEY"].present:
            tasks["DEEPSEEK_API_KEY"] = _live_deepseek(settings.deepseek_api_key.get_secret_value())
        if by_name["STRIPE_SECRET_KEY"].present:
            tasks["STRIPE_SECRET_KEY"] = _live_stripe(settings.stripe_secret_key.get_secret_value())
        if by_name["RESEND_API_KEY"].present:
            tasks["RESEND_API_KEY"] = _live_resend(
                settings.resend_api_key.get_secret_value(), settings.email_from
            )
        if by_name["GITHUB_CLIENT_ID"].present:
            tasks["GITHUB_CLIENT_ID"] = _live_github(settings.github_client_id)
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        for variable, result in zip(tasks, results, strict=True):
            by_name[variable].live = (
                f"ERROR ({type(result).__name__})" if isinstance(result, BaseException) else result
            )
    return checks


def main(live: bool) -> int:
    settings = get_settings()
    checks = asyncio.run(run_checks(live))
    out = sys.stdout
    out.write(
        f"Environment: {settings.app_env.value} · e-mail provider: {settings.email_provider.value}"
        f" · billing: {settings.billing_provider.value}\n"
    )
    out.write(f"OAuth providers enabled: {', '.join(settings.oauth_providers) or 'none'}\n")
    out.write(
        f"OAuth callbacks: {settings.api_public_url}/api/v1/auth/oauth/<provider>/callback\n\n"
    )
    out.write(f"{'VARIABLE':26} {'SET':5} {'FORMAT':8} LIVE CHECK\n")
    failed = False
    for c in checks:
        fmt = "-" if c.format_ok is None else ("ok" if c.format_ok else "INVALID")
        failed |= c.format_ok is False or c.live.startswith(("FAILED", "ERROR"))
        out.write(f"{c.variable:26} {'yes' if c.present else 'no':5} {fmt:8} {c.live}\n")
    return 1 if failed else 0
