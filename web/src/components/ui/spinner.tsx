import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <span role="status" className="inline-flex items-center">
      <LoaderCircle aria-hidden className={cn("size-4 animate-spin", className)} />
      <span className="sr-only">{label ?? t("a11y.loading")}</span>
    </span>
  );
}
