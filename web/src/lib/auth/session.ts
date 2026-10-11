import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import type { Session } from "./types";

/**
 * The session lives in the TanStack Query cache only (one entry, `authKeys.session`):
 * `Session` when signed in, `null` when signed out. Nothing copies it into another store.
 */
export const authKeys = {
  session: ["auth", "session"] as const,
  devices: ["auth", "devices"] as const,
  meta: ["meta"] as const,
};

export async function fetchSession(): Promise<Session | null> {
  try {
    return await unwrap(client.GET("/api/v1/auth/session"));
  } catch (error) {
    if (isApiError(error) && error.status === 401) return null;
    throw error;
  }
}

export function useSession() {
  return useQuery({ queryKey: authKeys.session, queryFn: fetchSession, staleTime: 60_000 });
}

/** Under `<RequireAuth>`, the session is guaranteed: this returns it without a null check. */
export function useCurrentSession(): Session {
  const { data } = useSession();
  if (!data) throw new Error("useCurrentSession() must be rendered under <RequireAuth>");
  return data;
}

export function useMeta() {
  return useQuery({
    queryKey: authKeys.meta,
    queryFn: () => unwrap(client.GET("/api/v1/meta")),
    staleTime: 10 * 60_000,
  });
}

const keepsAcrossIdentities = (key: readonly unknown[]) =>
  key[0] === "meta" || (key[0] === "auth" && key[1] === "session");

/** A new identity must never see cached data of the previous one. */
export function applySignedIn(queryClient: QueryClient, session: Session): void {
  queryClient.removeQueries({ predicate: (query) => !keepsAcrossIdentities(query.queryKey) });
  queryClient.setQueryData(authKeys.session, session);
}

export function applySignedOut(queryClient: QueryClient): void {
  queryClient.setQueryData(authKeys.session, null);
  queryClient.removeQueries({ predicate: (query) => !keepsAcrossIdentities(query.queryKey) });
}

/** Update the signed-in user inside the cached session (after PATCH /me). */
export function applyUser(queryClient: QueryClient, user: Session["user"]): void {
  queryClient.setQueryData<Session | null>(authKeys.session, (current) =>
    current ? { ...current, user } : current,
  );
}

// ---------------------------------------------------------------- explicit sign-out

/**
 * After an explicit sign-out, guards send people to a plain `/login` (no `?next=` pointing at
 * the page they just left — the next person on this device may not be a member there).
 */
let signingOut = false;
export const isSigningOut = () => signingOut;
export const endSigningOut = () => {
  signingOut = false;
};

// ---------------------------------------------------------------- mutations

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["LoginIn"]) => unwrap(client.POST("/api/v1/auth/login", { body })),
    onSuccess: (session) => applySignedIn(queryClient, session),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (body: Schemas["RegisterIn"]) =>
      unwrap(client.POST("/api/v1/auth/register", { body })),
  });
}

/** Signed in: resends to the account address. Signed out: to `email`, if it has an account. */
export function useResendVerification() {
  return useMutation({
    mutationFn: (email?: string) =>
      unwrap(client.POST("/api/v1/auth/verify-email/resend", { body: email ? { email } : null })),
  });
}

export function useForgotPassword() {
  return useMutation({
    mutationFn: (email: string) =>
      unwrap(client.POST("/api/v1/auth/password/forgot", { body: { email } })),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(client.POST("/api/v1/auth/logout")),
    onSuccess: () => {
      signingOut = true;
      applySignedOut(queryClient);
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["ProfileUpdateIn"]) => unwrap(client.PATCH("/api/v1/me", { body })),
    onSuccess: (user) => applyUser(queryClient, user),
  });
}

// ---------------------------------------------------------------- one-time e-mail tokens

/** Each of these signs the user in and returns the new session. */
export const verifyEmail = (token: string) =>
  unwrap(client.POST("/api/v1/auth/verify-email", { body: { token } }));

export const confirmEmailChange = (token: string) =>
  unwrap(client.POST("/api/v1/auth/email/confirm", { body: { token } }));

export const resetPassword = (token: string, password: string) =>
  unwrap(client.POST("/api/v1/auth/password/reset", { body: { token, password } }));
