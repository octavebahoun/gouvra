import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useParams } from "react-router";
import { useCurrentSession } from "@/lib/auth/session";
import { rememberLastWorkspace } from "@/lib/auth/storage";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Logo } from "@/components/brand/logo";
import { AnimatedOutlet } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { NotFoundState } from "@/components/ui/states";
import { useWorkspaceFromRoute } from "./use-current-workspace";
import { WorkspaceShell } from "./workspace-shell";

/**
 * `/w/:slug/*`: resolves the workspace from the session; non-members get a plain 404.
 * When the workspace's URL changes (renamed here or by another admin), the page follows it.
 */
export function WorkspaceLayout() {
  const session = useCurrentSession();
  const workspace = useWorkspaceFromRoute();
  const { slug: routeSlug = "" } = useParams();
  const { pathname, search } = useLocation();
  const userId = session.user.id;
  const slug = workspace?.slug;

  const [lastId, setLastId] = useState(workspace?.id ?? null);
  if (workspace && workspace.id !== lastId) setLastId(workspace.id);

  useEffect(() => {
    if (slug) rememberLastWorkspace(userId, slug);
  }, [userId, slug]);

  if (!workspace) {
    const renamed = lastId ? session.workspaces.find((w) => w.id === lastId) : undefined;
    if (renamed) {
      const rest = pathname.slice(`/w/${routeSlug}`.length);
      return <Navigate to={`/w/${renamed.slug}${rest}${search}`} replace />;
    }
    return <WorkspaceNotFound />;
  }
  return (
    <WorkspaceShell workspace={workspace}>
      <AnimatedOutlet />
    </WorkspaceShell>
  );
}

/** Same answer whether the workspace doesn't exist or isn't shared with you (no leak). */
function WorkspaceNotFound() {
  const { t } = useTranslation("shell");
  useDocumentTitle(t("workspace.notFoundTitle"));
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex h-16 items-center px-4 sm:px-6">
        <Link to="/app" className="rounded-field">
          <Logo />
        </Link>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="flex flex-1 items-center justify-center outline-none"
      >
        <NotFoundState
          headingLevel="h1"
          action={
            <Button asChild variant="secondary">
              <Link to="/app">{t("workspace.backToWorkspaces")}</Link>
            </Button>
          }
        />
      </main>
    </div>
  );
}
