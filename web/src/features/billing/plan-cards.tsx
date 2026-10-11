import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Billing, PaidPlan, PlanInfo } from "./api";

type Props = {
  billing: Billing;
  pending: string | null;
  onUpgrade: (plan: PaidPlan) => void;
  onManage: () => void;
};

function money(value: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function Feature({ children }: { children: string }) {
  return (
    <li className="flex gap-2 text-[13px] text-ink">
      <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success-text" />
      {children}
    </li>
  );
}

/** The plans side by side: what each allows, and the one action that makes sense from here. */
export function PlanCards({ billing, pending, onUpgrade, onManage }: Props) {
  const { t } = useTranslation("billing");
  const current = billing.plan.key;
  const stripeSubscription =
    billing.provider === "stripe" &&
    billing.subscription?.provider === "stripe" &&
    current !== "free";

  function action(plan: PlanInfo) {
    if (!billing.can_manage) return null;
    if (plan.key === current) {
      return (
        <Button variant="secondary" disabled className="w-full">
          {t("plans.current")}
        </Button>
      );
    }
    if (!plan.paid) {
      return (
        <Button variant="tertiary" className="w-full" onClick={onManage}>
          {t(billing.provider === "stripe" ? "plans.downgradePortal" : "plans.downgrade")}
        </Button>
      );
    }
    if (stripeSubscription) {
      return (
        <Button variant="secondary" className="w-full" onClick={onManage}>
          {t("plans.changePortal")}
        </Button>
      );
    }
    return (
      <Button
        className="w-full"
        loading={pending === plan.key}
        onClick={() => onUpgrade(plan.key as PaidPlan)}
      >
        {t("plans.upgrade", { plan: plan.name })}
      </Button>
    );
  }

  return (
    <ul className="grid gap-3 md:grid-cols-3">
      {billing.plans.map((plan) => {
        const features = [
          plan.executions_per_month
            ? t("plans.features.runs", { count: plan.executions_per_month })
            : t("plans.features.runsUnlimited"),
          plan.agents
            ? t("plans.features.agents", { count: plan.agents })
            : t("plans.features.agentsUnlimited"),
          plan.members
            ? t("plans.features.members", { count: plan.members })
            : t("plans.features.membersUnlimited"),
          plan.automations
            ? t("plans.features.automations", { count: plan.automations })
            : t("plans.features.automationsUnlimited"),
          t("plans.features.concurrency", { count: plan.concurrency }),
          t("plans.features.retention", { count: plan.retention_days_max }),
        ];
        return (
          <li
            key={plan.key}
            className={cn(
              "flex flex-col rounded-card border bg-surface p-5 shadow-sm",
              plan.key === current ? "border-brand shadow-[var(--gv-glow-brand)]" : "border-line",
            )}
          >
            <div className="flex min-h-6 items-center justify-between gap-2">
              <h3 className="text-[15px] font-semibold text-ink">{plan.name}</h3>
              {plan.key === current ? <Badge tone="brand">{t("plans.yours")}</Badge> : null}
            </div>
            <p className="mt-2 text-[26px] leading-none font-semibold text-ink">
              {money(plan.price_monthly)}
              <span className="ml-1 text-[13px] font-normal text-muted">{t("plans.perMonth")}</span>
            </p>
            <ul className="mt-4 space-y-2">
              {features.map((feature) => (
                <Feature key={feature}>{feature}</Feature>
              ))}
            </ul>
            <div className="mt-auto pt-5">{action(plan)}</div>
          </li>
        );
      })}
    </ul>
  );
}
