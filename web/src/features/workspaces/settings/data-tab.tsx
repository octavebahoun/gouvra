import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { can } from "@/lib/auth/permissions";
import { SettingsSection } from "@/components/layout/settings-section";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/states";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { exportUrl } from "@/features/billing/api";
import { useUpdateWorkspaceSettings, useWorkspaceSettings, type WorkspaceSettings } from "../api";
import { useCurrentWorkspace } from "../use-current-workspace";

const DAYS = [7, 30, 90, 180, 365, 730];
const AUDIT_DAYS = [90, 180, 365, 730, 1095];

/** Settings → Data: how long runs and audit entries are kept, and a configuration export. */
export function DataTab() {
  const { t } = useTranslation("billing");
  const { workspace, detail } = useCurrentWorkspace();
  const settings = useWorkspaceSettings(workspace.id);
  return (
    <div className="space-y-8">
      <SettingsSection
        id="retention"
        title={t("retention.title")}
        description={t("retention.description")}
      >
        <Card>
          {settings.isPending ? (
            <Skeleton className="m-5 h-24" />
          ) : settings.isError ? (
            <ErrorState compact error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <RetentionForm
              key={`${settings.data.retention_days}-${settings.data.audit_retention_days}`}
              workspaceId={workspace.id}
              settings={settings.data}
              editable={can(detail.data, "retention:manage")}
            />
          )}
        </Card>
      </SettingsSection>
      {can(detail.data, "exports:create") ? (
        <SettingsSection
          id="export"
          title={t("exports.title")}
          description={t("exports.description")}
        >
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <p className="max-w-xl text-[13px] text-muted">{t("exports.configurationHelp")}</p>
            <Button asChild variant="secondary" leftIcon={<Download aria-hidden />}>
              <a href={exportUrl(workspace.id, "configuration")} download>
                {t("exports.configuration")}
              </a>
            </Button>
          </Card>
        </SettingsSection>
      ) : null}
    </div>
  );
}

function RetentionForm({
  workspaceId,
  settings,
  editable,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  editable: boolean;
}) {
  const { t } = useTranslation(["billing", "common"]);
  const update = useUpdateWorkspaceSettings(workspaceId);
  const [keep, setKeep] = useState(String(settings.retention_days));
  const [audit, setAudit] = useState(String(settings.audit_retention_days));
  const options = (values: number[], max?: number) =>
    values
      .filter((value) => max === undefined || value <= max)
      .map((value) => ({ value: String(value), label: t("retention.days", { count: value }) }));
  const dirty =
    keep !== String(settings.retention_days) || audit !== String(settings.audit_retention_days);
  return (
    <div>
      <div className="grid gap-5 p-5 sm:grid-cols-2">
        {!editable ? (
          <Alert tone="info" title={t("retention.readOnly")} className="sm:col-span-2" />
        ) : null}
        {update.error ? (
          <div className="sm:col-span-2">
            <FormProblemAlert error={update.error} />
          </div>
        ) : null}
        <Field
          label={t("retention.runs")}
          hint={t("retention.runsHelp", { max: settings.retention_days_max })}
        >
          <Select
            value={keep}
            onValueChange={setKeep}
            disabled={!editable}
            options={options(DAYS, settings.retention_days_max)}
          />
        </Field>
        <Field label={t("retention.audit")} hint={t("retention.auditHelp")}>
          <Select
            value={audit}
            onValueChange={setAudit}
            disabled={!editable}
            options={options(AUDIT_DAYS)}
          />
        </Field>
      </div>
      {editable ? (
        <div className="flex justify-end border-t border-line bg-surface-2/40 px-5 py-3">
          <Button
            disabled={!dirty}
            loading={update.isPending}
            onClick={() =>
              update.mutate(
                { retention_days: Number(keep), audit_retention_days: Number(audit) },
                { onSuccess: () => toast.success(t("retention.saved")) },
              )
            }
          >
            {t("common:actions.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
