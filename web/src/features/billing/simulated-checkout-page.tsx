import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useBilling, useSimulatedConfirm, type PaidPlan } from "./api";

/** The payment page of instances without a payment provider: no card, no charge, 30 days. */
export function SimulatedCheckoutPage() {
  const { t } = useTranslation("billing");
  const { workspace, basePath } = useCurrentWorkspace();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const planKey = params.get("plan") as PaidPlan | null;
  const token = params.get("token") ?? "";
  const billing = useBilling(workspace.id);
  const confirm = useSimulatedConfirm(workspace.id);
  useDocumentTitle(t("simulated.title"));
  const plan = billing.data?.plans.find((p) => p.key === planKey);

  return (
    <PageContainer>
      <PageHeader
        breadcrumbs={[
          { label: t("title"), to: `${basePath}/settings/billing` },
          { label: t("simulated.title") },
        ]}
        title={t("simulated.title")}
        description={t("simulated.description")}
      />
      {billing.isPending ? (
        <Skeleton className="h-56 rounded-card" />
      ) : !plan || !planKey ? (
        <Alert tone="danger" title={t("simulated.invalid")} />
      ) : (
        <Card className="max-w-lg p-6">
          <p className="text-[13px] text-muted">
            {t("simulated.subscribing", { workspace: workspace.name })}
          </p>
          <p className="mt-2 text-[22px] font-semibold text-ink">
            {t("simulated.plan", {
              plan: plan.name,
              price: Number(plan.price_monthly).toLocaleString(),
            })}
          </p>
          <Alert tone="info" title={t("simulated.noCharge")} className="mt-4" />
          {confirm.error ? <FormProblemAlert error={confirm.error} /> : null}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              leftIcon={<ShieldCheck aria-hidden />}
              loading={confirm.isPending}
              onClick={() =>
                confirm.mutate(
                  { plan: planKey, token },
                  {
                    onSuccess: () => {
                      toast.success(t("checkout.active", { plan: plan.name }));
                      void navigate(`${basePath}/settings/billing`);
                    },
                  },
                )
              }
            >
              {t("simulated.confirm")}
            </Button>
            <Button asChild variant="secondary">
              <Link to={`${basePath}/settings/billing`}>{t("simulated.back")}</Link>
            </Button>
          </div>
        </Card>
      )}
    </PageContainer>
  );
}
