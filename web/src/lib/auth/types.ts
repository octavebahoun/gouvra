import type { Schemas } from "@/lib/api/client";

export type Role = "owner" | "admin" | "member" | "viewer";
export type AssignableRole = Exclude<Role, "owner">;

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const ASSIGNABLE_ROLES: AssignableRole[] = ["admin", "member", "viewer"];

/** UI helper only — the server enforces every permission on every request. */
export function hasRole(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** The API types roles as plain strings; anything unexpected is treated as the least privilege. */
export function asRole(value: string): Role {
  return value === "owner" || value === "admin" || value === "member" ? value : "viewer";
}

export type Session = Schemas["SessionOut"];
export type SessionUser = Schemas["UserOut"];
export type WorkspaceSummary = Schemas["WorkspaceSummary"];
export type Meta = Schemas["MetaOut"];
