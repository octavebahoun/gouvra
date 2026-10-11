"""Shared test helpers: captured e-mails, account creation, workspace setup."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from httpx import AsyncClient

from gouvra.modules.notifications.senders import ConsoleEmailSender, OutgoingEmail, set_sender
from gouvra.modules.notifications.service import dispatch_due

TOKEN_RE = re.compile(r"#token=([A-Za-z0-9_\-]+)")
PASSWORD = "Correct-Horse-Battery-42"


class Outbox:
    """Routes e-mails to an in-memory sender; `flush()` runs the worker's dispatcher."""

    def __init__(self) -> None:
        self.sender = ConsoleEmailSender()
        set_sender(self.sender)

    async def flush(self) -> list[OutgoingEmail]:
        await dispatch_due()
        return list(self.sender.outbox)

    async def last_to(self, address: str) -> OutgoingEmail:
        messages = [m for m in await self.flush() if m.to.lower() == address.lower()]
        assert messages, f"no e-mail sent to {address}"
        return messages[-1]

    async def token_for(self, address: str) -> str:
        message = await self.last_to(address)
        match = TOKEN_RE.search(message.text)
        assert match, f"no token link in e-mail to {address}"
        return match.group(1)

    async def count_to(self, address: str) -> int:
        return len([m for m in await self.flush() if m.to.lower() == address.lower()])


@dataclass
class Account:
    client: AsyncClient
    email: str
    user_id: str


async def signup(
    client: AsyncClient, outbox: Outbox, email: str, name: str = "Test User", locale: str = "en"
) -> Account:
    """Register + follow the verification link (which signs the client in)."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": PASSWORD,
            "display_name": name,
            "locale": locale,
            "accept_terms": True,
        },
    )
    assert response.status_code == 202, response.text
    token = await outbox.token_for(email)
    verified = await client.post("/api/v1/auth/verify-email", json={"token": token})
    assert verified.status_code == 200, verified.text
    return Account(client=client, email=email, user_id=verified.json()["user"]["id"])


async def create_workspace(account: Account, name: str = "Acme") -> dict[str, Any]:
    response = await account.client.post("/api/v1/workspaces", json={"name": name})
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


async def add_member(
    owner: Account, workspace_id: str, member: Account, outbox: Outbox, role: str = "member"
) -> None:
    invited = await owner.client.post(
        f"/api/v1/workspaces/{workspace_id}/invitations", json={"email": member.email, "role": role}
    )
    assert invited.status_code == 201, invited.text
    token = await outbox.token_for(member.email)
    accepted = await member.client.post("/api/v1/invitations/accept", json={"token": token})
    assert accepted.status_code == 200, accepted.text
