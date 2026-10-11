import { Ban, Bot, CircleAlert, Download, RotateCw, Wifi, WifiOff } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { API_BASE } from "@/lib/api/http";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import {
  duration as motionDuration,
  ease,
  fadeUp,
  staggerChildren,
} from "@/components/motion/presets";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { prettyJson } from "@/lib/json";
import { IdChip } from "@/components/ui/copy-button";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { useAnnounce } from "@/components/ui/live-region";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { ErrorState, NotFoundState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  isTerminalStatus,
  useCancelExecution,
  useExecution,
  useRetryExecution,
  type Execution,
} from "./api";
import { CostValue } from "./cost";
import { useDiagnosis } from "./diagnosis";
import { useTriggerLabel } from "./labels";
import { formatDuration, formatTokens } from "./format";
import { useLiveTrace, type StepStream } from "./live";
import { Timeline } from "./timeline";

/** Ticks every animation frame (≈ 10 Hz is enough for a seconds counter) while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Screen M — one execution, live: state, counters, trace, input and output, diagnosis. */
export function ExecutionPage() {
  const { executionId = "" } = useParams();
  const { t } = useTranslation(["executions", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const execution = useExecution(executionId);
  const trace = useLiveTrace(executionId, execution.data?.status);
  const announce = useAnnounce();
  const previous = useRef<string | undefined>(undefined);
  useDocumentTitle(
    execution.data
      ? `${t(`common:status.${execution.data.status}`)} · ${execution.data.agent?.name ?? t("detail.titleFallback")} — ${workspace.name}`
      : null,
  );

  // Screen readers hear state changes, not every token.
  useEffect(() => {
    const status = execution.data?.status;
    if (status && previous.current && previous.current !== status) {
      announce(t(`common:status.${status}`));
    }
    previous.current = status;
  }, [execution.data?.status, announce, t]);

  if (execution.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-[28rem]" />
        <Skeleton className="mb-6 h-20 rounded-card" />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Skeleton className="h-[28rem] rounded-card" />
          <Skeleton className="h-[28rem] rounded-card" />
        </div>
      </PageContainer>
    );
  }
  if (execution.isError) {
    return isApiError(execution.error) && execution.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("detail.notFoundTitle")}
        description={t("detail.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={execution.error} onRetry={() => void execution.refetch()} />
        </Card>
      </PageContainer>
    );
  }

  const data = execution.data;
  return (
    <PageContainer wide>
      <Header
        execution={data}
        basePath={basePath}
        workspaceId={workspace.id}
        permissions={detail.data}
      />
      <Metrics execution={data} />
      <AnimatePresence>
        {data.error && data.status !== "succeeded" ? <Diagnosis execution={data} /> : null}
      </AnimatePresence>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        {/* On narrow screens the answer comes first; the trace follows. */}
        <Card className="order-2 overflow-hidden lg:order-1">
          <CardHeader
            title={t("timeline.title")}
            description={t("timeline.description")}
            actions={
              isTerminalStatus(data.status) ? null : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                    trace.live ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted",
                  )}
                >
                  {trace.live ? (
                    <Wifi aria-hidden className="size-3.5" />
                  ) : (
                    <WifiOff aria-hidden className="size-3.5" />
                  )}
                  {t("live")}
                </span>
              )
            }
          />
          <div className="p-5">
            {trace.loading ? (
              <div className="space-y-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : trace.error ? (
              <ErrorState compact error={null} />
            ) : trace.events.length === 0 ? (
              <p className="py-8 text-center text-[13px] text-muted">
                {data.status === "queued" ? t("timeline.waitingWorker") : t("timeline.empty")}
              </p>
            ) : (
              <Timeline events={trace.events} streams={trace.streams} live={trace.live} />
            )}
          </div>
        </Card>
        <div className="order-1 flex min-w-0 flex-col gap-6 lg:order-2">
          <InputCard execution={data} />
          <OutputCard execution={data} streams={trace.streams} />
        </div>
      </div>
    </PageContainer>
  );
}

