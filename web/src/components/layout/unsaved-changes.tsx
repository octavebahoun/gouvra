import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker } from "react-router";
import { ConfirmDialog } from "@/components/ui/dialog";

/**
 * Warns before unsaved edits are lost: in-app navigation asks for confirmation, and closing or
 * reloading the tab triggers the browser's own prompt.
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  const { t } = useTranslation();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!when) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [when]);

  return (
    <ConfirmDialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.state === "blocked") blocker.reset();
      }}
      title={t("states.leaveUnsavedTitle")}
      description={t("states.leaveUnsavedBody")}
      confirmLabel={t("states.leave")}
      onConfirm={() => {
        if (blocker.state === "blocked") blocker.proceed();
      }}
    />
  );
}
