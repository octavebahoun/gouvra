import { ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useDeferredValue, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useCurrentSession } from "@/lib/auth/session";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAdminUsers, useUpdateAdminUser, type AdminUser } from "./api";
import { LoadMore } from "./load-more";
import { SearchField } from "./search-field";

/** Every account of the instance; disabling one signs it out everywhere. */
export function UsersTab() {
  const { t } = useTranslation("admin");
  const session = useCurrentSession();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const users = useAdminUsers(query);
  const rows = users.data?.pages.flatMap((page) => page.data) ?? [];
  const update = useUpdateAdminUser();
  const [disabling, setDisabling] = useState<AdminUser | null>(null);

  function setStatus(user: AdminUser, status: "active" | "disabled") {
    update.mutate(
      { id: user.id, status },
      {
        onSuccess: () => {
          toast.success(
            t(status === "disabled" ? "users.disabled" : "users.enabled", { email: user.email }),
          );
          setDisabling(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <div>
      <div className="mb-4">
        <SearchField value={search} onChange={setSearch} label={t("users.search")} />
      </div>
      {users.isPending ? (
        <Skeleton className="h-64 rounded-card" />
      ) : users.isError ? (
        <Card>
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState compact title={t("users.empty")} />
        </Card>
      ) : (
        <Card>
          <motion.ul
            variants={staggerChildren(0.03)}
            initial="hidden"
            animate="visible"
            className={cn("divide-y divide-line", users.isPlaceholderData && "opacity-60")}
          >
            {rows.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                self={user.id === session.user.id}
                onDisable={() => setDisabling(user)}
                onEnable={() => setStatus(user, "active")}
              />
            ))}
          </motion.ul>
          <LoadMore
            hasNextPage={users.hasNextPage}
            isFetchingNextPage={users.isFetchingNextPage}
            fetchNextPage={users.fetchNextPage}
          />
        </Card>
      )}
      <ConfirmDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title={t("users.disableTitle", { email: disabling?.email ?? "" })}
        description={t("users.disableBody")}
        confirmLabel={t("users.disable")}
        pending={update.isPending}
        onConfirm={() => {
          if (disabling) setStatus(disabling, "disabled");
        }}
      />
    </div>
  );
}

function UserRow({
  user,
  self,
  onDisable,
  onEnable,
}: {
  user: AdminUser;
  self: boolean;
  onDisable: () => void;
  onEnable: () => void;
}) {
  const { t } = useTranslation("admin");
  const { date } = useFormatters();
  const disabled = user.status === "disabled";
  return (
    <motion.li
      variants={listItem}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5"
    >
      <Avatar name={user.display_name || user.email} size="sm" />
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-ink">{user.display_name || user.email}</span>
          {user.is_superadmin ? (
            <Badge tone="brand" icon={<ShieldCheck aria-hidden />}>
              {t("users.superadmin")}
            </Badge>
          ) : null}
          {disabled ? <Badge tone="danger">{t("users.statusDisabled")}</Badge> : null}
          {!user.email_verified ? <Badge tone="warning">{t("users.unverified")}</Badge> : null}
        </div>
        <p className="truncate text-[12px] text-muted">
          {user.email} · {t("users.workspaces", { count: user.workspaces })} ·{" "}
          {t("users.joined", { date: date(user.created_at) })}
        </p>
      </div>
      {self ? (
        <span className="text-[13px] text-muted">{t("users.you")}</span>
      ) : disabled ? (
        <Button size="sm" variant="secondary" onClick={onEnable}>
          {t("users.enable")}
        </Button>
      ) : (
        <Button size="sm" variant="danger-ghost" onClick={onDisable}>
          {t("users.disable")}
        </Button>
      )}
    </motion.li>
  );
}
