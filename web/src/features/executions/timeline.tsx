import {
  Ban,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Hourglass,
  Info,
  MessageSquareText,
  Play,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { duration as motionDuration, ease } from "@/components/motion/presets";
import { prettyJson } from "@/lib/json";
import { CopyButton } from "@/components/ui/copy-button";
import type { ExecutionEvent } from "./api";
import { CostValue, type CostLike } from "./cost";
import { formatDuration, formatTokens } from "./format";
import type { StepStream } from "./live";

import { buildTimeline, num, str, type Data, type TimelineItem } from "./build-timeline";

const LIFECYCLE: Record<string, { Icon: LucideIcon; tone: string }> = {
  "execution.queued": { Icon: CircleDashed, tone: "bg-surface-2 text-muted" },
  "execution.started": { Icon: Play, tone: "bg-brand-soft text-brand-text" },
  "execution.cancel_requested": { Icon: Ban, tone: "bg-warning-soft text-warning-text" },
  "execution.succeeded": { Icon: CircleCheck, tone: "bg-success-soft text-success-text" },
  "execution.failed": { Icon: CircleX, tone: "bg-danger-soft text-danger-text" },
  "execution.cancelled": { Icon: Ban, tone: "bg-surface-2 text-muted" },
  "execution.timed_out": { Icon: Hourglass, tone: "bg-danger-soft text-danger-text" },
};

function Node({ Icon, tone, pulse = false }: { Icon: LucideIcon; tone: string; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-surface",
        tone,
      )}
    >
      {pulse ? (
        <span aria-hidden className="absolute inset-0 animate-breathe rounded-full bg-brand" />
      ) : null}
      <Icon aria-hidden className="relative size-3.5" />
    </span>
  );
}

/** Time since the execution started, at a steady precision so the column reads like a log. */
function Offset({ at, origin }: { at: string; origin: number | null }) {
  if (origin === null) return null;
  const ms = Math.max(0, new Date(at).getTime() - origin);
  const label =
    ms < 60_000
      ? `+${(ms / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`
      : `+${formatDuration(ms)}`;
  return <span className="font-mono text-[11px] text-muted tabular-nums">{label}</span>;
}

