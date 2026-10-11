import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { NotFoundState } from "@/components/ui/states";

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <NotFoundState
        headingLevel="h1"
        action={
          <Button asChild variant="secondary">
            <Link to="/">{t("actions.back")}</Link>
          </Button>
        }
      />
    </main>
  );
}
