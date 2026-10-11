import { CreditCard, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { useFormatters } from "@/lib/format";
import { SettingsSection } from "@/components/layout/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { ErrorState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  useBilling,
  useCheckout,
  usePortal,
  useSimulatedCancel,
  type Billing,
  type PaidPlan,
} from "./api";
import { PlanCards } from "./plan-cards";
import { UsageMeter } from "./usage-meter";

const STATUS_TONES: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  active: "success",
  trialing: "success",
  past_due: "warning",
  canceled: "neutral",
  incomplete: "warning",
  unpaid: "danger",
};

/** Settings → Billing: the plan, what this month used, and how to change plan. */
export function BillingTab() {
  const { t } = useTranslation("billing");
  const { workspace } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const [polling] = useState(() => params.get("checkout") === "success");
  const [since] = useState(() => Date.now());
  const billing = useBilling(workspace.id, { poll: polling });

  // Back from the payment page: say so once, then clean the address. The plan itself changes
  // when Stripe's (verified) event arrives — usually within seconds — never on the redirect.
  useEffect(() => {
    const returned = params.get("checkout");
    if (!returned) return;
    if (returned === "success") toast.success(t("checkout.success"));
    else toast(t("checkout.cancelled"));
    setParams({}, { replace: true });
  }, [params, setParams, t]);

  // …and when it does, say so.
  const planKey = billing.data?.plan.key;
  const planName = billing.data?.plan.name;
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!polling || !planKey) return;
    if (seen.current && seen.current !== planKey) {
      toast.success(t("checkout.active", { plan: planName ?? planKey }));
    }
    seen.current = planKey;
  }, [polling, planKey, planName, t]);

  if (billing.isPending) return <Skeleton className="h-96 rounded-card" />;
  if (billing.isError) {
    return (
      <Card>
        <ErrorState error={billing.error} onRetry={() => void billing.refetch()} />
      </Card>
    );
  }
  if (!billing.data.enabled) {
    return (
      <Card className="p-6">
        <h2 className="text-[15px] font-semibold text-ink">{t("disabled.title")}</h2>
        <p className="mt-1 text-[13px] text-muted">{t("disabled.body")}</p>
      </Card>
    );
  }
  return (
    <BillingDetails
      billing={billing.data}
      waiting={
        polling && billing.data.plan.key === "free" && billing.dataUpdatedAt - since < 40_000
      }
    />
  );
}

function BillingDetails({ billing, waiting }: { billing: Billing; waiting: boolean }) {
  const { t } = useTranslation("billing");
  const { workspace } = useCurrentWorkspace();
  const { date } = useFormatters();
  const checkout = useCheckout(workspace.id);
  const portal = usePortal(workspace.id);
  const cancel = useSimulatedCancel(workspace.id);
  const [pending, setPending] = useState<string | null>(null);
  const subscription = billing.subscription;
  const status = subscription?.status ?? "active";

  function upgrade(plan: PaidPlan) {
    setPending(plan);
    checkout.mutate(plan, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (error) => {
        setPending(null);
        toast.error(error.message);
      },
    });
  }

  function manage() {
    if (billing.provider === "simulated") {
      cancel.mutate(undefined, {
        onSuccess: () => toast.success(t("current.cancelScheduled")),
        onError: (error) => toast.error(error.message),
      });
      return;
    }
    portal.mutate(undefined, {
      onSuccess: ({ url }) => window.location.assign(url),
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <div className="space-y-8">
      {billing.test_mode ? (
        <Alert
          tone="info"
          title={t(billing.provider === "stripe" ? "testMode.stripe" : "testMode.simulated")}
        >
          {billing.provider === "stripe" ? t("testMode.card") : t("testMode.simulatedBody")}
        </Alert>
      ) : null}
      <SettingsSection id="plan" title={t("current.title")} description={t("current.description")}>
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[20px] font-semibold text-ink">{billing.plan.name}</span>
                <Badge tone={STATUS_TONES[status] ?? "neutral"}>
                  {t(`status.${status}`, { defaultValue: status })}
                </Badge>
                {subscription?.granted_by_admin ? (
                  <Badge tone="outline">{t("current.granted")}</Badge>
                ) : null}
                {waiting ? <Badge tone="brand">{t("checkout.waiting")}</Badge> : null}
              </div>
              <p className="mt-1 text-[13px] text-muted">
                {subscription?.current_period_end
                  ? t(subscription.cancel_at_period_end ? "current.endsOn" : "current.renewsOn", {
                      date: date(subscription.current_period_end),
                    })
                  : t("current.free")}
              </p>
            </div>
            {billing.can_manage &&
            billing.provider === "stripe" &&
            subscription?.provider === "stripe" ? (
              <Button
                variant="secondary"
                leftIcon={<CreditCard aria-hidden />}
                loading={portal.isPending}
                onClick={manage}
              >
                {t("current.manage")}
                <ExternalLink aria-hidden className="ml-1 size-3.5" />
              </Button>
            ) : null}
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <UsageMeter
              label={t("meter.runs")}
              used={billing.usage.executions}
              limit={billing.plan.executions_per_month}
            />
            <UsageMeter
              label={t("meter.agents")}
              used={billing.usage.agents}
              limit={billing.plan.agents}
            />
            <UsageMeter
              label={t("meter.members")}
              used={billing.usage.members}
              limit={billing.plan.members}
            />
            <UsageMeter
              label={t("meter.automations")}
              used={billing.usage.automations}
              limit={billing.plan.automations}
            />
          </div>
          <p className="mt-4 text-[12px] text-muted">
            {t("meter.period", {
              start: date(billing.usage.period_start),
              end: date(billing.usage.period_end),
            })}
          </p>
        </Card>
      </SettingsSection>
      <SettingsSection id="plans" title={t("plans.title")} description={t("plans.description")}>
        <PlanCards billing={billing} pending={pending} onUpgrade={upgrade} onManage={manage} />
        {!billing.can_manage ? (
          <p className="mt-3 text-[13px] text-muted">{t("plans.ownerOnly")}</p>
        ) : null}
      </SettingsSection>
    </div>
  );
}
