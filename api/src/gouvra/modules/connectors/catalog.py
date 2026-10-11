"""The connector library: ready-made integrations whose operations become tools for agents.

A connector declares its credential fields, the hosts it may reach, and operations. Each
operation has a strict JSON Schema (what the model may send) and builds one HTTP request from
the arguments and the decrypted credentials — server-side, through the same guarded client as
HTTP tools (allow-listed hosts, public addresses only, bounded responses).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlsplit

from gouvra.modules.automations import signing

Credentials = dict[str, str]
Arguments = dict[str, Any]


@dataclass(frozen=True)
class Request:
    method: str
    url: str
    json_body: Any = None
    content: bytes | None = None
    headers: dict[str, str] = field(default_factory=dict)
    secret_headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CredentialField:
    key: str
    label: str
    help: str
    pattern: str
    placeholder: str = ""
    required: bool = True


@dataclass(frozen=True)
class Operation:
    key: str
    name: str
    description: str
    input_schema: dict[str, Any]
    build: Callable[[Credentials, Arguments], Request]
    # What the model reads back, from the provider's answer (status and body).
    result: Callable[[int, Any], Any] = lambda status, body: body
    writes: bool = True


@dataclass(frozen=True)
class Connector:
    key: str
    name: str
    description: str
    category: str
    docs_url: str
    fields: tuple[CredentialField, ...]
    operations: tuple[Operation, ...]
    hosts: Callable[[Credentials], list[str]]
    # A harmless call proving the credentials work (None: verified on first use).
    check: Callable[[Credentials], Request] | None = None
    check_result: Callable[[int, Any], str] | None = None

    def operation(self, key: str) -> Operation | None:
        return next((op for op in self.operations if op.key == key), None)


def _closed(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


def _host(url: str) -> list[str]:
    host = urlsplit(url).hostname
    return [host] if host else []


# ---------------------------------------------------------------- Slack


def _slack_post(credentials: Credentials, arguments: Arguments) -> Request:
    return Request("POST", credentials["webhook_url"], json_body={"text": arguments["text"]})


SLACK = Connector(
    key="slack",
    name="Slack",
    description="Post messages to a Slack channel through an incoming webhook.",
    category="messaging",
    docs_url="https://api.slack.com/messaging/webhooks",
    fields=(
        CredentialField(
            key="webhook_url",
            label="Incoming webhook URL",
            help="Create one in your Slack app under “Incoming Webhooks”; it posts to one channel.",
            pattern=r"^https://hooks\.slack\.com/services/[A-Za-z0-9/_-]+$",
            placeholder="https://hooks.slack.com/services/T000/B000/XXXX",
        ),
    ),
    operations=(
        Operation(
            key="post_message",
            name="Post a message",
            description="Post a message to the Slack channel of this connection. "
            "Use Slack mrkdwn for formatting.",
            input_schema=_closed(
                {"text": {"type": "string", "minLength": 1, "maxLength": 4000}}, ["text"]
            ),
            build=_slack_post,
            result=lambda status, body: {"posted": 200 <= status < 300},
        ),
    ),
    hosts=lambda credentials: ["hooks.slack.com"],
)


# ---------------------------------------------------------------- Discord


def _discord_post(credentials: Credentials, arguments: Arguments) -> Request:
    body: dict[str, Any] = {"content": arguments["content"], "allowed_mentions": {"parse": []}}
    if arguments.get("username"):
        body["username"] = arguments["username"]
    return Request("POST", credentials["webhook_url"] + "?wait=true", json_body=body)


DISCORD = Connector(
    key="discord",
    name="Discord",
    description="Post messages to a Discord channel through a channel webhook.",
    category="messaging",
    docs_url="https://support.discord.com/hc/en-us/articles/228383668",
    fields=(
        CredentialField(
            key="webhook_url",
            label="Channel webhook URL",
            help="Channel settings → Integrations → Webhooks → Copy webhook URL.",
            pattern=r"^https://(discord|discordapp)\.com/api/webhooks/\d+/[A-Za-z0-9_-]+$",
            placeholder="https://discord.com/api/webhooks/123/abc",
        ),
    ),
    operations=(
        Operation(
            key="post_message",
            name="Post a message",
            description="Post a message to the Discord channel of this connection "
            "(mentions are disabled).",
            input_schema=_closed(
                {
                    "content": {"type": "string", "minLength": 1, "maxLength": 2000},
                    "username": {"type": "string", "maxLength": 80},
                },
                ["content"],
            ),
            build=_discord_post,
            result=lambda status, body: {
                "posted": 200 <= status < 300,
                "message_id": body.get("id") if isinstance(body, dict) else None,
            },
        ),
    ),
    hosts=lambda credentials: ["discord.com", "discordapp.com"],
    check=lambda credentials: Request("GET", credentials["webhook_url"]),
    check_result=lambda status, body: (
        f"Posts to channel {body.get('channel_id')} as “{body.get('name')}”."
        if isinstance(body, dict)
        else "Webhook reachable."
    ),
)


# ---------------------------------------------------------------- GitHub

REPOSITORY = {
    "type": "string",
    "pattern": r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$",
    "description": "owner/name, e.g. octo-org/website",
}
GITHUB_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}


def _repo(arguments: Arguments) -> str:
    owner, name = str(arguments["repository"]).split("/", 1)
    return f"https://api.github.com/repos/{quote(owner, safe='')}/{quote(name, safe='')}"


def _github(credentials: Credentials) -> dict[str, str]:
    return {"Authorization": f"Bearer {credentials['token']}"}


def _issue_result(status: int, body: Any) -> Any:
    if isinstance(body, dict) and "number" in body:
        return {
            "number": body.get("number"),
            "url": body.get("html_url"),
            "title": body.get("title"),
            "state": body.get("state"),
            "body": (body.get("body") or "")[:4000] or None,
        }
    return {"status": status, "error": body}


GITHUB = Connector(
    key="github",
    name="GitHub",
    description="Create and read issues, and comment on them, in your repositories.",
    category="developer",
    docs_url="https://docs.github.com/en/rest/issues",
    fields=(
        CredentialField(
            key="token",
            label="Fine-grained personal access token",
            help="Give it access to the repositories it needs, with “Issues: read and write”.",
            pattern=r"^(github_pat_|ghp_)[A-Za-z0-9_]{20,255}$",
            placeholder="github_pat_…",
        ),
    ),
    operations=(
        Operation(
            key="create_issue",
            name="Create an issue",
            description="Open a new issue in a GitHub repository.",
            input_schema=_closed(
                {
                    "repository": REPOSITORY,
                    "title": {"type": "string", "minLength": 1, "maxLength": 256},
                    "body": {"type": "string", "maxLength": 20000},
                    "labels": {
                        "type": "array",
                        "items": {"type": "string", "maxLength": 50},
                        "maxItems": 10,
                    },
                },
                ["repository", "title"],
            ),
            build=lambda credentials, arguments: Request(
                "POST",
                _repo(arguments) + "/issues",
                json_body={
                    key: arguments[key] for key in ("title", "body", "labels") if key in arguments
                },
                headers=GITHUB_HEADERS,
                secret_headers=_github(credentials),
            ),
            result=_issue_result,
        ),
        Operation(
            key="comment_on_issue",
            name="Comment on an issue",
            description="Add a comment to an issue or pull request.",
            input_schema=_closed(
                {
                    "repository": REPOSITORY,
                    "number": {"type": "integer", "minimum": 1},
                    "body": {"type": "string", "minLength": 1, "maxLength": 20000},
                },
                ["repository", "number", "body"],
            ),
            build=lambda credentials, arguments: Request(
                "POST",
                f"{_repo(arguments)}/issues/{int(arguments['number'])}/comments",
                json_body={"body": arguments["body"]},
                headers=GITHUB_HEADERS,
                secret_headers=_github(credentials),
            ),
            result=lambda status, body: {
                "commented": 200 <= status < 300,
                "url": body.get("html_url") if isinstance(body, dict) else None,
            },
        ),
        Operation(
            key="get_issue",
            name="Read an issue",
            description="Read an issue's title, state and description.",
            input_schema=_closed(
                {"repository": REPOSITORY, "number": {"type": "integer", "minimum": 1}},
                ["repository", "number"],
            ),
            build=lambda credentials, arguments: Request(
                "GET",
                f"{_repo(arguments)}/issues/{int(arguments['number'])}",
                headers=GITHUB_HEADERS,
                secret_headers=_github(credentials),
            ),
            result=_issue_result,
            writes=False,
        ),
    ),
    hosts=lambda credentials: ["api.github.com"],
    check=lambda credentials: Request(
        "GET",
        "https://api.github.com/user",
        headers=GITHUB_HEADERS,
        secret_headers=_github(credentials),
    ),
    check_result=lambda status, body: (
        f"Signed in as {body.get('login')}." if isinstance(body, dict) else "Token accepted."
    ),
)


# ---------------------------------------------------------------- Outgoing webhook (signed)

EVENT = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


def _outgoing(credentials: Credentials, arguments: Arguments) -> Request:
    body = json.dumps(
        {
            "event": arguments["event"],
            "data": arguments.get("data", {}),
            "sent_at": int(time.time()),
        },
        separators=(",", ":"),
    ).encode()
    signature = {}
    if credentials.get("secret"):
        signature = {
            "Gouvra-Signature": signing.sign(credentials["secret"], body, int(time.time()))
        }
    return Request(
        "POST",
        credentials["url"],
        content=body,
        headers={"Content-Type": "application/json"},
        secret_headers=signature,
    )


WEBHOOK = Connector(
    key="webhook",
    name="Outgoing webhook",
    description="Send events to any HTTPS endpoint, signed like Gouvra's inbound webhooks.",
    category="custom",
    docs_url="https://github.com/octavebahoun/gouvra/blob/main/docs/automations.md",
    fields=(
        CredentialField(
            key="url",
            label="Endpoint URL",
            help="An HTTPS address on the public internet.",
            pattern=r"^https://[^\s/$.?#][^\s]*$",
            placeholder="https://example.com/hooks/gouvra",
        ),
        CredentialField(
            key="secret",
            label="Signing secret",
            help="Optional: requests then carry a Gouvra-Signature header to verify.",
            pattern=r"^[\x21-\x7e]{16,256}$",
            required=False,
        ),
    ),
    operations=(
        Operation(
            key="send_event",
            name="Send an event",
            description="Send a JSON event to the endpoint of this connection.",
            input_schema=_closed(
                {
                    "event": {"type": "string", "pattern": EVENT.pattern},
                    "data": {"type": "object"},
                },
                ["event"],
            ),
            build=_outgoing,
            result=lambda status, body: {"delivered": 200 <= status < 300, "status": status},
        ),
    ),
    hosts=lambda credentials: _host(credentials["url"]),
)


CONNECTORS: dict[str, Connector] = {c.key: c for c in (SLACK, DISCORD, GITHUB, WEBHOOK)}
