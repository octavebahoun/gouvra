import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type InstanceOverview = Schemas["InstanceOverviewOut"];
export type AdminWorkspace = Schemas["AdminWorkspaceOut"];
export type AdminUser = Schemas["AdminUserOut"];
export type AdminAuditEvent = Schemas["AdminAuditOut"];

const AUDIT_PAGE_SIZE = 50;

export const adminKeys = {
  all: ["admin"] as const,
  overview: () => ["admin", "overview"] as const,
  workspaces: (q: string) => ["admin", "workspaces", q] as const,
  users: (q: string) => ["admin", "users", q] as const,
  audit: () => ["admin", "audit"] as const,
};

export function useInstanceOverview() {
  return useQuery({
    queryKey: adminKeys.overview(),
    queryFn: () => unwrap(client.GET("/api/v1/admin/overview")),
    refetchInterval: 30_000,
  });
}

export function useAdminWorkspaces(q: string) {
  return useQuery({
    queryKey: adminKeys.workspaces(q),
    queryFn: () =>
      unwrap(client.GET("/api/v1/admin/workspaces", { params: { query: { q: q || undefined } } })),
    placeholderData: keepPreviousData,
  });
}

export function useUpdateAdminWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Schemas["AdminWorkspaceIn"]) =>
      unwrap(
        client.PATCH("/api/v1/admin/workspaces/{workspace_id}", {
          params: { path: { workspace_id: id } },
          body,
        }),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export function useAdminUsers(q: string) {
  return useQuery({
    queryKey: adminKeys.users(q),
    queryFn: () =>
      unwrap(client.GET("/api/v1/admin/users", { params: { query: { q: q || undefined } } })),
    placeholderData: keepPreviousData,
  });
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Schemas["AdminUserIn"]) =>
      unwrap(
        client.PATCH("/api/v1/admin/users/{user_id}", {
          params: { path: { user_id: id } },
          body,
        }),
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: adminKeys.all }),
  });
}

export function useAdminAudit() {
  return useInfiniteQuery({
    queryKey: adminKeys.audit(),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/api/v1/admin/audit-events", {
          params: { query: { limit: AUDIT_PAGE_SIZE, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more && page.next_cursor ? page.next_cursor : undefined),
  });
}
