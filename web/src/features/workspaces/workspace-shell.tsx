import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { useCurrentSession } from "@/lib/auth/session";
import { asRole, type WorkspaceSummary } from "@/lib/auth/types";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { AppShell } from "@/components/layout/app-shell";
import { UserMenu, WorkspaceSwitcher, type WorkspaceOption } from "@/components/layout/shell-parts";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { SuspendedBanner } from "./suspended-banner";

/** The part of the path after `/w/:slug/` ("settings/members"), kept when switching workspace. */
function sectionOf(pathname: string, slug: string): string {
  const prefix = `/w/${slug}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
}

/**
 * App shell bound to a workspace: navigation, workspace switcher (explicit context change: the
 * same section in the new workspace + a confirmation), account menu and workspace creation.
 */
export function WorkspaceShell({
  workspace,
  children,
}: {
  workspace: WorkspaceSummary;
  children: ReactNode;
}) {
  const { t } = useTranslation("shell");
  const session = useCurrentSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { signOut } = useSignOut();
  const [creating, setCreating] = useState(false);

  const options: WorkspaceOption[] = session.workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    role: asRole(w.role),
  }));
  const current = options.find((o) => o.id === workspace.id) ?? {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role: asRole(workspace.role),
  };

  const onSelect = (target: WorkspaceOption) => {
    if (target.id === workspace.id && pathname.startsWith(`/w/${workspace.slug}`)) return;
    const section = sectionOf(pathname, workspace.slug) || "overview";
    void navigate(`/w/${target.slug}/${section}`);
    toast.success(t("workspace.switched", { name: target.name }), {
      id: "workspace-switched",
      description: t("workspace.switchedDescription"),
    });
  };

  return (
    <>
      <AppShell
        basePath={`/w/${workspace.slug}`}
        workspaceSwitcher={(collapsed) => (
          <WorkspaceSwitcher
            current={current}
            workspaces={options}
            onSelect={onSelect}
            onCreate={() => setCreating(true)}
            collapsed={collapsed}
          />
        )}
        userMenu={(collapsed) => (
          <UserMenu user={session.user} collapsed={collapsed} onSignOut={() => signOut()} />
        )}
      >
        {pathname.startsWith(`/w/${workspace.slug}`) ? (
          <SuspendedBanner workspaceId={workspace.id} />
        ) : null}
        {children}
      </AppShell>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