function Details({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation("executions");
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-brand-text hover:underline focus-visible:outline-2 focus-visible:outline-focus"
      >
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
        {open ? t("timeline.hideDetails") : t("timeline.showDetails")}
        <span className="sr-only">: {label}</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{
              height: "auto",
              opacity: 1,
              transition: { duration: motionDuration.base, ease: ease.standard },
            }}
            exit={{ height: 0, opacity: 0, transition: { duration: motionDuration.fast } }}
            className="overflow-hidden"
          >
            <div className="pt-2">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function JsonBlock({ value, label }: { value: unknown; label: string }) {
  const text = typeof value === "string" ? value : prettyJson(value);
  return (
    <div className="relative">
      <pre className="max-h-72 overflow-auto rounded-field bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink">
        {text}
      </pre>
      <CopyButton value={text} label={label} size="xs" className="absolute top-1.5 right-1.5" />
    </div>
  );
}

/** Text being written live, with a caret — the "motion serves information" moment. */
function Streaming({ stream }: { stream: StepStream }) {
  const { t } = useTranslation("executions");
  const reduced = useReducedMotion();
  return (
    <div className="mt-2 flex flex-col gap-2">
      {stream.reasoning ? (
        <p className="rounded-field border border-dashed border-line px-3 py-2 text-xs leading-relaxed text-muted italic">
          <span className="mb-1 block font-medium not-italic">{t("timeline.thinking")}</span>
          {stream.reasoning.slice(-600)}
        </p>
      ) : null}
      {stream.text ? (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
          {stream.text.slice(-1200)}
          <span
            aria-hidden
            className={cn(
              "ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-[1px] bg-brand",
              !reduced && "animate-pulse",
            )}
          />
        </p>
      ) : null}
      {stream.tools.length > 0 ? (
        <p className="text-xs text-muted">{stream.tools.join(", ")}</p>
      ) : null}
    </div>
  );
}

function ModelCard({
  item,
  origin,
  stream,
  live,
}: {
  item: Extract<TimelineItem, { kind: "model" }>;
  origin: number | null;
  stream: StepStream | undefined;
  live: boolean;
}) {
  const { t } = useTranslation("executions");
  const request = item.request?.data ?? {};
  const response = item.response ? item.response.data : null;
  const error = item.error ? (item.error.data.error as Data | undefined) : undefined;
  const pending = !item.response && !item.error;
  const usage = (response?.usage ?? {}) as Data;
  const toolCalls = Array.isArray(response?.tool_calls) ? (response.tool_calls as Data[]) : [];
  const attempts = num(response?.attempts) ?? 1;
  const first = item.request ?? item.response ?? item.error;

  const title = error
    ? t("timeline.events.model_error")
    : response
      ? toolCalls.length > 0
        ? t("timeline.responseTools", { count: toolCalls.length })
        : t("timeline.responseText")
      : t("timeline.events.model_request");

  return (
    <div className="flex gap-3">
      <Node
        Icon={error ? CircleAlert : response ? MessageSquareText : Sparkles}
        tone={error ? "bg-danger-soft text-danger-text" : "bg-brand-soft text-brand-text"}
        pulse={pending && live}
      />
      <div className="min-w-0 flex-1 rounded-card border border-line bg-surface px-3.5 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium text-ink">{title}</span>
          <span className="text-xs text-muted">{t("timeline.step", { step: item.step })}</span>
          <span className="ml-auto flex items-center gap-2">
            {item.response?.duration_ms !== undefined && item.response.duration_ms !== null ? (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted tabular-nums">
                {formatDuration(item.response.duration_ms)}
              </span>
            ) : null}
            {first ? <Offset at={first.created_at} origin={origin} /> : null}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {t("timeline.requestDetail", {
            model: str(request.model) ?? str(response?.model) ?? "—",
            messages: num(request.messages) ?? "—",
          })}
          {Array.isArray(request.tools) && request.tools.length > 0
            ? ` · ${t("timeline.requestTools", { count: request.tools.length })}`
            : ""}
        </p>
        {pending && stream ? <Streaming stream={stream} /> : null}
        {pending && !stream && live ? (
          <p className="mt-2 text-xs text-muted">{t("timeline.thinking")}</p>
        ) : null}
        {response ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="tabular-nums">
              {t("timeline.tokens", {
                input: formatTokens(num(usage.input_tokens)),
                output: formatTokens(num(usage.output_tokens)),
              })}
            </span>
            {response.cost ? (
              <CostValue cost={response.cost as CostLike} className="text-ink" />
            ) : null}
            {attempts > 1 ? (
              <span>{t("timeline.retriedAttempts", { count: attempts - 1 })}</span>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="mt-2 rounded-field bg-danger-soft px-2.5 py-1.5 text-xs text-danger-text">
            <span className="font-mono">{str(error.code)}</span> — {str(error.message)}
          </p>
        ) : null}
        {response ? (
          <Details label={title}>
            <div className="flex flex-col gap-2">
              {str(response.reasoning) ? (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted">{t("timeline.reasoning")}</p>
                  <JsonBlock value={str(response.reasoning)} label={t("timeline.reasoning")} />
                </div>
              ) : null}
              {str(response.content) ? (
                <JsonBlock value={str(response.content)} label={t("io.output")} />
              ) : null}
              {toolCalls.length > 0 ? (
                <JsonBlock value={toolCalls} label={t("timeline.events.tool_call")} />
              ) : null}
              {str(response.provider_request_id) ? (
                <p className="text-[11px] text-muted">
                  {t("timeline.requestId")}:{" "}
                  <span className="font-mono">{str(response.provider_request_id)}</span>
                </p>
              ) : null}
            </div>
          </Details>
        ) : null}
      </div>
    </div>
  );
}

function ToolCard({
  item,
  origin,
  live,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  origin: number | null;
  live: boolean;
}) {
  const { t } = useTranslation("executions");
  const call = item.call.data;
  const result = item.result ? item.result.data : null;
  const ok = result ? result.ok === true : null;
  const name = str(call.tool) ?? "tool";
  const code = str(result?.error_code);
  const known = [
    "tool_not_allowed",
    "invalid_arguments",
    "tool_timeout",
    "tool_error",
    "tool_disabled",
    "tool_unavailable",
  ];
  return (
    <div className="flex gap-3">
      <Node
        Icon={ok === false ? CircleX : Wrench}
        tone={
          ok === false
            ? "bg-danger-soft text-danger-text"
            : ok
              ? "bg-success-soft text-success-text"
              : "bg-warning-soft text-warning-text"
        }
        pulse={ok === null && live}
      />
      <div className="min-w-0 flex-1 rounded-card border border-line bg-surface px-3.5 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[13px] font-medium text-ink">{t("timeline.events.tool_call")}</span>
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">
            {name}
          </code>
          <span className="ml-auto flex items-center gap-2">
            {item.result?.duration_ms !== undefined && item.result.duration_ms !== null ? (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted tabular-nums">
                {formatDuration(item.result.duration_ms)}
              </span>
            ) : null}
            <Offset at={item.call.created_at} origin={origin} />
          </span>
        </div>
        <p className={cn("mt-0.5 text-xs", ok === false ? "text-danger-text" : "text-muted")}>
          {ok === null
            ? "…"
            : ok
              ? t("timeline.toolOk", { duration: formatDuration(item.result?.duration_ms ?? null) })
              : `${t("timeline.toolFailed", { code: code ?? "error" })}${code && known.includes(code) ? ` — ${t(`tools.${code as "tool_error"}`)}` : ""}`}
        </p>
        <Details label={name}>
          <div className="flex flex-col gap-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t("timeline.arguments")}</p>
              <JsonBlock value={call.arguments ?? {}} label={t("timeline.arguments")} />
            </div>
            {result ? (
              <div>
                <p className="mb-1 text-xs font-medium text-muted">{t("timeline.result")}</p>
                <JsonBlock
                  value={
                    ok
                      ? (result.output ?? null)
                      : { error: result.error_code, message: result.error_message }
                  }
                  label={t("timeline.result")}
                />
              </div>
            ) : null}
          </div>
        </Details>
      </div>
    </div>
  );
}

function LifecycleRow({ event, origin }: { event: ExecutionEvent; origin: number | null }) {
  const { t } = useTranslation("executions");
  const data = event.data;
  const look = LIFECYCLE[event.type] ?? { Icon: Info, tone: "bg-surface-2 text-muted" };
  const label =
    event.type in LIFECYCLE
      ? t(`timeline.events.${event.type.replace(".", "_") as "execution_started"}`)
      : event.type;
  let detail: string | null = null;
  if (event.type === "execution.started") {
    detail = t("timeline.startedDetail", {
      provider: str(data.provider_name) ?? str(data.provider) ?? "—",
      model: str(data.model) ?? "—",
    });
  } else if (event.type === "execution.failed" || event.type === "execution.timed_out") {
    const error = data.error as Data | undefined;
    detail = str(error?.code);
  }
  return (
    <div className="flex items-center gap-3">
      <Node Icon={look.Icon} tone={look.tone} />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        {detail ? <span className="truncate font-mono text-xs text-muted">{detail}</span> : null}
        <span className="ml-auto">
          <Offset at={event.created_at} origin={origin} />
        </span>
      </div>
    </div>
  );
}

function LogRow({ event, origin }: { event: ExecutionEvent; origin: number | null }) {
  const data = event.data;
  return (
    <div className="flex items-center gap-3">
      <Node
        Icon={event.level === "warning" || event.level === "error" ? CircleAlert : Info}
        tone="bg-warning-soft text-warning-text"
      />
      <p className="min-w-0 flex-1 text-[13px] text-ink">{str(data.message) ?? event.type}</p>
      <Offset at={event.created_at} origin={origin} />
    </div>
  );
}

/** The trace: a vertical rail of steps; new steps glide in as they happen. */
export function Timeline({
  events,
  streams,
  live,
}: {
  events: ExecutionEvent[];
  streams: Record<number, StepStream>;
  live: boolean;
}) {
  const reduced = useReducedMotion();
  const items = buildTimeline(events);
  const started = events.find((e) => e.type === "execution.started") ?? events[0];
  const origin = started ? new Date(started.created_at).getTime() : null;
  return (
    <ol className="relative flex flex-col gap-3 before:absolute before:top-3 before:bottom-3 before:left-[13px] before:w-px before:bg-line">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.li
            key={`${item.kind}-${String(item.seq)}`}
            layout={reduced ? false : "position"}
            initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
              transition: { duration: motionDuration.base, ease: ease.standard },
            }}
          >
            {item.kind === "model" ? (
              <ModelCard item={item} origin={origin} stream={streams[item.step]} live={live} />
            ) : item.kind === "tool" ? (
              <ToolCard item={item} origin={origin} live={live} />
            ) : item.kind === "log" ? (
              <LogRow event={item.event} origin={origin} />
            ) : (
              <LifecycleRow event={item.event} origin={origin} />
            )}
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
