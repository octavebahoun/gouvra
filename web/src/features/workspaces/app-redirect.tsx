import { Navigate } from "react-router";
import { useCurrentSession } from "@/lib/auth/session";
import { readLastWorkspace } from "@/lib/auth/storage";

/** `/app`: the last workspace used on this device, else the first one, else onboarding. */
export function AppRedirect() {
  const session = useCurrentSession();
  const last = readLastWorkspace(session.user.id);
  const target = session.workspaces.find((w) => w.slug === last) ?? session.workspaces[0];
  return <Navigate to={target ? `/w/${target.slug}/overview` : "/onboarding"} replace />;
}
