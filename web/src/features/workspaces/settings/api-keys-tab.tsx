import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { can } from "@/lib/auth/permissions";
import { asRole, ASSIGNABLE_ROLES, type AssignableRole } from "@/lib/auth/types";
import { useFormatters } from "@/lib/format";
import { useMediaQuery } from "@/lib/use-media-query";
import { duration, ease, listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { CopyButton } from "@/components/ui/copy-button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Alert, Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/field";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  type ApiKey,
  type ApiKeyCreated,
} from "../api";
import { useCurrentWorkspace } from "../use-current-workspace";

type KeyStatus = "active" | "expired" | "revoked";

function statusOf(key: ApiKey, now: number): KeyStatus {
  if (key.revoked_at) return "revoked";
  if (key.expires_at && new Date(key.expires_at).getTime() <= now) return "expired";
  return "active";
}

const ORDER: Record<KeyStatus, number> = { active: 0, expired: 1, revoked: 2 };

/** Settings › API keys: service keys for scripts and CI (admins and the owner). */
export function ApiKeysTab() {
  const { t } = useTranslation("settings");
  const { workspace, detail } = useCurrentWorkspace();
  const allowed = can(detail.data, "api_keys:manage");
  const keys = useApiKeys(workspace.id, allowed);
  const [creating, setCreating] = useState(false);

  if (detail.isPending) return <KeysSkeleton />;
  if (!allowed) {
    return (
      <Card>
        <EmptyState
          illustration="locked"
          title={t("apiKeys.noPermissionTitle")}
          description={t("apiKeys.noPermissionBody")}
        />
      </Card>
    );
  }

  return (
    <motion.div variants={staggerChildren(0.05)} initial="hidden" animate="visible">
      <Card className="overflow-hidden">
        <CardHeader
          className="flex-col items-stretch gap-3 sm:flex-row sm:items-start"
          title={t("apiKeys.title")}
          description={t("apiKeys.description")}
          actions={
            keys.data && keys.data.length > 0 ? (
              <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                {t("apiKeys.create")}
              </Button>
            ) : null
          }
        />
        {keys.isPending ? (
          <KeysSkeleton bare />
        ) : keys.isError ? (
          <ErrorState
            compact
            title={t("apiKeys.loadError")}
            error={keys.error}
            onRetry={() => void keys.refetch()}
          />
        ) : keys.data.length === 0 ? (
          <EmptyState
            illustration="providers"
            title={t("apiKeys.emptyTitle")}
            description={t("apiKeys.emptyBody")}
            action={
              <Button leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
                {t("apiKeys.create")}
              </Button>
            }
          />
        ) : (
          <KeysList workspaceId={workspace.id} keys={keys.data} />
        )}
      </Card>
      <CreateKeyDialog open={creating} onOpenChange={setCreating} workspaceId={workspace.id} />
    </motion.div>
  );
}

