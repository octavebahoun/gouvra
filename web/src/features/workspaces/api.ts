import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";
import { authKeys } from "@/lib/auth/session";
import type { Session, WorkspaceSummary } from "@/lib/auth/types";

export type Workspace = Schemas["WorkspaceOut"];
export type Member = Schemas["MemberOut"];
export type Invitation = Schemas["InvitationOut"];
export type InvitationPreview = Schemas["InvitationPreviewOut"];
export type ApiKey = Schemas["ApiKeyOut"];
export type ApiKeyCreated = Schemas["ApiKeyCreated"];
export type Onboarding = Schemas["OnboardingOut"];
export type WorkspaceSettings = Schemas["WorkspaceSettingsOut"];
export type AuditEvent = Schemas["AuditEventOut"];

/** Every workspace query key lives here, so invalidations stay consistent. */
export const workspaceKeys = {
  all: ["workspaces"] as const,
  detail: (id: string) => ["workspaces", id] as const,
  members: (id: string) => ["workspaces", id, "members"] as const,
  invitations: (id: string) => ["workspaces", id, "invitations"] as const,
  apiKeys: (id: string) => ["workspaces", id, "api-keys"] as const,
  onboarding: (id: string) => ["workspaces", id, "onboarding"] as const,
  settings: (id: string) => ["workspaces", id, "settings"] as const,
  audit: (id: string, action: string | null) =>
    ["workspaces", id, "audit", action ?? "all"] as const,
};

const path = (workspaceId: string) => ({ params: { path: { workspace_id: workspaceId } } });

// ---------------------------------------------------------------- session cache helpers

/** Keep the session's workspace list (used by the switcher and routing) in step at once. */
function upsertSummary(queryClient: QueryClient, workspace: Workspace): void {
  const summary: WorkspaceSummary = {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role: workspace.role,
    is_demo: workspace.is_demo,
  };
  queryClient.setQueryData<Session | null>(authKeys.session, (session) =>
    session
      ? {
          ...session,
          workspaces: [...session.workspaces.filter((w) => w.id !== workspace.id), summary].sort(
            (a, b) => a.name.localeCompare(b.name),
          ),
        }
      : session,
  );
}

/** Remove a workspace you left or deleted from the session (call once you've navigated away). */
export function forgetWorkspace(queryClient: QueryClient, workspaceId: string): void {
  queryClient.setQueryData<Session | null>(authKeys.session, (session) =>
    session
      ? { ...session, workspaces: session.workspaces.filter((w) => w.id !== workspaceId) }
      : session,
  );
  queryClient.removeQueries({ queryKey: workspaceKeys.detail(workspaceId) });
}

export const refreshSession = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: authKeys.session });

// ---------------------------------------------------------------- queries

export function useWorkspace(workspaceId: string | undefined) {
  return useQuery({
    queryKey: workspaceKeys.detail(workspaceId ?? ""),
    queryFn: () => unwrap(client.GET("/api/v1/workspaces/{workspace_id}", path(workspaceId ?? ""))),
    enabled: Boolean(workspaceId),
  });
}

export function useMembers(workspaceId: string) {
  return useQuery({
    queryKey: workspaceKeys.members(workspaceId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workspaces/{workspace_id}/members", path(workspaceId))),
  });
}

export function useInvitations(workspaceId: string) {
  return useQuery({
    queryKey: workspaceKeys.invitations(workspaceId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workspaces/{workspace_id}/invitations", path(workspaceId))),
  });
}

export function useApiKeys(workspaceId: string, enabled: boolean) {
  return useQuery({
    queryKey: workspaceKeys.apiKeys(workspaceId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workspaces/{workspace_id}/api-keys", path(workspaceId))),
    enabled,
  });
}

export function useOnboarding(workspaceId: string) {
  return useQuery({
    queryKey: workspaceKeys.onboarding(workspaceId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workspaces/{workspace_id}/onboarding", path(workspaceId))),
  });
}

// ---------------------------------------------------------------- workspace

export const createWorkspaceKey = ["workspaces", "create"] as const;

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: createWorkspaceKey,
    mutationFn: (body: Schemas["WorkspaceCreateIn"]) =>
      unwrap(client.POST("/api/v1/workspaces", { body })),
    onSuccess: (workspace) => {
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
      upsertSummary(queryClient, workspace);
      void refreshSession(queryClient);
    },
  });
}

export function useUpdateWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["WorkspaceUpdateIn"]) =>
      unwrap(client.PATCH("/api/v1/workspaces/{workspace_id}", { ...path(workspaceId), body })),
    onSuccess: (workspace) => {
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
      upsertSummary(queryClient, workspace);
      void refreshSession(queryClient);
    },
  });
}

/** The caller navigates away first, then calls `forgetWorkspace` (no "not found" flash). */
export function useDeleteWorkspace(workspaceId: string) {
  return useMutation({
    mutationFn: (confirmName: string) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/delete", {
          ...path(workspaceId),
          body: { confirm_name: confirmName },
        }),
      ),
  });
}

export function useTransferOwnership(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/transfer-ownership", {
          ...path(workspaceId),
          body: { user_id: userId },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(workspaceId) });
      void refreshSession(queryClient);
    },
  });
}

// ---------------------------------------------------------------- members

const memberPath = (workspaceId: string, userId: string) => ({
  params: { path: { workspace_id: workspaceId, user_id: userId } },
});

