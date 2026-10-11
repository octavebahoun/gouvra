import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";
import { authKeys } from "@/lib/auth/session";

export type DeviceSession = Schemas["SessionItem"];

/** My active sessions (devices), most recently used first. */
export function useDeviceSessions() {
  return useQuery({
    queryKey: authKeys.devices,
    queryFn: () => unwrap(client.GET("/api/v1/me/sessions")),
  });
}

export function useRevokeDeviceSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      unwrap(
        client.DELETE("/api/v1/me/sessions/{session_id}", {
          params: { path: { session_id: sessionId } },
        }),
      ),
    onSuccess: (_data, sessionId) => {
      queryClient.setQueryData<DeviceSession[]>(authKeys.devices, (list) =>
        list?.filter((s) => s.id !== sessionId),
      );
    },
  });
}

export function useRevokeOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(client.POST("/api/v1/me/sessions/revoke-others")),
    onSuccess: () => {
      queryClient.setQueryData<DeviceSession[]>(authKeys.devices, (list) =>
        list?.filter((s) => s.current),
      );
      void queryClient.invalidateQueries({ queryKey: authKeys.devices });
    },
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ChangePasswordIn"]) =>
      unwrap(client.POST("/api/v1/me/password", { body })),
    onSuccess: () => {
      // The API signs out the other sessions and the user now has a password.
      void queryClient.invalidateQueries({ queryKey: authKeys.devices });
      void queryClient.invalidateQueries({ queryKey: authKeys.session });
    },
  });
}

export function useChangeEmail() {
  return useMutation({
    mutationFn: (body: Schemas["EmailChangeIn"]) =>
      unwrap(client.POST("/api/v1/me/email", { body })),
  });
}
