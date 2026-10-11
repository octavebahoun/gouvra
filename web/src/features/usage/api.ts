import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Overview = Schemas["OverviewOut"];
export type Usage = Schemas["UsageReportOut"];
export type UsagePeriod = "24h" | "7d" | "30d" | "90d";

export const usageKeys = {
  overview: (workspaceId: string) => ["workspaces", workspaceId, "overview"] as const,
  usage: (workspaceId: string, period: UsagePeriod) =>
    ["workspaces", workspaceId, "usage", period] as const,
};

const PERIODS: Record<UsagePeriod, { hours: number; granularity: "hour" | "day" | "week" }> = {
  "24h": { hours: 24, granularity: "hour" },
  "7d": { hours: 24 * 7, granularity: "day" },
  "30d": { hours: 24 * 30, granularity: "day" },
  "90d": { hours: 24 * 90, granularity: "week" },
};

export function useOverview(workspaceId: string) {
  return useQuery({
    queryKey: usageKeys.overview(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/overview", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    refetchInterval: 60_000,
  });
}

export function useUsage(workspaceId: string, period: UsagePeriod) {
  return useQuery({
    queryKey: usageKeys.usage(workspaceId, period),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/usage", {
          params: {
            path: { workspace_id: workspaceId },
            query: {
              since: new Date(Date.now() - PERIODS[period].hours * 3600_000).toISOString(),
              granularity: PERIODS[period].granularity,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

export function granularityOf(period: UsagePeriod) {
  return PERIODS[period].granularity;
}