/** Role changes are applied optimistically and rolled back if the API refuses them. */
export function useChangeRole(workspaceId: string) {
  const queryClient = useQueryClient();
  const key = workspaceKeys.members(workspaceId);
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Schemas["RoleUpdateIn"]["role"] }) =>
      unwrap(
        client.PATCH("/api/v1/workspaces/{workspace_id}/members/{user_id}", {
          ...memberPath(workspaceId, userId),
          body: { role },
        }),
      ),
    onMutate: async ({ userId, role }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Member[]>(key);
      queryClient.setQueryData<Member[]>(key, (members) =>
        members?.map((m) => (m.user_id === userId ? { ...m, role } : m)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useRemoveMember(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        client.DELETE(
          "/api/v1/workspaces/{workspace_id}/members/{user_id}",
          memberPath(workspaceId, userId),
        ),
      ),
    onSuccess: (_data, userId) => {
      queryClient.setQueryData<Member[]>(workspaceKeys.members(workspaceId), (members) =>
        members?.filter((m) => m.user_id !== userId),
      );
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(workspaceId) });
    },
  });
}

/**
 * Leaving = removing yourself (the owner can't: transfer ownership first). Like deletion, the
 * caller navigates away, then calls `forgetWorkspace`.
 */
export function useLeaveWorkspace(workspaceId: string) {
  return useMutation({
    mutationFn: (myUserId: string) =>
      unwrap(
        client.DELETE(
          "/api/v1/workspaces/{workspace_id}/members/{user_id}",
          memberPath(workspaceId, myUserId),
        ),
      ),
  });
}

// ---------------------------------------------------------------- invitations

const invitationPath = (workspaceId: string, invitationId: string) => ({
  params: { path: { workspace_id: workspaceId, invitation_id: invitationId } },
});

export function useInvite(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["InvitationCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/invitations", {
          ...path(workspaceId),
          body,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.onboarding(workspaceId) });
    },
  });
}

export function useResendInvitation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      unwrap(
        client.POST(
          "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}/resend",
          invitationPath(workspaceId, invitationId),
        ),
      ),
    onSuccess: (invitation) => {
      queryClient.setQueryData<Invitation[]>(workspaceKeys.invitations(workspaceId), (list) =>
        list?.map((i) => (i.id === invitation.id ? invitation : i)),
      );
    },
  });
}

export function useRevokeInvitation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) =>
      unwrap(
        client.DELETE(
          "/api/v1/workspaces/{workspace_id}/invitations/{invitation_id}",
          invitationPath(workspaceId, invitationId),
        ),
      ),
    onSuccess: (_data, invitationId) => {
      queryClient.setQueryData<Invitation[]>(workspaceKeys.invitations(workspaceId), (list) =>
        list?.filter((i) => i.id !== invitationId),
      );
    },
  });
}

/** Invitation link holders: what the link points to (no sign-in needed). */
export const previewInvitation = (token: string) =>
  unwrap(client.POST("/api/v1/invitations/preview", { body: { token } }));

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      unwrap(client.POST("/api/v1/invitations/accept", { body: { token } })),
    onSuccess: (workspace) => {
      queryClient.setQueryData(workspaceKeys.detail(workspace.id), workspace);
      upsertSummary(queryClient, workspace);
      void refreshSession(queryClient);
    },
  });
}

// ---------------------------------------------------------------- service keys

export function useCreateApiKey(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ApiKeyCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/api-keys", { ...path(workspaceId), body }),
      ),
    onSuccess: (created) => {
      // The secret never enters the cache: only the public part of the key is listed.
      const listed: ApiKey = {
        id: created.id,
        name: created.name,
        prefix: created.prefix,
        role: created.role,
        created_at: created.created_at,
        last_used_at: created.last_used_at,
        expires_at: created.expires_at,
        revoked_at: created.revoked_at,
      };
      queryClient.setQueryData<ApiKey[]>(workspaceKeys.apiKeys(workspaceId), (keys) =>
        keys ? [listed, ...keys.filter((k) => k.id !== listed.id)] : keys,
      );
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.apiKeys(workspaceId) });
    },
  });
}

export function useRevokeApiKey(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      unwrap(
        client.DELETE("/api/v1/workspaces/{workspace_id}/api-keys/{key_id}", {
          params: { path: { workspace_id: workspaceId, key_id: keyId } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workspaceKeys.apiKeys(workspaceId) }),
  });
}

// ---------------------------------------------------------------- operational settings

export function useWorkspaceSettings(workspaceId: string) {
  return useQuery({
    queryKey: workspaceKeys.settings(workspaceId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workspaces/{workspace_id}/settings", path(workspaceId))),
  });
}

export function useUpdateWorkspaceSettings(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["WorkspaceSettingsIn"]) =>
      unwrap(
        client.PATCH("/api/v1/workspaces/{workspace_id}/settings", { ...path(workspaceId), body }),
      ),
    onSuccess: (settings) => {
      queryClient.setQueryData(workspaceKeys.settings(workspaceId), settings);
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "audit"] });
    },
  });
}

// ---------------------------------------------------------------- audit log

export const AUDIT_PAGE_SIZE = 25;

/** Newest first, cursor-paginated; `action` is an exact code or a prefix ending with ".". */
export function useAuditEvents(workspaceId: string, action: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: workspaceKeys.audit(workspaceId, action),
    queryFn: ({ pageParam }) =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/audit-events", {
          params: {
            path: { workspace_id: workspaceId },
            query: { limit: AUDIT_PAGE_SIZE, cursor: pageParam, action: action ?? undefined },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => (page.has_more && page.next_cursor ? page.next_cursor : undefined),
    enabled,
  });
}

// ---------------------------------------------------------------- onboarding

export function useDismissOnboarding(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/onboarding/dismiss", path(workspaceId)),
      ),
    onSuccess: () => {
      queryClient.setQueryData<Onboarding>(workspaceKeys.onboarding(workspaceId), (data) =>
        data ? { ...data, dismissed: true } : data,
      );
    },
  });
}