function KeysList({ workspaceId, keys }: { workspaceId: string; keys: ApiKey[] }) {
  const { t } = useTranslation(["settings", "common"]);
  const { date, relative, dateTime } = useFormatters();
  const revoke = useRevokeApiKey(workspaceId);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const wide = useMediaQuery("(min-width: 1024px)");
  const [now] = useState(() => Date.now());

  const sorted = [...keys].sort((a, b) => ORDER[statusOf(a, now)] - ORDER[statusOf(b, now)]);
  const statusBadge = (status: KeyStatus) =>
    status === "active" ? (
      <Badge tone="success">{t("apiKeys.statusActive")}</Badge>
    ) : status === "expired" ? (
      <Badge tone="warning">{t("apiKeys.statusExpired")}</Badge>
    ) : (
      <Badge tone="neutral">{t("apiKeys.statusRevoked")}</Badge>
    );
  const keyPrefix = (key: ApiKey) => (
    <code className="rounded-field bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-ink">
      {key.prefix}…
    </code>
  );
  const lastUsed = (key: ApiKey) =>
    key.last_used_at ? (
      <time dateTime={key.last_used_at} title={dateTime(key.last_used_at)}>
        {relative(key.last_used_at)}
      </time>
    ) : (
      <span className="text-muted">{t("apiKeys.neverUsed")}</span>
    );
  const expires = (key: ApiKey) =>
    key.expires_at ? (
      <time dateTime={key.expires_at} title={dateTime(key.expires_at)}>
        {date(key.expires_at)}
      </time>
    ) : (
      <span className="text-muted">{t("apiKeys.noExpiry")}</span>
    );
  const revokeButton = (key: ApiKey, status: KeyStatus) =>
    status === "revoked" ? null : (
      <IconButton
        label={t("apiKeys.revokeLabel", { name: key.name })}
        icon={<Trash2 aria-hidden />}
        variant="danger-ghost"
        size="icon-sm"
        onClick={() => setRevoking(key)}
      />
    );

  return (
    <>
      {wide ? (
        <table className="w-full text-sm">
          <caption className="sr-only">{t("apiKeys.title")}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t("apiKeys.name")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("apiKeys.key")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("apiKeys.role")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("apiKeys.lastUsed")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("apiKeys.expires")}
              </th>
              <th scope="col" className="px-3 py-2.5 font-medium">
                {t("apiKeys.status")}
              </th>
              <th scope="col" className="w-14 px-5 py-2.5">
                <span className="sr-only">{t("apiKeys.actions")}</span>
              </th>
            </tr>
          </thead>
          <motion.tbody variants={staggerChildren(0.04)} initial="hidden" animate="visible">
            <AnimatePresence initial={false}>
              {sorted.map((key) => {
                const status = statusOf(key, now);
                return (
                  <motion.tr
                    key={key.id}
                    layout="position"
                    variants={listItem}
                    exit={{ opacity: 0, transition: { duration: duration.fast, ease: ease.exit } }}
                    className={`border-b border-line last:border-0 ${status === "revoked" ? "text-muted" : ""}`}
                  >
                    <td className="px-5 py-3">
                      <p
                        className={
                          status === "revoked"
                            ? "font-medium text-muted line-through"
                            : "font-medium text-ink"
                        }
                      >
                        {key.name}
                      </p>
                      <p className="text-xs text-muted">
                        {t("apiKeys.created")} {date(key.created_at)}
                      </p>
                    </td>
                    <td className="px-3 py-3">{keyPrefix(key)}</td>
                    <td className="px-3 py-3">
                      <Badge tone="outline">{t(`common:workspace.role.${asRole(key.role)}`)}</Badge>
                    </td>
                    <td className="px-3 py-3 text-[13px]">{lastUsed(key)}</td>
                    <td className="px-3 py-3 text-[13px]">{expires(key)}</td>
                    <td className="px-3 py-3">{statusBadge(status)}</td>
                    <td className="px-5 py-3 text-right">{revokeButton(key, status)}</td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </motion.tbody>
        </table>
      ) : (
        <motion.ul
          variants={staggerChildren(0.04)}
          initial="hidden"
          animate="visible"
          aria-label={t("apiKeys.title")}
          className="divide-y divide-line"
        >
          <AnimatePresence initial={false}>
            {sorted.map((key) => {
              const status = statusOf(key, now);
              return (
                <motion.li
                  key={key.id}
                  layout="position"
                  variants={listItem}
                  exit={{ opacity: 0, transition: { duration: duration.fast } }}
                  className="flex flex-col gap-2.5 px-5 py-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span
                          className={
                            status === "revoked"
                              ? "font-medium text-muted line-through"
                              : "font-medium text-ink"
                          }
                        >
                          {key.name}
                        </span>
                        {statusBadge(status)}
                      </p>
                      <p className="mt-1.5">{keyPrefix(key)}</p>
                    </div>
                    {revokeButton(key, status)}
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
                    <dt className="text-muted">{t("apiKeys.role")}</dt>
                    <dd>{t(`common:workspace.role.${asRole(key.role)}`)}</dd>
                    <dt className="text-muted">{t("apiKeys.lastUsed")}</dt>
                    <dd>{lastUsed(key)}</dd>
                    <dt className="text-muted">{t("apiKeys.expires")}</dt>
                    <dd>{expires(key)}</dd>
                  </dl>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </motion.ul>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("apiKeys.revokeDialogTitle", { name: revoking?.name ?? "" })}
        description={t("apiKeys.revokeDialogBody")}
        confirmLabel={t("apiKeys.revokeConfirm")}
        resourceName={revoking?.name}
        pending={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          const target = revoking;
          revoke.mutate(target.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success(t("apiKeys.revoked", { name: target.name }));
            },
            onError: () => toast.error(t("errors.generic")),
          });
        }}
      />
    </>
  );
}

const EXPIRY_CHOICES = ["never", "30", "90", "365"] as const;
type Expiry = (typeof EXPIRY_CHOICES)[number];

/** Create → reveal once. The secret only lives in this dialog's state until it closes. */
function CreateKeyDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const create = useCreateApiKey(workspaceId);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t("apiKeys.nameRequired")).max(80, t("apiKeys.nameTooLong")),
        role: z.enum(["admin", "member", "viewer"]),
        expiry: z.enum(EXPIRY_CHOICES),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", role: "member" as AssignableRole, expiry: "90" as Expiry },
  });

  const close = () => {
    onOpenChange(false);
    // Forget the secret and the form once the closing animation has started.
    window.setTimeout(() => {
      setCreated(null);
      setProblem(null);
      form.reset();
      create.reset();
    }, 250);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      const result = await create.mutateAsync({
        name: values.name,
        role: values.role,
        expires_in_days: values.expiry === "never" ? null : Number(values.expiry),
      });
      setCreated(result);
      toast.success(t("apiKeys.createdToast", { name: result.name }));
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "name" ? { field: "name", message: t("apiKeys.nameRequired") } : null,
      );
      if (!placed) setProblem(error);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
      title={created ? t("apiKeys.revealTitle") : t("apiKeys.createTitle")}
      description={created ? undefined : t("apiKeys.createDescription")}
      dismissible={!created && !create.isPending}
      footer={
        created ? (
          <Button onClick={close}>{t("apiKeys.revealDone")}</Button>
        ) : (
          <>
            <Button variant="secondary" disabled={create.isPending} onClick={close}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form="create-api-key"
              loading={create.isPending}
              leftIcon={<KeyRound aria-hidden />}
            >
              {t("apiKeys.submit")}
            </Button>
          </>
        )
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {created ? (
          <motion.div
            key="reveal"
            initial={{ opacity: 0, y: 8 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { duration: duration.base, ease: ease.standard },
            }}
            className="pb-4"
          >
            <KeyReveal created={created} />
          </motion.div>
        ) : (
          <motion.form
            key="form"
            id="create-api-key"
            noValidate
            onSubmit={(event) => void onSubmit(event)}
            exit={{ opacity: 0, y: -6, transition: { duration: duration.fast } }}
            className="flex flex-col gap-5 pb-4"
          >
            {problem ? <FormProblemAlert error={problem} /> : null}
            <Field label={t("apiKeys.nameLabel")} error={form.formState.errors.name?.message}>
              <Input
                aria-required
                autoComplete="off"
                maxLength={80}
                placeholder={t("apiKeys.namePlaceholder")}
                {...form.register("name")}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="role"
                render={({ field }) => (
                  <Field label={t("apiKeys.roleLabel")}>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={ASSIGNABLE_ROLES.map((role) => ({
                        value: role,
                        label: t(`common:workspace.role.${role}`),
                        description: t(`roles.${role}`),
                      }))}
                    />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="expiry"
                render={({ field }) => (
                  <Field label={t("apiKeys.expiryLabel")}>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={EXPIRY_CHOICES.map((choice) => ({
                        value: choice,
                        label: t(`apiKeys.expiry.${choice}`),
                      }))}
                    />
                  </Field>
                )}
              />
            </div>
          </motion.form>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

function KeyReveal({ created }: { created: ApiKeyCreated }) {
  const { t } = useTranslation("settings");
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    boxRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="warning" title={t("apiKeys.revealBody")} />
      <div ref={boxRef} className="flex flex-col gap-2">
        <p id="api-key-label" className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <ShieldAlert aria-hidden className="size-4 text-muted" />
          {t("apiKeys.revealLabel", { name: created.name })}
        </p>
        <div className="flex items-stretch gap-2">
          <output
            aria-labelledby="api-key-label"
            className="min-w-0 flex-1 rounded-field border border-line-strong/60 bg-sunken px-3 py-2.5 font-mono text-[13px] break-all text-ink select-all"
          >
            {created.key}
          </output>
          <CopyButton
            value={created.key}
            label={t("apiKeys.copyKey")}
            showText
            className="h-auto self-stretch border border-line px-3"
          />
        </div>
      </div>
    </div>
  );
}

function KeysSkeleton({ bare = false }: { bare?: boolean }) {
  const { t } = useTranslation();
  const rows = (
    <div className="divide-y divide-line" aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-6 px-5 py-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="hidden h-5 w-16 lg:block" />
          <Skeleton className="hidden h-5 w-20 lg:block" />
        </div>
      ))}
    </div>
  );
  return bare ? rows : <Card>{rows}</Card>;
}
