import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Provider = Schemas["ProviderOut"];
export type ProviderKind = Schemas["ProviderKindOut"];
export type ProviderKindId = Schemas["ProviderCreateIn"]["kind"];
export type ModelInfo = Schemas["ModelInfoOut"];
export type ConnectionTest = Schemas["ConnectionTestOut"];

export const providerKeys = {
  kinds: ["providers", "kinds"] as const,
  list: (workspaceId: string) => ["workspaces", workspaceId, "providers"] as const,
  detail: (providerId: string) => ["providers", providerId] as const,
};

/** The catalogue of supported provider kinds, with their models and published prices. */
export function useProviderKinds() {
  return useQuery({
    queryKey: providerKeys.kinds,
    queryFn: () => unwrap(client.GET("/api/v1/providers/kinds")),
    staleTime: Infinity,
  });
}

export function useProviders(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: providerKeys.list(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/providers", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    enabled,
  });
}

function useReplaceInList(workspaceId: string) {
  const queryClient = useQueryClient();
  return (provider: Provider) => {
    queryClient.setQueryData<Provider[]>(providerKeys.list(workspaceId), (list) =>
      list ? list.map((p) => (p.id === provider.id ? provider : p)) : list,
    );
    queryClient.setQueryData(providerKeys.detail(provider.id), provider);
  };
}

export function useCreateProvider(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ProviderCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/providers", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: (provider) => {
      queryClient.setQueryData<Provider[]>(providerKeys.list(workspaceId), (list) =>
        list ? [...list, provider] : list,
      );
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "onboarding"] });
    },
  });
}

export function useUpdateProvider(workspaceId: string) {
  const replace = useReplaceInList(workspaceId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["ProviderUpdateIn"] }) =>
      unwrap(
        client.PATCH("/api/v1/providers/{provider_id}", {
          params: { path: { provider_id: id } },
          body,
        }),
      ),
    onSuccess: replace,
  });
}

export function useDeleteProvider(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.DELETE("/api/v1/providers/{provider_id}", {
          params: { path: { provider_id: id } },
        }),
      ),
    onSuccess: (_, id) => {
      queryClient.setQueryData<Provider[]>(providerKeys.list(workspaceId), (list) =>
        list ? list.filter((p) => p.id !== id) : list,
      );
    },
  });
}

/** Test the connection; the provider's status, latency and model list refresh afterwards. */
export function useTestProvider(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/providers/{provider_id}/test", {
          params: { path: { provider_id: id } },
        }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: providerKeys.list(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "onboarding"] });
    },
  });
}

export type ModelChoice = { id: string; info: ModelInfo | null };

/**
 * Models offered for a provider: the catalogue of its kind (with capabilities and prices), then
 * any other model its API reported — shown without capabilities rather than with guessed ones.
 */
export function modelChoices(kind: ProviderKind | undefined, provider?: Provider): ModelChoice[] {
  const catalogue = (kind?.models ?? []).map((info) => ({ id: info.id, info }));
  const known = new Set(catalogue.map((m) => m.id));
  const reported = (provider?.models ?? [])
    .filter((id) => !known.has(id))
    .map((id) => ({ id, info: null }));
  return [...catalogue, ...reported];
}
