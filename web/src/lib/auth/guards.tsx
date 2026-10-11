import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { PageLoader } from "@/components/layout/page-loader";
import { ErrorState } from "@/components/ui/states";
import { loginPath, safeNext } from "./next";
import { isSigningOut, useSession } from "./session";

/** Signed-in area: anonymous visitors go to `/login?next=<this page>`. */
export function RequireAuth() {
  const { t } = useTranslation("shell");
  const location = useLocation();
  const session = useSession();
  if (session.isPending) return <PageLoader className="min-h-dvh" />;
  if (session.data === undefined) {
    // The session check itself failed (API down, network): never pretend the user is signed out.
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <ErrorState
          title={t("session.loadError")}
          error={session.error}
          onRetry={() => void session.refetch()}
        />
      </main>
    );
  }
  if (session.data === null) {
    return <Navigate to={isSigningOut() ? "/login" : loginPath(location)} replace />;
  }
  return <Outlet />;
}

/** Under RequireAuth: accounts whose e-mail isn't confirmed see the confirmation screen. */
export function RequireVerified() {
  const { data } = useSession();
  if (data && !data.user.email_verified) return <Navigate to="/verify-email" replace />;
  return <Outlet />;
}

/** Sign-in, sign-up and recovery pages: someone already signed in continues to `next`. */
export function GuestOnly() {
  const [params] = useSearchParams();
  const session = useSession();
  if (session.isPending) return <PageLoader className="min-h-[50vh]" />;
  if (session.data) {
    const target = session.data.user.email_verified
      ? safeNext(params.get("next"))
      : "/verify-email";
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
