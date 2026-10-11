import { useParams } from "react-router";
import { useCurrentSession } from "@/lib/auth/session";
import { asRole, type Role, type WorkspaceSummary } from "@/lib/auth/types";
import { useWorkspace } from "./api";

/** The workspace of the current `/w/:slug` route, resolved from the session (never guessed). */
export function useWorkspaceFromRoute(): WorkspaceSummary | undefined {
  const { slug } = useParams();
  const session = useCurrentSession();
  return session.workspaces.find((w) => w.slug === slug);
}

/**
 * Under the workspace layout: its summary (from the session) and its details (permissions,
 * member count) from `GET /workspaces/{id}`.
 */
export function useCurrentWorkspace(): {
  workspace: WorkspaceSummary;
  role: Role;
  basePath: string;
  detail: ReturnType<typeof useWorkspace>;
} {
  const workspace = useWorkspaceFromRoute();
  const detail = useWorkspace(workspace?.id);
  if (!workspace) throw new Error("useCurrentWorkspace() must be rendered under /w/:slug");
  return { workspace, role: asRole(workspace.role), basePath: `/w/${workspace.slug}`, detail };
}
