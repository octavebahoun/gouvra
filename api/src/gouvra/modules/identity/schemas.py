"""Identity API contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, EmailStr, Field, StringConstraints

Locale = Literal["en", "fr"]
Theme = Literal["light", "dark", "system"]
DisplayName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
Password = Annotated[str, Field(min_length=1, max_length=256)]
Token = Annotated[str, StringConstraints(strip_whitespace=True, min_length=16, max_length=128)]


class RegisterIn(BaseModel):
    email: EmailStr
    password: Password
    display_name: DisplayName
    locale: Locale = "en"
    accept_terms: Literal[True] = Field(description="The user accepted the terms of use.")


class LoginIn(BaseModel):
    email: EmailStr
    password: Password


class EmailIn(BaseModel):
    email: EmailStr


class TokenIn(BaseModel):
    token: Token


class ResetPasswordIn(BaseModel):
    token: Token
    password: Password


class ChangePasswordIn(BaseModel):
    current_password: Password | None = None
    new_password: Password


class ProfileUpdateIn(BaseModel):
    display_name: DisplayName | None = None
    locale: Locale | None = None
    theme: Theme | None = None


class EmailChangeIn(BaseModel):
    new_email: EmailStr
    password: Password | None = None


class Accepted(BaseModel):
    status: Literal["accepted"] = "accepted"
    message: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    email_verified: bool
    locale: str
    theme: str
    is_superadmin: bool
    is_demo: bool
    has_password: bool
    oauth_providers: list[str]
    created_at: datetime


class WorkspaceSummary(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: str
    is_demo: bool


class SessionOut(BaseModel):
    user: UserOut
    workspaces: list[WorkspaceSummary]


class SessionItem(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None
    auth_method: str
    current: bool
