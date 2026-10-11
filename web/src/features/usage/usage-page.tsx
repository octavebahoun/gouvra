import { ArrowRight, BadgeCheck, Calculator, CircleSlash } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { BudgetOverview, ExportButtons } from "@/features/billing/budget-section";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { CostValue } from "@/features/executions/cost";
import { formatCost, formatDuration, formatTokens } from "@/features/executions/format";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { granularityOf, useUsage, type Usage, type UsagePeriod } from "./api";

const PERIODS: UsagePeriod[] = ["24h", "7d", "30d", "90d"];
type Metric = "tokens" | "cost" | "executions";

/** Screen P — usage over a period: tokens, costs with their provenance, by agent and model. */
export function UsagePage() {
  const { t } = useTranslation(["usage", "common"]);
  const { workspace, basePath } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const period = (params.get("period") as UsagePeriod | null) ?? "7d";
  const usage = useUsage(workspace.id, period);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  return (
    <PageContainer wide>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <ExportButtons />
            <RadioGroup.Root
              value={period}
              onValueChange={(value) => {
                const next = new URLSearchParams(params);
                if (value === "7d") next.delete("period");
                else next.set("period", value);
                setParams(next, { replace: true });
              }}
              aria-label={t("period")}
              className="inline-flex rounded-field border border-line bg-surface-2 p-0.5"
            >
              {PERIODS.map((value) => (
                <RadioGroup.Item
                  key={value}
                  value={value}
                  aria-label={t(`periods.${value}`)}
                  className={cn(
                    "h-8 rounded-[5px] px-3 text-[13px] font-medium text-muted transition-colors max-md:h-10",
                    "hover:text-ink data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-sm",
                  )}
                >
                  {value}
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </>
        }
      />
      <BudgetOverview />
      {usage.isPending ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-card" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-card" />
        </div>
      ) : usage.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={usage.error}
            onRetry={() => void usage.refetch()}
          />
        </Card>
      ) : (
        <motion.div
          variants={staggerChildren(0.06)}
          initial="hidden"
          animate="visible"
          className={cn(
            "flex flex-col gap-6 transition-opacity",
            usage.isPlaceholderData && "opacity-60",
          )}
          aria-busy={usage.isFetching}
        >
          <Summary data={usage.data} />
          <motion.div variants={fadeUp}>
            <TimeChart data={usage.data} period={period} />
          </motion.div>
          <div className="grid gap-6 xl:grid-cols-2">
            <motion.div variants={fadeUp}>
              <Breakdown data={usage.data} by="agent" basePath={basePath} />
            </motion.div>
            <motion.div variants={fadeUp}>
              <Breakdown data={usage.data} by="model" basePath={basePath} />
            </motion.div>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <motion.div variants={fadeUp}>
              <Provenance data={usage.data} />
            </motion.div>
            <motion.div variants={fadeUp}>
              <Limits data={usage.data} basePath={basePath} />
            </motion.div>
          </div>
        </motion.div>
      )}
    </PageContainer>
  );
}

function SummaryCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <motion.div
      variants={fadeUp}
      className="rounded-card border border-line bg-surface p-4 shadow-sm"
    >
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted">{detail}</p> : null}
    </motion.div>
  );
}

function Summary({ data }: { data: Usage }) {
  const { t } = useTranslation("usage");
  const executions = Object.values(data.executions).reduce((sum, n) => sum + n, 0);
  return (
    <motion.div
      variants={staggerChildren(0.05)}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <SummaryCard
        label={t("cards.cost")}
        value={<CostValue cost={data.cost} />}
        detail={
          data.cost.unpriced_calls > 0
            ? t("cards.unpriced", { count: data.cost.unpriced_calls })
            : t("cards.allPriced")
        }
      />
      <SummaryCard
        label={t("cards.tokens")}
        value={
          <AnimatedNumber
            value={data.tokens.input_tokens + data.tokens.output_tokens}
            format={(v) => formatTokens(Math.round(v))}
          />
        }
        detail={t("cards.tokensDetail", {
          input: formatTokens(data.tokens.input_tokens),
          output: formatTokens(data.tokens.output_tokens),
        })}
      />
      <SummaryCard
        label={t("cards.executions")}
        value={<AnimatedNumber value={executions} />}
        detail={t("cards.executionsDetail", {
          succeeded: (data.executions.succeeded ?? 0).toLocaleString(),
          failed: (
            (data.executions.failed ?? 0) + (data.executions.timed_out ?? 0)
          ).toLocaleString(),
        })}
      />
      <SummaryCard
        label={t("cards.modelCalls")}
        value={<AnimatedNumber value={data.tokens.model_calls} />}
        detail={
          data.tokens.cached_tokens > 0
            ? t("cards.cached", { count: data.tokens.cached_tokens })
            : undefined
        }
      />
    </motion.div>
  );
}

