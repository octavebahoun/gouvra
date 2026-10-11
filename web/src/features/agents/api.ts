import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Agent = Schemas["AgentOut"];
export type AgentVersion = Schemas["AgentVersionOut"];
export type AgentStats = Schemas["AgentStatsOut"];
export type AgentParameters = Schemas["AgentParameters-Output"];
export type AgentLimits = Schemas["AgentLimits-Output"];
export type AgentStatusFilter = "active" | "archived" | "all";

export type AgentFilters = { q: string; status: AgentStatusFilter; providerId: string | null };

export const agentKeys = {
  all: (workspaceId: string) => ["workspaces", workspaceId, "agents"] as const,
  list: (workspaceId: string, filters: AgentFilters) =>
    ["workspaces", workspaceId, "agents", "list", filters] as const,
  options: (workspaceId: string) => ["workspaces", workspaceId, "agents", "options"] as const,
  detail: (agentId: string) => ["agents", agentId] as const,
  versions: (agentId: string) => ["agents", agentId, "versions"] as const,
  stats: (agentId: string, days: number) => ["agents", agentId, "stats", days] as const,
};

export function useAgents(workspaceId: string, filters: AgentFilters) {
  return useInfiniteQuery({
    queryKey: agentKeys.list(workspaceId, filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/agents", {
          params: {
            path: { workspace_id: workspaceId },
            query: {
              q: filters.q || null,
              status: filters.status,
              provider_id: filters.providerId,
              limit: 25,
              cursor: pageParam,
            },
          },
        }),
      ),
    getNextPageParam: (page) => (page.has_more ? page.next_cursor : null),
    placeholderData: keepPreviousData,
  });
}

/** Every active agent, for pickers and filters (names only matter). */
export function useAgentOptions(workspaceId: string) {
  return useQuery({
    queryKey: agentKeys.options(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/agents", {
          params: { path: { workspace_id: workspaceId }, query: { status: "all", limit: 100 } },
        }),
      ),
    select: (page) => page.data,
    staleTime: 30_000,
  });
}

export function useAgent(agentId: string, enabled = true) {
  return useQuery({
    queryKey: agentKeys.detail(agentId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/agents/{agent_id}", { params: { path: { agent_id: agentId } } })),
    enabled: enabled && agentId !== "",
  });
}

export function useAgentVersions(agentId: string, enabled = true) {
  return useQuery({
    queryKey: agentKeys.versions(agentId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/agents/{agent_id}/versions", {
          params: { path: { agent_id: agentId } },
        }),
      ),
    enabled,
  });
}

export function useAgentStats(agentId: string, days = 30) {
  return useQuery({
    queryKey: agentKeys.stats(agentId, days),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/agents/{agent_id}/stats", {
          params: { path: { agent_id: agentId }, query: { days } },
        }),
      ),
  });
}

/** After any change: the agent itself, its lists, versions and the onboarding checklist. */
function useAgentSync(workspaceId: string) {
  const queryClient = useQueryClient();
  return (agent: Agent) => {
    queryClient.setQueryData(agentKeys.detail(agent.id), agent);
    void queryClient.invalidateQueries({ queryKey: agentKeys.all(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: agentKeys.versions(agent.id) });
    void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "onboarding"] });
  };
}

export function useCreateAgent(workspaceId: string) {
  const sync = useAgentSync(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["AgentCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/agents", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: sync,
  });
}

export function useUpdateAgent(workspaceId: string) {
  const sync = useAgentSync(workspaceId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["AgentUpdateIn"] }) =>
      unwrap(
        client.PATCH("/api/v1/agents/{agent_id}", { params: { path: { agent_id: id } }, body }),
      ),
    onSuccess: sync,
  });
}

export function useDuplicateAgent(workspaceId: string) {
  const sync = useAgentSync(workspaceId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/agents/{agent_id}/duplicate", {
          params: { path: { agent_id: id } },
          body: {},
        }),
      ),
    onSuccess: sync,
  });
}

export function useSetArchived(workspaceId: string) {
  const sync = useAgentSync(workspaceId);
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      unwrap(
        archived
          ? client.POST("/api/v1/agents/{agent_id}/archive", { params: { path: { agent_id: id } } })
          : client.POST("/api/v1/agents/{agent_id}/restore", {
              params: { path: { agent_id: id } },
            }),
      ),
    onSuccess: sync,
  });
}

export function useDeleteAgent(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(client.DELETE("/api/v1/agents/{agent_id}", { params: { path: { agent_id: id } } })),
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: agentKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: agentKeys.all(workspaceId) });
    },
  });
}

export function useRestoreVersion(workspaceId: string) {
  const sync = useAgentSync(workspaceId);
  return useMutation({
    mutationFn: ({ id, number }: { id: string; number: number }) =>
      unwrap(
        client.POST("/api/v1/agents/{agent_id}/versions/{number}/restore", {
          params: { path: { agent_id: id, number } },
        }),
      ),
    onSuccess: sync,
  });
}
