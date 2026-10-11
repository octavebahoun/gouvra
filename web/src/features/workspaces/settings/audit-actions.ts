import type { TFunction } from "i18next";

const KNOWN_ACTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.deleted",
  "workspace.ownership_transferred",
  "workspace.settings_updated",
  "member.role_changed",
  "member.removed",
  "member.left",
  "invitation.created",
  "invitation.resent",
  "invitation.revoked",
  "invitation.accepted",
  "api_key.created",
  "api_key.revoked",
  "provider.created",
  "provider.updated",
  "provider.deleted",
  "provider.tested",
  "agent.created",
  "agent.updated",
  "agent.duplicated",
  "agent.archived",
  "agent.restored",
  "agent.deleted",
  "agent.version_restored",
  "tool.created",
  "tool.updated",
  "tool.archived",
  "execution.exported",
] as const;
type KnownAction = (typeof KNOWN_ACTIONS)[number];
const isKnown = (action: string): action is KnownAction =>
  (KNOWN_ACTIONS as readonly string[]).includes(action);

/** Readable label for an audit action; codes added later fall back to the raw code. */
export function auditActionLabel(action: string, t: TFunction<"settings">): string {
  return isKnown(action) ? t(`audit.actions.${action}`) : action;
}