function useBucketLabel(period: UsagePeriod) {
  const { i18n } = useTranslation();
  const granularity = granularityOf(period);
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(
      i18n.resolvedLanguage,
      granularity === "hour"
        ? { hour: "2-digit", minute: "2-digit" }
        : { month: "short", day: "numeric" },
    );
    return (value: string) => format.format(new Date(value));
  }, [i18n.resolvedLanguage, granularity]);
}

function TimeChart({ data, period }: { data: Usage; period: UsagePeriod }) {
  const { t } = useTranslation("usage");
  const reduced = useReducedMotion();
  const [metric, setMetric] = useState<Metric>("tokens");
  const label = useBucketLabel(period);
  const rows = data.series.map((point) => ({
    start: point.start,
    label: label(point.start),
    input: point.input_tokens,
    output: point.output_tokens,
    cost: point.cost === null ? 0 : Number(point.cost),
    succeeded: point.succeeded,
    failed: point.failed,
  }));
  const empty = rows.every((row) => row.input + row.output + row.succeeded + row.failed === 0);
  const axis = {
    stroke: "var(--gv-muted)",
    fontSize: 11,
    tickLine: false,
    axisLine: false,
  } as const;
  const tooltipStyle = {
    contentStyle: {
      background: "var(--gv-surface)",
      border: "1px solid var(--gv-line)",
      borderRadius: 8,
      fontSize: 12,
      color: "var(--gv-ink)",
      boxShadow: "var(--gv-shadow-md)",
    },
    labelStyle: { color: "var(--gv-muted)", marginBottom: 4 },
    cursor: { fill: "color-mix(in srgb, var(--gv-brand) 8%, transparent)" },
  };
  const animation = {
    isAnimationActive: !reduced,
    animationDuration: 700,
    animationEasing: "ease-out",
  } as const;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={t("chart.title")}
        actions={
          <RadioGroup.Root
            value={metric}
            onValueChange={(value) => setMetric(value as Metric)}
            aria-label={t("chart.metric")}
            className="inline-flex rounded-field border border-line bg-surface-2 p-0.5"
          >
            {(["tokens", "cost", "executions"] as const).map((value) => (
              <RadioGroup.Item
                key={value}
                value={value}
                className={cn(
                  "h-7 rounded-[5px] px-2.5 text-xs font-medium text-muted transition-colors max-md:h-9",
                  "hover:text-ink data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-sm",
                )}
              >
                {t(`chart.${value}`)}
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        }
      />
      <div className="p-4">
        {empty ? (
          <p className="py-16 text-center text-[13px] text-muted">{t("chart.empty")}</p>
        ) : (
          <div aria-hidden className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              {metric === "cost" ? (
                <AreaChart
                  accessibilityLayer={false}
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="usage-cost" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="var(--gv-chart-2)" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="var(--gv-chart-2)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--gv-chart-grid)" vertical={false} />
                  <XAxis dataKey="label" {...axis} minTickGap={16} />
                  <YAxis
                    {...axis}
                    width={56}
                    tickFormatter={(v: number) => formatCost(v, data.cost.currency ?? "USD")}
                  />
                  <ChartTooltip
                    {...tooltipStyle}
                    formatter={(v) => formatCost(Number(v), data.cost.currency ?? "USD")}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    name={t("chart.cost")}
                    stroke="var(--gv-chart-2)"
                    strokeWidth={2}
                    fill="url(#usage-cost)"
                    {...animation}
                  />
                </AreaChart>
              ) : metric === "tokens" ? (
                <BarChart
                  accessibilityLayer={false}
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid stroke="var(--gv-chart-grid)" vertical={false} />
                  <XAxis dataKey="label" {...axis} minTickGap={16} />
                  <YAxis {...axis} width={48} tickFormatter={(v: number) => formatTokens(v)} />
                  <ChartTooltip {...tooltipStyle} formatter={(v) => Number(v).toLocaleString()} />
                  <Bar
                    dataKey="input"
                    name={t("chart.input")}
                    stackId="tokens"
                    fill="var(--gv-chart-1)"
                    radius={[0, 0, 0, 0]}
                    {...animation}
                  />
                  <Bar
                    dataKey="output"
                    name={t("chart.output")}
                    stackId="tokens"
                    fill="var(--gv-chart-4)"
                    radius={[3, 3, 0, 0]}
                    {...animation}
                  />
                </BarChart>
              ) : (
                <BarChart
                  accessibilityLayer={false}
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid stroke="var(--gv-chart-grid)" vertical={false} />
                  <XAxis dataKey="label" {...axis} minTickGap={16} />
                  <YAxis {...axis} width={36} allowDecimals={false} />
                  <ChartTooltip {...tooltipStyle} />
                  <Bar
                    dataKey="succeeded"
                    name={t("chart.succeeded")}
                    stackId="runs"
                    fill="var(--gv-success)"
                    {...animation}
                  />
                  <Bar
                    dataKey="failed"
                    name={t("chart.failed")}
                    stackId="runs"
                    fill="var(--gv-danger)"
                    radius={[3, 3, 0, 0]}
                    {...animation}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
        <Legend metric={metric} />
        {/* Tables ignore width:1px; the clipping wrapper keeps this one from widening the page. */}
        <div className="sr-only">
          <table>
            <caption>{t("chart.tableCaption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("chart.period")}</th>
                <th scope="col">{t("chart.input")}</th>
                <th scope="col">{t("chart.output")}</th>
                <th scope="col">{t("chart.cost")}</th>
                <th scope="col">{t("chart.succeeded")}</th>
                <th scope="col">{t("chart.failed")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.start}>
                  <th scope="row">{row.label}</th>
                  <td>{row.input}</td>
                  <td>{row.output}</td>
                  <td>{formatCost(row.cost, data.cost.currency ?? "USD")}</td>
                  <td>{row.succeeded}</td>
                  <td>{row.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function Legend({ metric }: { metric: Metric }) {
  const { t } = useTranslation("usage");
  const items =
    metric === "tokens"
      ? [
          { label: t("chart.input"), color: "var(--gv-chart-1)" },
          { label: t("chart.output"), color: "var(--gv-chart-4)" },
        ]
      : metric === "cost"
        ? [{ label: t("chart.cost"), color: "var(--gv-chart-2)" }]
        : [
            { label: t("chart.succeeded"), color: "var(--gv-success)" },
            { label: t("chart.failed"), color: "var(--gv-danger)" },
          ];
  return (
    <ul aria-hidden className="mt-3 flex flex-wrap gap-4 text-xs text-muted">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Breakdown({
  data,
  by,
  basePath,
}: {
  data: Usage;
  by: "agent" | "model";
  basePath: string;
}) {
  const { t } = useTranslation("usage");
  const rows = by === "agent" ? data.by_agent : data.by_model;
  const total = rows.reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0) || 1;
  return (
    <Card className="overflow-hidden">
      <CardHeader title={by === "agent" ? t("breakdown.byAgent") : t("breakdown.byModel")} />
      {rows.length === 0 ? (
        <EmptyState compact title={t("breakdown.empty")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {by === "agent" ? t("breakdown.agent") : t("breakdown.model")}
                </th>
                <th scope="col" className="px-3 py-2.5 font-medium">
                  {t("breakdown.share")}
                </th>
                <th scope="col" className="px-3 py-2.5 text-right font-medium">
                  {t("breakdown.tokens")}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  {t("breakdown.cost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const tokens = row.input_tokens + row.output_tokens;
                const share = tokens / total;
                const name =
                  by === "agent"
                    ? row.agent_id
                      ? (row.agent_name ?? t("breakdown.deletedAgent"))
                      : t("breakdown.noAgent")
                    : (row.model ?? "—");
                return (
                  <tr
                    key={`${row.agent_id ?? ""}-${row.model ?? ""}-${String(index)}`}
                    className="border-b border-line last:border-b-0"
                  >
                    <th
                      scope="row"
                      className="max-w-56 truncate px-5 py-3 text-left font-medium text-ink"
                    >
                      {by === "agent" && row.agent_id ? (
                        <Link
                          to={`${basePath}/agents/${row.agent_id}`}
                          className="hover:text-brand-text hover:underline"
                        >
                          {name}
                        </Link>
                      ) : (
                        <span className={by === "model" ? "font-mono text-xs" : undefined}>
                          {name}
                        </span>
                      )}
                    </th>
                    <td className="w-40 px-3 py-3">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <motion.span
                            className="block h-full rounded-full bg-brand"
                            initial={{ width: 0 }}
                            animate={{ width: `${Math.max(2, share * 100)}%` }}
                            transition={{
                              duration: 0.7,
                              ease: [0.2, 0, 0, 1],
                              delay: index * 0.04,
                            }}
                          />
                        </span>
                        <span className="w-9 text-right text-xs text-muted tabular-nums">
                          {Math.round(share * 100)}%
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-ink tabular-nums">
                      {formatTokens(tokens)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <CostValue
                        cost={{
                          amount: row.cost,
                          currency: row.currency,
                          source: row.cost_source,
                          partial: row.partial,
                        }}
                        className="justify-end"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const SOURCE_ICONS = {
  provider_reported: BadgeCheck,
  estimated: Calculator,
  unavailable: CircleSlash,
};

function Provenance({ data }: { data: Usage }) {
  const { t } = useTranslation("usage");
  const sources = ["provider_reported", "estimated", "unavailable"] as const;
  return (
    <Card className="h-full overflow-hidden">
      <CardHeader title={t("provenance.title")} description={t("provenance.body")} />
      <ul className="divide-y divide-line">
        {sources.map((source) => {
          const Icon = SOURCE_ICONS[source];
          const amount = data.cost.by_source[source];
          return (
            <li key={source} className="flex items-center gap-3 px-5 py-3 text-[13px]">
              <Icon aria-hidden className="size-4 text-muted" />
              <span className="flex-1 text-ink">{t(`provenance.${source}`)}</span>
              <span className="text-ink tabular-nums">
                {source === "unavailable"
                  ? t("cards.unpriced", { count: data.cost.unpriced_calls })
                  : amount !== undefined
                    ? formatCost(amount, data.cost.currency ?? "USD")
                    : "—"}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function Limits({ data, basePath }: { data: Usage; basePath: string }) {
  const { t } = useTranslation("usage");
  const rows: [string, string][] = [
    [t("limits.concurrency"), data.limits.max_concurrent_executions.toLocaleString()],
    [t("limits.perMinute"), data.limits.executions_per_minute.toLocaleString()],
    [t("limits.timeout"), formatDuration(data.limits.max_execution_timeout_s * 1000)],
    [t("limits.input"), `${Math.round(data.limits.max_input_bytes / 1024).toLocaleString()} KB`],
  ];
  return (
    <Card className="h-full overflow-hidden">
      <CardHeader
        title={t("limits.title")}
        description={t("limits.description")}
        actions={
          <Link
            to={`${basePath}/settings/general`}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline"
          >
            {t("limits.manage")}
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        }
      />
      <dl className="divide-y divide-line">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex items-center justify-between gap-4 px-5 py-3 text-[13px]"
          >
            <dt className="text-muted">{label}</dt>
            <dd className="font-medium text-ink tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
