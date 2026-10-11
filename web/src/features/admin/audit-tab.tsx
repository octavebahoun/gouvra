import { useTranslation } from "react-i18next";
import { useFormatters } from "@/lib/format";
import { Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { auditActionLabel } from "@/features/workspaces/settings/audit-actions";
import { useAdminAudit, type AdminAuditEvent } from "./api";
import { LoadMore } from "./load-more";

/** The instance-wide audit log: every workspace's events plus the administrators' own. */
export function AuditTab() {
  const { t } = useTranslation("admin");
  const audit = useAdminAudit();
  if (audit.isPending) return <Skeleton className="h-64 rounded-card" />;
  if (audit.isError) {
    return (
      <Card>
        <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
      </Card>
    );
  }
  const events = audit.data.pages.flatMap((page) => page.data);
  if (!events.length) {
    return (
      <Card>
        <EmptyState compact title={t("audit.empty")} />
      </Card>
    );
  }
  return (
    <Card>
      <ul className="divide-y divide-line">
        {events.map((event) => (
          <AuditRow key={event.id} event={event} />
        ))}
      </ul>
      <LoadMore
        hasNextPage={audit.hasNextPage}
        isFetchingNextPage={audit.isFetchingNextPage}
        fetchNextPage={audit.fetchNextPage}
      />
    </Card>
  );
}

function AuditRow({ event }: { event: AdminAuditEvent }) {
  const { t } = useTranslation("settings");
  const { t: ta } = useTranslation("admin");
  const { dateTime } = useFormatters();
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
      <span className="w-40 shrink-0 text-muted tabular-nums">{dateTime(event.created_at)}</span>
      <span className="min-w-0 flex-1 basis-60">
        <span className="font-medium text-ink">{auditActionLabel(event.action, t)}</span>{" "}
        <code className="text-[12px] text-muted">{event.action}</code>
      </span>
      <span className="truncate text-muted">
        {event.actor_label ?? ta("audit.system")}
        {event.ip_address ? ` · ${event.ip_address}` : ""}
      </span>
    </li>
  );
}
