import { ArrowDownRight, ArrowRight, ArrowUpRight, Equal, Hourglass } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/controls";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/states";
import { formatCost, formatDuration } from "@/features/executions/format";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { percent, useComparison, useRuns, type Comparison } from "./api";
import { ResultBadge } from "./visual";

type Change = Comparison["cases"][number]["change"];
const CHANGE_TONES: Record<Change, "success" | "danger" | "neutral" | "brand" | "outline"> = {
  improved: "success",
  regressed: "danger",
  unchanged: "neutral",
  new: "brand",
  removed: "outline",
  pending: "brand",
};

/** Screen S (comparison) — two runs side by side: what improved, what regressed, at what cost. */
export function ComparePage() {
  const { t } = useTranslation(["evaluations", "common"]);
  const { workspace, basePath } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const base = params.get("base");
  const candidate = params.get("candidate");
  const comparison = useComparison(base, candidate);
  const runs = useRuns(workspace.id, null, 100);
  useDocumentTitle(`${t("compare.title")} — ${workspace.name}`);

  const pick = (key: "base" | "candidate", value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <PageContainer wide>
      <PageHeader
        breadcrumbs={[
          { label: t("run.breadcrumb"), to: `${basePath}/evaluations` },
          { label: t("compare.title") },
        ]}
        title={t("compare.title")}
        description={
          comparison.data
            ? t("compare.description", {
                base: comparison.data.base.label,
                candidate: comparison.data.candidate.label,
              })
            : t("compare.pick")
        }
      />
      <Card className="mb-6">
        <div className="grid gap-4 p-5 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <Field label={t("compare.pickBase")}>
            <Select
              value={base ?? undefined}
              onValueChange={(value) => pick("base", value)}
              options={(runs.data ?? []).map((r) => ({
                value: r.id,
                label: r.label,
                description: r.suite_name,
              }))}
            />
          </Field>
          <ArrowRight aria-hidden className="mx-auto mb-2.5 hidden size-4 text-muted sm:block" />
          <Field label={t("compare.pickCandidate")}>
            <Select
              value={candidate ?? undefined}
              onValueChange={(value) => pick("candidate", value)}
              options={(runs.data ?? []).map((r) => ({
                value: r.id,
                label: r.label,
                description: r.suite_name,
              }))}
            />
          </Field>
        </div>
        {base && candidate && base === candidate ? (
          <p role="alert" className="px-5 pb-4 text-[13px] text-danger-text">
            {t("compare.sameRun")}
          </p>
        ) : null}
      </Card>
      {!base || !candidate || base === candidate ? null : comparison.isPending ? (
        <Skeleton className="h-96 rounded-card" />
      ) : comparison.isError ? (
        <Card>
          <ErrorState error={comparison.error} onRetry={() => void comparison.refetch()} />
        </Card>
      ) : (
        <ComparisonView data={comparison.data} basePath={basePath} />
      )}
    </PageContainer>
  );
}

function Delta({
  value,
  format,
  higherIsBetter = true,
}: {
  value: number | null;
  format: (v: number) => string;
  higherIsBetter?: boolean;
}) {
  if (value === null || Math.abs(value) < 1e-9) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        <Equal aria-hidden className="size-3.5" />
        {value === null ? "—" : format(0)}
      </span>
    );
  }
  const good = higherIsBetter ? value > 0 : value < 0;
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
        good ? "text-success-text" : "text-danger-text",
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {value > 0 ? "+" : "−"}
      {format(Math.abs(value))}
    </span>
  );
}

function Side({
  label,
  before,
  after,
  delta,
}: {
  label: string;
  before: ReactNode;
  after: ReactNode;
  delta: ReactNode;
}) {
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-card border border-line bg-surface px-4 py-3 shadow-sm"
    >
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 flex items-baseline gap-2 text-sm text-muted tabular-nums">
        <span>{before}</span>
        <ArrowRight aria-hidden className="size-3.5 self-center" />
        <span className="text-lg font-semibold text-ink">{after}</span>
      </p>
      <p className="mt-0.5">{delta}</p>
    </motion.div>
  );
}

