"""Outbound network guard (SSRF protection) for provider base URLs and HTTP tools."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

from gouvra.core.errors import ValidationFailed


class BlockedDestination(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _ip(address: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    ip = ipaddress.ip_address(address)
    if ip.version == 6 and ip.ipv4_mapped:  # ::ffff:127.0.0.1
        return ip.ipv4_mapped
    return ip


# Cloud metadata endpoints outside the link-local range (AWS over IPv6, Alibaba Cloud).
_METADATA = {ipaddress.ip_address("fd00:ec2::254"), ipaddress.ip_address("100.100.100.200")}


def _never_allowed(address: str) -> bool:
    """Addresses no setting opens: cloud metadata (link-local and the others), multicast,
    reserved and unspecified ones."""
    ip = _ip(address)
    return (
        ip in _METADATA
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_unspecified
        or (ip.is_reserved and not ip.is_loopback)  # ::1 sits in IPv6's reserved ::/8
    )


def _is_public(address: str) -> bool:
    ip = _ip(address)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"))  # carrier-grade NAT
    )


async def resolve_public(host: str, port: int, *, allow_private: bool = False) -> list[str]:
    """Resolve `host` and refuse private, loopback, link-local and metadata addresses.

    `allow_private` opens private and loopback addresses (a model served on the local network),
    never link-local ones: cloud metadata endpoints stay out of reach.
    """
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise BlockedDestination("dns_failure") from exc
    addresses = sorted({str(info[4][0]) for info in infos})
    if not addresses:
        raise BlockedDestination("dns_failure")
    if any(_never_allowed(a) for a in addresses):
        raise BlockedDestination("forbidden_address")
    if not allow_private and not all(_is_public(a) for a in addresses):
        raise BlockedDestination("private_address")
    return addresses


def validate_base_url(
    url: str, *, allow_private: bool = False, field: str = "base_url", setting: str | None = None
) -> str:
    """Static checks for a provider base URL: https (or http to an allowed private host).

    `setting` names the instance setting that allows private hosts, for the error messages.
    """
    parts = urlsplit(url.strip())
    problems: list[str] = []
    how = f" ({setting}=true)" if setting else ""
    private = f"Private and local addresses are not allowed on this instance{how}."
    if parts.scheme not in ("https", "http"):
        problems.append("Use an https:// URL.")
    elif parts.scheme == "http" and not allow_private:
        problems.append(
            "Use https:// — plain http is only allowed for private hosts, when the instance"
            f" allows them{how}."
        )
    if not parts.hostname:
        problems.append("The URL needs a host name.")
    if parts.username or parts.password:
        problems.append("Do not put credentials in the URL; use the API key field.")
    if parts.query or parts.fragment:
        problems.append("The base URL cannot contain a query string or fragment.")
    if parts.hostname:
        try:
            if _never_allowed(parts.hostname):
                problems.append("Link-local, multicast and reserved addresses are never allowed.")
            elif not allow_private and not _is_public(parts.hostname):
                problems.append(private)
        except ValueError:
            if not allow_private and (
                parts.hostname == "localhost"
                or parts.hostname.endswith((".local", ".internal", ".localhost"))
            ):
                problems.append(private)
    if problems:
        raise ValidationFailed(
            errors=[{"field": field, "code": "invalid_url", "message": p} for p in problems]
        )
    return url.strip().rstrip("/")
