import { Activity, Ban, Building2, CircleDollarSign, Users } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { fadeUp, staggerChildren } from "@/components/motion/presets";
import { Card, Skeleton } from "@/components/ui/feedback";
import { ErrorState } from "@/components/ui/states";
import { useInstanceOverview } from "./api";

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <motion.div variants={fadeUp}>
      <Card className="h-full p-4">
        <div className="flex items-center gap-2 text-[13px] text-muted [&_svg]:size-4">
          {icon}
          {label}
        </div>
        <p className="mt-2 text-[24px] leading-none font-semibold text-ink tabular-nums">{value}</p>
        {hint ? <p className="mt-1.5 text-[12px] text-muted">{hint}</p> : null}
      </Card>
    </motion.div>
  );
}

/** Five numbers that say how the instance is doing, refreshed every 30 seconds. */
export function OverviewCards() {
  const { t } = useTranslation("admin");
  const overview = useInstanceOverview();
  if (overview.isPending) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 rounded-card" />
        ))}
      </div>
    );
  }
  if (overview.isError) {
    return (
      <Card>
        <ErrorState compact error={overview.error} onRetry={() => void overview.refetch()} />
      </Card>
    );
  }
  const data = overview.data;
  const plans = Object.entries(data.plans)
    .map(([plan, count]) => `${t(`plans.${plan as "free"}`, { defaultValue: plan })} ${count}`)
    .join(" · ");
  const providerLabel =
    data.billing_provider === "stripe"
      ? t("overview.providers.stripe")
      : data.billing_provider === "simulated"
        ? t("overview.providers.simulated")
        : t("overview.providers.none");
  const spend = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    Number(data.spend_30d),
  );
  return (
    <motion.div
      variants={staggerChildren(0.05)}
      initial="hidden"
      animate="visible"
      className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-5"
    >
      <Stat
        icon={<Users aria-hidden />}
        label={t("overview.users")}
        value={data.users.toLocaleString()}
      />
      <Stat
        icon={<Building2 aria-hidden />}
        label={t("overview.workspaces")}
        value={data.workspaces.toLocaleString()}
        hint={plans || undefined}
      />
      <Stat
        icon={<Ban aria-hidden />}
        label={t("overview.suspended")}
        value={data.suspended_workspaces.toLocaleString()}
      />
      <Stat
        icon={<Activity aria-hidden />}
        label={t("overview.runs")}
        value={data.executions_30d.toLocaleString()}
        hint={t("overview.runs24h", { count: data.executions_24h })}
      />
      <Stat
        icon={<CircleDollarSign aria-hidden />}
        label={t("overview.spend")}
        value={spend}
        hint={t("overview.billing", { provider: providerLabel })}
      />
    </motion.div>
  );
}