function ComparisonView({ data, basePath }: { data: Comparison; basePath: string }) {
  const { t } = useTranslation("evaluations");
  const [filter, setFilter] = useState<Change | "all">("all");
  const pending = data.base.status === "running" || data.candidate.status === "running";
  const verdict = pending
    ? { text: t("compare.verdictPending"), tone: "bg-brand-soft text-brand-text", Icon: Hourglass }
    : (data.pass_rate_delta ?? 0) > 0
      ? {
          text: t("compare.verdictBetter"),
          tone: "bg-success-soft text-success-text",
          Icon: ArrowUpRight,
        }
      : (data.pass_rate_delta ?? 0) < 0
        ? {
            text: t("compare.verdictWorse"),
            tone: "bg-danger-soft text-danger-text",
            Icon: ArrowDownRight,
          }
        : { text: t("compare.verdictSame"), tone: "bg-surface-2 text-ink", Icon: Equal };
  const cases = filter === "all" ? data.cases : data.cases.filter((c) => c.change === filter);
  const currency = data.base.summary.cost_currency ?? data.candidate.summary.cost_currency ?? "USD";

  return (
    <div className="flex flex-col gap-6">
      <motion.div
        key={verdict.text}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        role="status"
        className={cn(
          "flex items-center gap-3 rounded-card px-5 py-4 text-[15px] font-semibold",
          verdict.tone,
        )}
      >
        <verdict.Icon aria-hidden className="size-5" />
        {verdict.text}
      </motion.div>
      <motion.div
        variants={staggerChildren(0.05)}
        initial="hidden"
        animate="visible"
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <Side
          label={t("compare.passRate")}
          before={percent(data.base.summary.pass_rate)}
          after={percent(data.candidate.summary.pass_rate)}
          delta={
            <Delta
              value={data.pass_rate_delta === null ? null : data.pass_rate_delta * 100}
              format={(v) => `${Math.round(v)} pts`}
            />
          }
        />
        <Side
          label={t("compare.avgScore")}
          before={data.base.summary.avg_score?.toFixed(2) ?? "—"}
          after={data.candidate.summary.avg_score?.toFixed(2) ?? "—"}
          delta={<Delta value={data.avg_score_delta} format={(v) => v.toFixed(2)} />}
        />
        <Side
          label={t("compare.cost")}
          before={formatCost(data.base.summary.cost_amount, currency)}
          after={formatCost(data.candidate.summary.cost_amount, currency)}
          delta={
            <Delta
              value={data.cost_delta === null ? null : Number(data.cost_delta)}
              format={(v) => formatCost(v, currency)}
              higherIsBetter={false}
            />
          }
        />
        <Side
          label={t("compare.duration")}
          before={formatDuration(data.base.summary.avg_duration_ms)}
          after={formatDuration(data.candidate.summary.avg_duration_ms)}
          delta={
            <Delta
              value={data.avg_duration_delta_ms}
              format={(v) => formatDuration(v)}
              higherIsBetter={false}
            />
          }
        />
      </motion.div>
      <Card className="overflow-hidden">
        <CardHeader
          title={t("suite.cases")}
          actions={
            <div role="group" aria-label={t("compare.filter")} className="flex flex-wrap gap-1.5">
              {(["all", "improved", "regressed", "unchanged"] as const).map((key) => {
                const count = key === "all" ? data.cases.length : data[key];
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors max-md:h-9",
                      filter === key
                        ? "border-brand bg-brand-soft text-brand-text"
                        : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {key === "all" ? t("compare.all") : t(`compare.${key}`)}
                    <span className="tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t("run.case")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("compare.base")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("compare.candidate")}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  {t("compare.change")}
                </th>
              </tr>
            </thead>
            <tbody>
              <AnimatePresence initial={false} mode="popLayout">
                {cases.map((item) => (
                  <motion.tr
                    key={item.case_id ?? item.case_name}
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="border-b border-line last:border-b-0"
                  >
                    <th scope="row" className="px-5 py-3 text-left font-medium text-ink">
                      {item.case_name}
                    </th>
                    <td className="px-3 py-3">
                      {item.base ? (
                        <span className="inline-flex items-center gap-2">
                          <ResultBadge status={item.base.status} />
                          <span className="text-xs text-muted tabular-nums">
                            {item.base.score?.toFixed(2) ?? "—"}
                          </span>
                          {item.base.execution_id ? (
                            <Link
                              className="sr-only focus:not-sr-only"
                              to={`${basePath}/executions/${item.base.execution_id}`}
                            >
                              {t("run.trace")}
                            </Link>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {item.candidate ? (
                        <span className="inline-flex items-center gap-2">
                          <ResultBadge status={item.candidate.status} />
                          <span className="text-xs text-muted tabular-nums">
                            {item.candidate.score?.toFixed(2) ?? "—"}
                          </span>
                          {item.candidate.execution_id ? (
                            <Link
                              className="text-xs text-brand-text hover:underline"
                              to={`${basePath}/executions/${item.candidate.execution_id}`}
                            >
                              {t("run.trace")}
                            </Link>
                          ) : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Badge tone={CHANGE_TONES[item.change]}>
                        {t(`compare.changes.${item.change}`)}
                      </Badge>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
