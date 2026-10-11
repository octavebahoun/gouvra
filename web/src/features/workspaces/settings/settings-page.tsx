import { useTranslation } from "react-i18next";
import { can } from "@/lib/auth/permissions";
import { useDocumentTitle } from "@/lib/use-document-title";
import { AnimatedOutlet } from "@/components/layout/app-shell";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { TabLinks } from "@/components/ui/tabs";
import { useApiKeys, useMembers } from "../api";
import { useCurrentWorkspace } from "../use-current-workspace";

/** Screen Q — workspace settings, one URL per section (general, members, API keys, audit). */
export function SettingsPage() {
  const { t } = useTranslation("settings");
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const members = useMembers(workspace.id);
  const canManageKeys = can(detail.data, "api_keys:manage");
  const keys = useApiKeys(workspace.id, canManageKeys);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const activeKeys = keys.data?.filter((key) => !key.revoked_at).length;
  return (
    <PageContainer>
      <PageHeader
        title={t("title")}
        description={t("description", { workspace: workspace.name })}
      />
      <TabLinks
        label={t("tabs.label")}
        items={[
          { to: `${basePath}/settings/general`, label: t("tabs.general") },
          {
            to: `${basePath}/settings/members`,
            label: t("tabs.members"),
            count: members.data?.length,
          },
          {
            to: `${basePath}/settings/api-keys`,
            label: t("tabs.apiKeys"),
            count: canManageKeys ? activeKeys : undefined,
          },
          { to: `${basePath}/settings/audit`, label: t("tabs.audit") },
        ]}
      />
      <div className="pt-6">
        <AnimatedOutlet depth={4} />
      </div>
    </PageContainer>
  );
}
