import { useTranslation } from "react-i18next";
import { useCurrentSession } from "@/lib/auth/session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { AnimatedOutlet } from "@/components/layout/app-shell";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { TabLinks } from "@/components/ui/tabs";
import { NotFoundState } from "@/components/ui/states";
import { PersonalShell } from "@/features/account/account-route";
import { OverviewCards } from "./overview-cards";

/**
 * `/admin` — the instance seen by its super-admins: totals, then workspaces, users and the
 * instance-wide audit log. Anyone else gets the same "not found" as the API answers.
 */
export function AdminRoute() {
  const session = useCurrentSession();
  return (
    <PersonalShell>
      {session.user.is_superadmin ? <AdminPage /> : <NotFoundState headingLevel="h1" />}
    </PersonalShell>
  );
}

function AdminPage() {
  const { t } = useTranslation("admin");
  useDocumentTitle(t("title"));
  return (
    <PageContainer wide>
      <PageHeader title={t("title")} description={t("description")} />
      <OverviewCards />
      <div className="mt-8">
        <TabLinks
          label={t("tabs.label")}
          items={[
            { to: "/admin/workspaces", label: t("tabs.workspaces") },
            { to: "/admin/users", label: t("tabs.users") },
            { to: "/admin/audit", label: t("tabs.audit") },
          ]}
        />
      </div>
      <div className="pt-6">
        <AnimatedOutlet depth={2} />
      </div>
    </PageContainer>
  );
}
