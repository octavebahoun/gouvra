import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** The footer of a paged list: one more page on demand. */
export function LoadMore({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const { t } = useTranslation("admin");
  if (!hasNextPage) return null;
  return (
    <div className="border-t border-line p-3 text-center">
      <Button variant="tertiary" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
        {t("more")}
      </Button>
    </div>
  );
}
