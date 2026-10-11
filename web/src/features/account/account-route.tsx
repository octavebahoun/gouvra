import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useCurrentSession } from "@/lib/auth/session";
import { readLastWorkspace } from "@/lib/auth/storage";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { Logo } from "@/components/brand/logo";
import { LanguageMenu } from "@/components/layout/language-menu";
import { ConnectionBanner, ThemeToggle, UserMenu } from "@/components/layout/shell-parts";
import { Button } from "@/components/ui/button";
import { WorkspaceShell } from "@/features/workspaces/workspace-shell";
import { AccountPage } from "./account-page";

/**
 * `/account` lives in the app shell of the last workspace used (so navigation stays one click
 * away). Someone without any workspace gets a simple top bar instead.
 */
export function AccountRoute() {
  return (
    <PersonalShell>
      <AccountPage />
    </PersonalShell>
  );
}

/** The shell of pages that belong to a person rather than a workspace (profile, instance admin). */
export function PersonalShell({ children }: { children: ReactNode }) {
  const session = useCurrentSession();
  const last = readLastWorkspace(session.user.id);
  const workspace = session.workspaces.find((w) => w.slug === last) ?? session.workspaces[0];
  if (workspace) return <WorkspaceShell workspace={workspace}>{children}</WorkspaceShell>;
  return <PlainShell>{children}</PlainShell>;
}

function PlainShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation("shell");
  const session = useCurrentSession();
  const { signOut } = useSignOut();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <ConnectionBanner />
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link to="/app" className="rounded-field">
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <Button asChild size="sm" variant="secondary" leftIcon={<Plus aria-hidden />}>
              <Link to="/onboarding">{t("createWorkspace.title")}</Link>
            </Button>
            <LanguageMenu />
            <ThemeToggle />
            <UserMenu
              user={session.user}
              collapsed
              placement="bottom"
              className="size-10 w-10"
              onSignOut={() => signOut()}
            />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
    </div>
  );
}
