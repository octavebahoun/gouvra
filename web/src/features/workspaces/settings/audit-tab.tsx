import { ArrowRight, History, KeyRound, ScrollText } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { IdChip } from "@/components/ui/copy-button";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuditEvents, type AuditEvent } from "../api";
import { auditActionLabel } from "./audit-actions";
import { useCurrentWorkspace } from "../use-current-workspace";

const FILTERS = [
  "all",
  "workspace",
  "member",
  "invitation",
  "api_key",
  "provider",
  "agent",
  "tool",
  "execution",
] as const;
type Filter = (typeof FILTERS)[number];

/** Settings › Audit log (admins): who did what, newest first, filterable, paginated. */
export function AuditTab() {
  const { t } = useTranslation("settings");
  const { workspace, detail } = useCurrentWorkspace();
  const allowed = can(detail.data, "audit:read");
  const [filter, setFilter] = useState<Filter>("all");
  const events = useAuditEvents(workspace.id, filter === "all" ? null : `${filter}.`, allowed);

  if (detail.isPending) return <AuditSkeleton />;
  if (!allowed) {
    return (
      <Card>
        <EmptyState
          illustration="locked"
          title={t("audit.noPermissionTitle")}
          description={t("audit.noPermissionBody")}
        />
      </Card>
    );
  }

  const items = events.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t("audit.title")}
        description={t("audit.description")}
        actions={
          <div className="flex items-center gap-2">
            <span id="audit-filter-label" className="hidden text-[13px] text-muted sm:inline">
              {t("audit.filterLabel")}
            </span>
            <Select
              value={filter}
              onValueChange={(value) => setFilter(value as Filter)}
              aria-labelledby="audit-filter-label"
              className="w-44"
              options={FILTERS.map((value) => ({ value, label: t(`audit.filters.${value}`) }))}
            />
          </div>
        }
        className="flex-col items-stretch gap-3 sm:flex-row sm:items-start"
      />
      {events.isPending ? (
        <AuditSkeleton bare />
      ) : events.isError ? (
        <ErrorState
          compact
          title={t("audit.loadError")}
          error={events.error}
          onRetry={() => void events.refetch()}
        />
      ) : items.length === 0 ? (
        filter === "all" ? (
          <EmptyState compact title={t("audit.emptyTitle")} description={t("audit.emptyBody")} />
        ) : (
          <EmptyState
            compact
            title={t("audit.emptyFilteredTitle")}
            description={t("audit.emptyFilteredBody")}
            action={
              <Button variant="secondary" size="sm" onClick={() => setFilter("all")}>
                {t("audit.showAll")}
              </Button>
            }
          />
        )
      ) : (
        <>
          <motion.ol
            key={filter}
            variants={staggerChildren(0.03)}
            initial="hidden"
            animate="visible"
            aria-label={t("audit.title")}
            className="divide-y divide-line"
          >
            <AnimatePresence initial={false}>
              {items.map((event) => (
                <motion.li key={event.id} variants={listItem} layout="position">
                  <AuditRow event={event} />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ol>
          <div className="flex justify-center border-t border-line bg-surface-2/40 px-5 py-3">
            {events.hasNextPage ? (
              <Button
                variant="secondary"
                size="sm"
                loading={events.isFetchingNextPage}
                leftIcon={<History aria-hidden />}
                onClick={() => void events.fetchNextPage()}
              >
                {t("audit.loadMore")}
              </Button>
            ) : (
              <p className="text-[13px] text-muted">{t("audit.end")}</p>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/** "from → to" for role changes, otherwise compact key: value pairs. */
function DataSummary({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, value]) => value !== null && value !== "");
  if (entries.length === 0) return null;
  if ("from" in data && "to" in data) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-xs text-ink">
        {String(data.from)}
        <ArrowRight aria-label="→" className="size-3 text-muted" />
        {String(data.to)}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {entries.slice(0, 4).map(([key, value]) => (
        <span
          key={key}
          className="max-w-full truncate rounded-field bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted"
          title={`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`}
        >
          {key}:{" "}
          <span className="text-ink">
            {typeof value === "string" ? value : JSON.stringify(value)}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Actors are e-mail addresses: "ada.lovelace@acme.com" → "ada lovelace" for initials. */
function avatarName(actor: string): string {
  const local = actor.includes("@") ? (actor.split("@")[0] ?? actor) : actor;
  return local.replace(/[._+-]+/g, " ").trim() || actor;
}

function AuditRow({ event }: { event: AuditEvent }) {
  const { t } = useTranslation("settings");
  const { relative, dateTime } = useFormatters();
  const isKey = Boolean(event.actor_api_key_id);
  const actor = event.actor ?? t("audit.system");
  return (
    <div className="flex gap-3 px-5 py-3.5">
      {isKey ? (
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <KeyRound aria-hidden className="size-3.5" />
        </span>
      ) : event.actor ? (
        <Avatar name={avatarName(event.actor)} size="sm" />
      ) : (
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <ScrollText aria-hidden className="size-3.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <p className="min-w-0 text-sm">
            <span className="font-medium text-ink">{auditActionLabel(event.action, t)}</span>{" "}
            <span className="text-muted">{t("audit.by", { actor })}</span>
          </p>
          <time
            dateTime={event.created_at}
            title={dateTime(event.created_at)}
            className="shrink-0 text-xs text-muted tabular-nums"
          >
            {relative(event.created_at)}
          </time>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
          <code className="font-mono">{event.action}</code>
          {event.target_type ? (
            <span className="inline-flex items-center gap-1">
              {t("audit.target")}: <span className="font-mono text-ink">{event.target_type}</span>
            </span>
          ) : null}
          <DataSummary data={event.data} />
          {event.ip_address ? (
            <span title={t("audit.ip")} className="font-mono">
              {event.ip_address}
            </span>
          ) : null}
          {event.request_id ? (
            <IdChip id={event.request_id} label={t("audit.requestId")} from="end" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AuditSkeleton({ bare = false }: { bare?: boolean }) {
  const { t } = useTranslation();
  const rows = (
    <div className="divide-y divide-line" aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex gap-3 px-5 py-4">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-56 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
  return bare ? rows : <Card>{rows}</Card>;
}
