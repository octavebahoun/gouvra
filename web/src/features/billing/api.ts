import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";
import { API_BASE } from "@/lib/api/http";

export type Billing = Schemas["BillingOut"];
export type PlanInfo = Schemas["PlanOut"];
export type Budget = Schemas["BudgetOut"];
export type AlertInfo = Schemas["AlertOut"];
export type PaidPlan = Schemas["CheckoutIn"]["plan"];

export const billingKeys = {
  billing: (workspaceId: string) => ["workspaces", workspaceId, "billing"] as const,
  budget: (workspaceId: string) => ["workspaces", workspaceId, "budget"] as const,
  alerts: (workspaceId: string) => ["workspaces", workspaceId, "alerts"] as const,
};

/**
 * The workspace's plan and usage. With `poll` (back from a payment page), it refreshes every
 * two seconds while the workspace is still on Free: Stripe's event arrives within seconds.
 */
export function useBilling(workspaceId: string, { enabled = true, poll = false } = {}) {
  return useQuery({
    queryKey: billingKeys.billing(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/billing", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    enabled,
    refetchInterval: (query) =>
      poll && query.state.data?.plan.key === "free" && query.state.dataUpdateCount < 20
        ? 2000
        : false,
  });
}

export function useCheckout(workspaceId: string) {
  return useMutation({
    mutationFn: (plan: PaidPlan) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/billing/checkout", {
          params: { path: { workspace_id: workspaceId } },
          body: { plan },
        }),
      ),
  });
}

export function usePortal(workspaceId: string) {
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/billing/portal", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
  });
}

export function useSimulatedConfirm(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["SimulatedConfirmIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/billing/simulated/confirm", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: (billing) => queryClient.setQueryData(billingKeys.billing(workspaceId), billing),
  });
}

export function useSimulatedCancel(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/billing/simulated/cancel", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    onSuccess: (billing) => queryClient.setQueryData(billingKeys.billing(workspaceId), billing),
  });
}

export function useBudget(workspaceId: string) {
  return useQuery({
    queryKey: billingKeys.budget(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/budget", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    refetchInterval: 60_000,
  });
}

export function useSetBudget(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["BudgetIn"]) =>
      unwrap(
        client.PUT("/api/v1/workspaces/{workspace_id}/budget", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: (budget) => {
      queryClient.setQueryData(billingKeys.budget(workspaceId), budget);
      void queryClient.invalidateQueries({ queryKey: billingKeys.alerts(workspaceId) });
    },
  });
}

export function useAlerts(workspaceId: string) {
  return useQuery({
    queryKey: billingKeys.alerts(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/alerts", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    refetchInterval: 60_000,
  });
}

export function useDismissAlert(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alertId: string) =>
      unwrap(
        client.POST("/api/v1/alerts/{alert_id}/dismiss", {
          params: { path: { alert_id: alertId } },
        }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: billingKeys.alerts(workspaceId) }),
  });
}

/** Downloads are plain links: the browser streams them with the session cookie. */
export function exportUrl(
  workspaceId: string,
  kind: "configuration" | "executions.csv" | "usage.csv",
) {
  return `${API_BASE}/workspaces/${workspaceId}/exports/${kind}`;
}
