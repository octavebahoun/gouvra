import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";
import { agentKeys } from "@/features/agents/api";

export type Execution = Schemas["ExecutionOut"];
export type ExecutionSummary = Schemas["ExecutionSummary"];
export type ExecutionEvent = Schemas["ExecutionEventOut"];
export type ExecutionStatus = Execution["status"];
export type CostSource = Schemas["CostOut"]["source"];

export const TERMINAL: readonly ExecutionStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
];
export const isTerminalStatus = (status: ExecutionStatus) => TERMINAL.includes(status);

export type ExecutionFilters = {
  q: string;
  status: ExecutionStatus | null;
  agentId: string | null;
  trigger: string | null;
  period: "all" | "24h" | "7d" | "30d";
};

export const executionKeys = {
  all: (workspaceId: string) => ["workspaces", workspaceId, "executions"] as const,
  list: (workspaceId: string, filters: ExecutionFilters) =>
    ["workspaces", workspaceId, "executions", "list", filters] as const,
  detail: (executionId: string) => ["executions", executionId] as const,
  events: (executionId: string) => ["executions", executionId, "events"] as const,
};

const PERIOD_HOURS = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 } as const;

export function useExecutions(workspaceId: string, filters: ExecutionFilters, limit = 30) {
  return useInfiniteQuery({
    queryKey: [...executionKeys.list(workspaceId, filters), limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/executions", {
          params: {
            path: { workspace_id: workspaceId },
            query: {
              q: filters.q || null,
              status: filters.status ? [filters.status] : null,
              agent_id: filters.agentId,
              trigger: filters.trigger ? [filters.trigger] : null,
              since:
                filters.period === "all"
                  ? null
                  : new Date(Date.now() - PERIOD_HOURS[filters.period] * 3600_000).toISOString(),
              limit,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => (page.has_more ? page.next_cursor : null),
    placeholderData: keepPreviousData,
  });
}

export function useExecution(executionId: string) {
  return useQuery({
    queryKey: executionKeys.detail(executionId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/executions/{execution_id}", {
          params: { path: { execution_id: executionId } },
        }),
      ),
  });
}

/** The full recorded trace of a finished execution (pages of 500 events). */
export async function fetchAllEvents(executionId: string, after = 0): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  let cursor = after;
  for (let page = 0; page < 20; page += 1) {
    const result = await unwrap(
      client.GET("/api/v1/executions/{execution_id}/events", {
        params: { path: { execution_id: executionId }, query: { after: cursor, limit: 500 } },
      }),
    );
    events.push(...result.data);
    if (!result.has_more || result.next_after === null) break;
    cursor = result.next_after;
  }
  return events;
}

export function useLaunchExecution(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentId,
      body,
      idempotencyKey,
    }: {
      agentId: string;
      body: Schemas["ExecutionLaunchIn"];
      idempotencyKey: string;
    }) =>
      unwrap(
        client.POST("/api/v1/agents/{agent_id}/executions", {
          params: { path: { agent_id: agentId }, header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: (execution) => {
      queryClient.setQueryData(executionKeys.detail(execution.id), execution);
      void queryClient.invalidateQueries({ queryKey: executionKeys.all(workspaceId) });
      if (execution.agent) {
        void queryClient.invalidateQueries({ queryKey: agentKeys.detail(execution.agent.id) });
      }
    },
  });
}

export function useCancelExecution(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/executions/{execution_id}/cancel", {
          params: { path: { execution_id: id } },
        }),
      ),
    onSuccess: (execution) => {
      queryClient.setQueryData(executionKeys.detail(execution.id), execution);
      void queryClient.invalidateQueries({ queryKey: executionKeys.all(workspaceId) });
    },
  });
}

export function useRetryExecution(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/executions/{execution_id}/retry", {
          params: { path: { execution_id: id } },
        }),
      ),
    onSuccess: (execution) => {
      queryClient.setQueryData(executionKeys.detail(execution.id), execution);
      void queryClient.invalidateQueries({ queryKey: executionKeys.all(workspaceId) });
    },
  });
}
