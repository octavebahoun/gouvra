import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Connector = Schemas["ConnectorOut"];
export type Connection = Schemas["ConnectionOut"];

export const connectorKeys = {
  library: ["connectors"] as const,
  list: (workspaceId: string) => ["workspaces", workspaceId, "connections"] as const,
};

export function useConnectorLibrary() {
  return useQuery({
    queryKey: connectorKeys.library,
    queryFn: () => unwrap(client.GET("/api/v1/connectors")),
    staleTime: Infinity,
  });
}

export function useConnections(workspaceId: string) {
  return useQuery({
    queryKey: connectorKeys.list(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/connections", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
  });
}

function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: connectorKeys.list(workspaceId) });
    // Connections create and archive tools.
    void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "tools"] });
    void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "registry"] });
  };
}

export function useCreateConnection(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["ConnectionCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/connections", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: invalidate,
  });
}

export function useUpdateConnection(workspaceId: string, id: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["ConnectionUpdateIn"]) =>
      unwrap(
        client.PATCH("/api/v1/connections/{connection_id}", {
          params: { path: { connection_id: id } },
          body,
        }),
      ),
    onSuccess: invalidate,
  });
}

export function useRemoveConnection(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.DELETE("/api/v1/connections/{connection_id}", {
          params: { path: { connection_id: id } },
        }),
      ),
    onSuccess: invalidate,
  });
}

export function useCheckConnection(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/connections/{connection_id}/check", {
          params: { path: { connection_id: id } },
        }),
      ),
    onSuccess: invalidate,
  });
}
