/** Workspace permissions returned by the API (`WorkspaceOut.permissions`). */
export type Permission =
  | "workspace:read"
  | "workspace:update"
  | "workspace:delete"
  | "members:read"
  | "members:manage"
  | "invitations:manage"
  | "ownership:transfer"
  | "audit:read"
  | "api_keys:manage"
  | "providers:read"
  | "providers:manage"
  | "agents:read"
  | "agents:write"
  | "tools:read"
  | "tools:write"
  | "executions:read"
  | "executions:launch"
  | "executions:cancel"
  | "usage:read";

/**
 * UI helper to show, hide or disable actions with an explanation. It never replaces the server
 * check: every request is authorised again by the API.
 */
export function can(
  workspace: { permissions: readonly string[] } | undefined,
  permission: Permission,
): boolean {
  return workspace?.permissions.includes(permission) ?? false;
}
