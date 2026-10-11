import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useLogout } from "./session";

/** Sign out, then go to `to` (default: the sign-in page). Failures keep the session and say so. */
export function useSignOut() {
  const { t } = useTranslation("shell");
  const logout = useLogout();
  const navigate = useNavigate();
  const signOut = (to: string | null = "/login") => {
    logout.mutate(undefined, {
      onSuccess: () => {
        if (to) void navigate(to, { replace: true });
      },
      onError: () => {
        toast.error(t("signOut.failed"), { id: "sign-out" });
      },
    });
  };
  return { signOut, pending: logout.isPending };
}
