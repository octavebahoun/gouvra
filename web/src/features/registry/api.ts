import { useQuery } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Registry = Schemas["RegistryOut"];
export type RegistryModel = Schemas["RegistryModelOut"];
export type RegistryTool = Schemas["RegistryToolOut"];

export function useRegistry(workspaceId: string) {
  return useQuery({
    queryKey: ["workspaces", workspaceId, "registry"],
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/registry", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
  });
}
