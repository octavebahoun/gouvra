import { motion } from "motion/react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import {
  useAdminWorkspaces,
  useInstanceOverview,
  useUpdateAdminWorkspace,
  type AdminWorkspace,
} from "./api";
import { SearchField } from "./search-field";

const GRANTABLE = ["free", "team", "business"] as const;

/** Every workspace of the instance: who owns it, its plan and activity; suspend or grant a plan. */
export function WorkspacesTab() {
  const { t } = useTranslation("admin");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const workspaces = useAdminWorkspaces(query);
  const billing = useInstanceOverview().data?.billing_provider;
  const [suspending, setSuspending] = useState<AdminWorkspace | null>(null);
  const update = useUpdateAdminWorkspace();

  function change(
    workspace: AdminWorkspace,
    body: { status?: "active" | "suspended"; plan?: (typeof GRANTABLE)[number] },
  ) {
    update.mutate(
      { id: workspace.id, ...body },
      {
        onSuccess: () => {
          toast.success(
            body.plan
              ? t("workspaces.planGranted", { name: workspace.name, plan: t(`plans.${body.plan}`) })
              : t(body.status === "suspended" ? "workspaces.suspended" : "workspaces.restored", {
                  name: workspace.name,
                }),
          );
          setSuspending(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <div>
      <div className="mb-4">
        <SearchField value={search} onChange={setSearch} label={t("workspaces.search")} />
      </div>
      {workspaces.isPending ? (
        <Skeleton className="h-64 rounded-card" />
      ) : workspaces.isError ? (
        <Card>
          <ErrorState error={workspaces.error} onRetry={() => void workspaces.refetch()} />
        </Card>
      ) : workspaces.data.length === 0 ? (
        <Card>
          <EmptyState compact title={t("workspaces.empty")} />
        </Card>
      ) : (
        <Card>
          <motion.ul
            variants={staggerChildren(0.03)}
            initial="hidden"
            animate="visible"
            className={cn("divide-y divide-line", workspaces.isPlaceholderData && "opacity-60")}
          >
            {workspaces.data.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                canGrant={billing !== undefined && billing !== "none"}
                onPlan={(plan) => change(workspace, { plan })}
                onSuspend={() => setSuspending(workspace)}
                onRestore={() => change(workspace, { status: "active" })}
              />
            ))}
          </motion.ul>
        </Card>
      )}
      <ConfirmDialog
        open={suspending !== null}
        onOpenChange={(open) => !open && setSuspending(null)}
        title={t("workspaces.suspendTitle", { name: suspending?.name ?? "" })}
        description={t("workspaces.suspendBody")}
        confirmLabel={t("workspaces.suspend")}
        pending={update.isPending}
        onConfirm={() => {
          if (suspending) change(suspending, { status: "suspended" });
        }}
      />
    </div>
  );
}

function WorkspaceRow({
  workspace,
  canGrant,
  onPlan,
  onSuspend,
  onRestore,
}: {
  workspace: AdminWorkspace;
  canGrant: boolean;
  onPlan: (plan: (typeof GRANTABLE)[number]) => void;
  onSuspend: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("admin");
  const { date } = useFormatters();
  const suspended = workspace.status === "suspended";
  const spend = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    Number(workspace.spend_30d),
  );
  return (
    <motion.li
      variants={listItem}
      className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4"
    >
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-ink">{workspace.name}</span>
          {suspended ? <Badge tone="danger">{t("workspaces.statusSuspended")}</Badge> : null}
          {workspace.is_demo ? <Badge tone="outline">{t("workspaces.demo")}</Badge> : null}
        </div>
        <p className="truncate text-[12px] text-muted">
          {workspace.owner_email ?? "—"} · {t("workspaces.members", { count: workspace.members })} ·{" "}
          {t("workspaces.created", { date: date(workspace.created_at) })}
        </p>
      </div>
      <div className="text-[13px] text-muted tabular-nums">
        {t("workspaces.activity", { count: workspace.executions_30d, spend })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canGrant ? (
          <Select
            aria-label={t("workspaces.planFor", { name: workspace.name })}
            value={GRANTABLE.includes(workspace.plan as never) ? workspace.plan : "free"}
            onValueChange={(value) => onPlan(value as (typeof GRANTABLE)[number])}
            className="w-36"
            options={GRANTABLE.map((plan) => ({ value: plan, label: t(`plans.${plan}`) }))}
          />
        ) : (
          <Badge tone="brand">
            {t(`plans.${workspace.plan as "free"}`, { defaultValue: workspace.plan })}
          </Badge>
        )}
        {suspended ? (
          <Button size="sm" variant="secondary" onClick={onRestore}>
            {t("workspaces.restore")}
          </Button>
        ) : (
          <Button size="sm" variant="danger-ghost" onClick={onSuspend}>
            {t("workspaces.suspend")}
          </Button>
        )}
      </div>
    </motion.li>
  );
}
