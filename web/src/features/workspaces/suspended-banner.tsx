import { Ban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "./api";

/** Shown on every page of a workspace that an instance administrator suspended (read-only). */
export function SuspendedBanner({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation("shell");
  const detail = useWorkspace(workspaceId);
  if (detail.data?.status !== "suspended") return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-line bg-danger-soft px-4 py-2.5 text-center text-[13px] text-danger-text"
    >
      <Ban aria-hidden className="size-4 shrink-0" />
      <p>
        <strong className="font-semibold">{t("suspended.title")}</strong> {t("suspended.body")}
      </p>
    </div>
  );
}
