import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Automation = Schemas["AutomationOut"];
export type AutomationCreated = Schemas["AutomationCreatedOut"];
export type AutomationCreate = Schemas["AutomationCreateIn"];
export type AutomationUpdate = Schemas["AutomationUpdateIn"];
export type Fire = Schemas["FireOut"];
export type FireStatus = Fire["status"];

export const automationKeys = {
  list: (workspaceId: string) => ["workspaces", workspaceId, "automations"] as const,
  detail: (id: string) => ["automations", id] as const,
  fires: (id: string) => ["automations", id, "fires"] as const,
  preview: (cron: string, timezone: string) => ["automations", "cron", cron, timezone] as const,
};

export function useAutomations(workspaceId: string) {
  return useQuery({
    queryKey: automationKeys.list(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/automations", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
    refetchInterval: 30_000,
  });
}

export function useAutomation(id: string) {
  return useQuery({
    queryKey: automationKeys.detail(id),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/automations/{automation_id}", {
          params: { path: { automation_id: id } },
        }),
      ),
    refetchInterval: 15_000,
  });
}

/** Deliveries and ticks: refreshed often while the page is open, they arrive on their own. */
export function useFires(id: string) {
  return useQuery({
    queryKey: automationKeys.fires(id),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/automations/{automation_id}/fires", {
          params: { path: { automation_id: id }, query: { limit: 50 } },
        }),
      ),
    select: (page) => page.data,
    refetchInterval: 4_000,
  });
}

export function useCronPreview(cron: string, timezone: string, enabled: boolean) {
  return useQuery({
    queryKey: automationKeys.preview(cron, timezone),
    queryFn: () =>
      unwrap(client.POST("/api/v1/automations/cron-preview", { body: { cron, timezone } })),
    enabled: enabled && cron.trim().length > 0,
    staleTime: 30_000,
  });
}

function useInvalidate(workspaceId: string) {
  const queryClient = useQueryClient();
  return (id?: string) => {
    void queryClient.invalidateQueries({ queryKey: automationKeys.list(workspaceId) });
    if (id) {
      void queryClient.invalidateQueries({ queryKey: automationKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: automationKeys.fires(id) });
    }
  };
}

export function useCreateAutomation(workspaceId: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (body: AutomationCreate) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/automations", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAutomation(workspaceId: string, id: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (body: AutomationUpdate) =>
      unwrap(
        client.PATCH("/api/v1/automations/{automation_id}", {
          params: { path: { automation_id: id } },
          body,
        }),
      ),
    onSuccess: (automation) => {
      queryClient.setQueryData(automationKeys.detail(id), automation);
      invalidate();
    },
  });
}

export function useDeleteAutomation(workspaceId: string, id: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.DELETE("/api/v1/automations/{automation_id}", {
          params: { path: { automation_id: id } },
        }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useRotateSecret(workspaceId: string, id: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/api/v1/automations/{automation_id}/rotate-secret", {
          params: { path: { automation_id: id } },
        }),
      ),
    onSuccess: () => invalidate(id),
  });
}

export function useRunAutomation(workspaceId: string, id: string) {
  const invalidate = useInvalidate(workspaceId);
  return useMutation({
    mutationFn: (input: string | Record<string, unknown> | null) =>
      unwrap(
        client.POST("/api/v1/automations/{automation_id}/run", {
          params: { path: { automation_id: id } },
          body: { input },
        }),
      ),
    onSuccess: () => invalidate(id),
  });
}
