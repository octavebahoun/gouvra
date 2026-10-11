"""Workspace API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints

WorkspaceName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=2, max_length=80)
]
Slug = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=3,
        max_length=48,
        pattern=r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    ),
]
AssignableRole = Literal["admin", "member", "viewer"]


class WorkspaceCreateIn(BaseModel):
    name: WorkspaceName
    slug: Slug | None = None


class WorkspaceUpdateIn(BaseModel):
    name: WorkspaceName | None = None
    slug: Slug | None = None


class WorkspaceDeleteIn(BaseModel):
    confirm_name: str


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: str
    status: str
    is_demo: bool
    member_count: int
    created_at: datetime
    permissions: list[str]


class MemberOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    email: str
    role: str
    joined_at: datetime
    is_you: bool


class RoleUpdateIn(BaseModel):
    role: AssignableRole


class TransferOwnershipIn(BaseModel):
    user_id: uuid.UUID


class InvitationCreateIn(BaseModel):
    email: EmailStr
    role: AssignableRole = "member"


class InvitationOut(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    status: Literal["pending", "expired", "accepted", "revoked"]
    invited_by: str | None
    created_at: datetime
    expires_at: datetime
    last_sent_at: datetime | None


class InvitationPreviewOut(BaseModel):
    workspace_name: str
    inviter_name: str | None
    role: str
    email_hint: str
    expires_at: datetime
    status: Literal["pending", "expired", "accepted", "revoked"]


class OnboardingStep(BaseModel):
    # Responses always carry these fields: mark them required in the OpenAPI output schema.
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    key: str
    done: bool
    optional: bool = False


class OnboardingOut(BaseModel):
    steps: list[OnboardingStep]
    completed: int
    total: int
    dismissed: bool