function Header({
  execution,
  basePath,
  workspaceId,
  permissions,
}: {
  execution: Execution;
  basePath: string;
  workspaceId: string;
  permissions: { permissions: readonly string[] } | undefined;
}) {
  const { t } = useTranslation(["executions", "common"]);
  const navigate = useNavigate();
  const { relative, dateTime } = useFormatters();
  const triggerLabel = useTriggerLabel();
  const cancel = useCancelExecution(workspaceId);
  const retry = useRetryExecution(workspaceId);
  const terminal = isTerminalStatus(execution.status);
  const canCancel = can(permissions, "executions:cancel") && !terminal;
  const canRetry = can(permissions, "executions:launch") && terminal && execution.agent !== null;
  const canExport = can(permissions, "exports:create");
  const cancelling = Boolean(execution.cancel_requested_at) && !terminal;

  return (
    <PageHeader
      breadcrumbs={[
        { label: t("detail.breadcrumb"), to: `${basePath}/executions` },
        { label: execution.id.slice(0, 8) },
      ]}
      title={
        <span className="inline-flex items-center gap-2.5">
          <Bot aria-hidden className="size-5 text-muted" />
          {execution.agent ? (
            <Link
              to={`${basePath}/agents/${execution.agent.id}`}
              className="hover:text-brand-text hover:underline"
            >
              {execution.agent.name}
            </Link>
          ) : (
            t("deletedAgent")
          )}
        </span>
      }
      meta={
        <>
          <motion.span layout>
            <StatusBadge status={execution.status} />
          </motion.span>
          {execution.agent?.version ? (
            <Badge tone="outline">
              {t("detail.versionChip", { version: execution.agent.version })}
            </Badge>
          ) : null}
          <IdChip id={execution.id} label={t("detail.copyId")} />
        </>
      }
      description={
        <span title={dateTime(execution.created_at)}>
          {execution.triggered_by
            ? t("detail.triggeredBy", {
                trigger: triggerLabel(execution.trigger),
                who: execution.triggered_by,
              })
            : t("detail.triggeredAuto", { trigger: triggerLabel(execution.trigger) })}{" "}
          · {relative(execution.created_at)}
          {execution.attempt > 1 ? ` · ${t("detail.attempt", { attempt: execution.attempt })}` : ""}
        </span>
      }
      actions={
        <>
          {canCancel ? (
            <Button
              variant="secondary"
              leftIcon={<Ban aria-hidden />}
              loading={cancel.isPending}
              disabled={cancelling}
              onClick={() =>
                cancel.mutate(execution.id, {
                  onSuccess: (saved) =>
                    toast.success(
                      saved.status === "cancelled"
                        ? t("detail.cancelled")
                        : t("detail.cancelRequested"),
                    ),
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {cancelling ? t("detail.cancelling") : t("detail.cancel")}
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              variant={execution.status === "succeeded" ? "secondary" : "primary"}
              leftIcon={<RotateCw aria-hidden />}
              loading={retry.isPending}
              onClick={() =>
                retry.mutate(execution.id, {
                  onSuccess: (next) => {
                    toast.success(t("detail.retried"));
                    void navigate(`${basePath}/executions/${next.id}`);
                  },
                  onError: (error) => toast.error(error.message),
                })
              }
            >
              {t("detail.retry")}
            </Button>
          ) : null}
          {canExport ? (
            <Button asChild variant="tertiary" leftIcon={<Download aria-hidden />}>
              <a href={`${API_BASE}/executions/${execution.id}/export`} download>
                {t("detail.export")}
              </a>
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function Tile({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <motion.div
      variants={fadeUp}
      className="min-w-0 rounded-card border border-line bg-surface px-4 py-3 shadow-sm"
    >
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-ink tabular-nums">{children}</dd>
      {sub ? <dd className="mt-0.5 line-clamp-2 text-xs text-muted">{sub}</dd> : null}
    </motion.div>
  );
}

function Metrics({ execution }: { execution: Execution }) {
  const { t } = useTranslation("executions");
  const running = execution.status === "running";
  const now = useNow(running || execution.status === "queued");
  const elapsed =
    execution.duration_ms ??
    (execution.started_at ? now - new Date(execution.started_at).getTime() : null);
  const queuedFor =
    execution.status === "queued" ? now - new Date(execution.created_at).getTime() : null;
  return (
    <motion.dl
      variants={staggerChildren(0.04)}
      initial="hidden"
      animate="visible"
      className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6"
    >
      <Tile
        label={t("metrics.duration")}
        sub={
          queuedFor !== null
            ? t("metrics.queuedFor", { duration: formatDuration(queuedFor) })
            : t("metrics.timeout", { duration: formatDuration(execution.timeout_s * 1000) })
        }
      >
        {elapsed !== null ? formatDuration(elapsed) : "—"}
      </Tile>
      <Tile label={t("metrics.steps")}>
        <AnimatedNumber value={execution.steps} />
      </Tile>
      <Tile label={t("metrics.modelCalls")}>
        <AnimatedNumber value={execution.model_calls} />
      </Tile>
      <Tile label={t("metrics.toolCalls")}>
        <AnimatedNumber value={execution.tool_calls} />
      </Tile>
      <Tile
        label={t("metrics.tokens")}
        sub={t("metrics.tokensDetail", {
          input: formatTokens(execution.usage.input_tokens),
          output: formatTokens(execution.usage.output_tokens),
        })}
      >
        <AnimatedNumber
          value={execution.usage.total_tokens}
          format={(v) => formatTokens(Math.round(v))}
        />
      </Tile>
      <Tile label={t("metrics.cost")} sub={t(`cost.${execution.cost.source}`)}>
        <CostValue cost={execution.cost} />
      </Tile>
    </motion.dl>
  );
}

function Diagnosis({ execution }: { execution: Execution }) {
  const { t } = useTranslation("executions");
  const diagnose = useDiagnosis();
  const error = execution.error;
  if (!error) return null;
  const why = diagnose(error.code, error.details);
  const cancelled = execution.status === "cancelled";
  return (
    <motion.section
      initial={{ opacity: 0, y: -6 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: motionDuration.slow, ease: ease.standard },
      }}
      exit={{ opacity: 0 }}
      aria-labelledby="diagnosis-title"
      className={cn(
        "mb-6 flex gap-4 rounded-card border px-5 py-4",
        cancelled ? "border-line bg-surface-2/60" : "border-danger/30 bg-danger-soft",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
          cancelled ? "bg-surface text-muted" : "bg-surface text-danger-text",
        )}
      >
        <CircleAlert aria-hidden className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          {t("diagnosis.title")}
        </p>
        <h2
          id="diagnosis-title"
          className={cn(
            "mt-0.5 text-base font-semibold",
            cancelled ? "text-ink" : "text-danger-text",
          )}
        >
          {why.title}
        </h2>
        <p className="mt-1 text-[13px] text-ink">{why.explanation}</p>
        <p className="mt-1 text-[13px] font-medium text-ink">{why.action}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="outline">
            {t("diagnosis.code")}: <span className="font-mono">{error.code}</span>
          </Badge>
          {!cancelled ? (
            <Badge tone={error.retryable ? "brand" : "neutral"}>
              {error.retryable ? t("diagnosis.retryable") : t("diagnosis.notRetryable")}
            </Badge>
          ) : null}
        </div>
        {error.message ? (
          <p className="mt-2 font-mono text-xs break-words text-muted">{error.message}</p>
        ) : null}
      </div>
    </motion.section>
  );
}

function InputCard({ execution }: { execution: Execution }) {
  const { t } = useTranslation("executions");
  const input = execution.input as { text?: string; json?: unknown };
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("io.input")} />
      <div className="p-4">
        {typeof input.text === "string" ? (
          <p className="max-h-64 overflow-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
            {input.text}
          </p>
        ) : (
          <CodeEditor
            value={prettyJson(input.json ?? input)}
            readOnly
            aria-label={t("io.input")}
            maxHeight="256px"
          />
        )}
      </div>
    </Card>
  );
}

function OutputCard({
  execution,
  streams,
}: {
  execution: Execution;
  streams: Record<number, StepStream>;
}) {
  const { t } = useTranslation("executions");
  const output = execution.output as {
    text?: string | null;
    json?: unknown;
    truncated?: boolean;
  } | null;
  const hasJson = output?.json !== undefined;
  const [tab, setTab] = useState(hasJson ? "json" : "text");
  const steps = Object.keys(streams).map(Number);
  const live = steps.length ? streams[Math.max(...steps)] : undefined;
  const running = !isTerminalStatus(execution.status);

  return (
    <Card className="overflow-hidden" aria-busy={running}>
      <CardHeader
        title={t("io.output")}
        actions={
          running && live?.text ? (
            <span className="text-xs text-brand-text">{t("io.streaming")}</span>
          ) : null
        }
      />
      <div className="p-4">
        {output ? (
          hasJson ? (
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList
                value={tab}
                aria-label={t("io.output")}
                items={[
                  { value: "json", label: t("io.json") },
                  { value: "text", label: t("io.text") },
                ]}
                className="mb-3"
              />
              <TabsContent value="json">
                <CodeEditor
                  value={prettyJson(output.json)}
                  readOnly
                  aria-label={t("io.json")}
                  maxHeight="420px"
                />
              </TabsContent>
              <TabsContent value="text">
                <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
                  {output.text}
                </p>
              </TabsContent>
            </Tabs>
          ) : (
            <p className="max-h-[28rem] overflow-auto text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
              {(output.text ?? "").length > 0 ? output.text : t("io.none")}
            </p>
          )
        ) : running ? (
          live?.text ? (
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
              {live.text}
              <span
                aria-hidden
                className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-brand"
              />
            </p>
          ) : (
            <p className="py-6 text-center text-[13px] text-muted">{t("io.waiting")}</p>
          )
        ) : (
          <p className="py-6 text-center text-[13px] text-muted">{t("io.none")}</p>
        )}
        {output?.truncated ? (
          <p className="mt-2 text-xs text-warning-text">{t("io.truncated")}</p>
        ) : null}
      </div>
    </Card>
  );
}
