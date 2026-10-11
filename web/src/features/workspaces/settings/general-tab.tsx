import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, LogOut, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { hasErrorCode } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useCurrentSession } from "@/lib/auth/session";
import { asRole, type Session } from "@/lib/auth/types";
import { useFormatters } from "@/lib/format";
import { SettingsSection } from "@/components/layout/settings-section";
import { UnsavedChangesGuard } from "@/components/layout/unsaved-changes";
import { staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { IdChip } from "@/components/ui/copy-button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { Field, FormError, Input, PrefixedInput } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/states";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import {
  forgetWorkspace,
  refreshSession,
  useDeleteWorkspace,
  useLeaveWorkspace,
  useMembers,
  useTransferOwnership,
  useUpdateWorkspace,
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
  type Workspace,
  type WorkspaceSettings,
} from "../api";
import { SLUG_PATTERN } from "../slug";
import { useCurrentWorkspace } from "../use-current-workspace";

/** Settings › General: name and URL, details, and the danger zone. */
export function GeneralTab() {
  const { detail } = useCurrentWorkspace();
  if (detail.isPending) return <GeneralSkeleton />;
  if (detail.isError) {
    return (
      <Card>
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </Card>
    );
  }
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-10"
    >
      <ProfileSection workspace={detail.data} />
      <LimitsSection workspace={detail.data} />
      <DetailsSection workspace={detail.data} />
      <DangerZone workspace={detail.data} />
    </motion.div>
  );
}

function ProfileSection({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation(["settings", "common"]);
  const update = useUpdateWorkspace(workspace.id);
  const editable = can(workspace, "workspace:update");
  const [problem, setProblem] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t("workspaceForm.nameRequired"))
          .min(2, t("workspaceForm.nameLength"))
          .max(80, t("workspaceForm.nameLength")),
        slug: z
          .string()
          .trim()
          .toLowerCase()
          .min(3, t("workspaceForm.slugInvalid"))
          .max(48, t("workspaceForm.slugInvalid"))
          .regex(SLUG_PATTERN, t("workspaceForm.slugInvalid")),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: workspace.name, slug: workspace.slug },
  });
  const { isDirty, dirtyFields, errors } = form.formState;

  // Saved elsewhere (another tab, another admin): show the current values when not editing.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ name: workspace.name, slug: workspace.slug });
  }, [workspace.name, workspace.slug, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      const saved = await update.mutateAsync({
        name: dirtyFields.name ? values.name : null,
        slug: dirtyFields.slug ? values.slug : null,
      });
      form.reset({ name: saved.name, slug: saved.slug });
      toast.success(t("general.saved"));
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        if (fieldError.field === "slug") {
          return {
            field: "slug",
            message:
              fieldError.code === "taken"
                ? t("workspaceForm.slugTaken")
                : t("workspaceForm.slugInvalid"),
          };
        }
        if (fieldError.field === "name") {
          return { field: "name", message: t("workspaceForm.nameLength") };
        }
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  return (
    <SettingsSection
      id="workspace-profile"
      title={t("general.profileTitle")}
      description={t("general.profileDescription")}
    >
      <Card>
        <form noValidate onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-5 p-5">
            {!editable ? <Alert tone="info" title={t("general.readOnly")} /> : null}
            {problem ? <FormProblemAlert error={problem} /> : null}
            <Field label={t("workspaceForm.name")} error={errors.name?.message}>
              <Input readOnly={!editable} maxLength={80} {...form.register("name")} />
            </Field>
            <Field
              label={t("workspaceForm.slug")}
              description={t("workspaceForm.slugHelp")}
              error={errors.slug?.message}
              hint={
                dirtyFields.slug ? (
                  <span className="text-warning-text">{t("workspaceForm.slugChangeWarning")}</span>
                ) : undefined
              }
            >
              <PrefixedInput
                prefix={
                  <>
                    <span className="hidden sm:inline">{window.location.host}</span>/w/
                  </>
                }
                readOnly={!editable}
                autoCapitalize="none"
                spellCheck={false}
                maxLength={48}
                className="font-mono"
                {...form.register("slug")}
              />
            </Field>
          </div>
          {editable ? (
            <div className="flex flex-col-reverse gap-3 border-t border-line bg-surface-2/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p aria-live="polite" className="flex items-center gap-2 text-[13px] text-muted">
                {isDirty ? (
                  <>
                    <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                    {t("general.unsaved")}
                  </>
                ) : null}
              </p>
              <div className="flex items-center gap-2">
                {isDirty ? (
                  <Button
                    variant="tertiary"
                    disabled={update.isPending}
                    onClick={() => form.reset()}
                  >
                    {t("general.discard")}
                  </Button>
                ) : null}
                <Button type="submit" disabled={!isDirty} loading={update.isPending}>
                  {t("general.save")}
                </Button>
              </div>
            </div>
          ) : null}
        </form>
      </Card>
      <UnsavedChangesGuard when={isDirty && !update.isPending} />
    </SettingsSection>
  );
}

/** Operational limits (`GET/PATCH /workspaces/{id}/settings`), editable by admins. */
function LimitsSection({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("settings");
  const settings = useWorkspaceSettings(workspace.id);
  return (
    <SettingsSection id="limits" title={t("limits.title")} description={t("limits.description")}>
      <Card>
        {settings.isPending ? (
          <div className="space-y-2 p-5" aria-busy="true">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-9 w-32" />
          </div>
        ) : settings.isError ? (
          <ErrorState
            compact
            title={t("limits.loadError")}
            error={settings.error}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <LimitsForm
            workspaceId={workspace.id}
            settings={settings.data}
            editable={can(workspace, "workspace:update")}
          />
        )}
      </Card>
    </SettingsSection>
  );
}

function LimitsForm({
  workspaceId,
  settings,
  editable,
}: {
  workspaceId: string;
  settings: WorkspaceSettings;
  editable: boolean;
}) {
  const { t } = useTranslation("settings");
  const update = useUpdateWorkspaceSettings(workspaceId);
  const [problem, setProblem] = useState<unknown>(null);
  const max = settings.max_concurrent_executions_limit;
  const schema = useMemo(
    () =>
      z.object({
        concurrency: z.coerce
          .number({ error: t("limits.invalid", { max }) })
          .int(t("limits.invalid", { max }))
          .min(1, t("limits.invalid", { max }))
          .max(max, t("limits.invalid", { max })),
      }),
    [t, max],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { concurrency: settings.max_concurrent_executions },
  });
  const { isDirty, errors } = form.formState;

  const onSubmit = form.handleSubmit(async ({ concurrency }) => {
    setProblem(null);
    try {
      const saved = await update.mutateAsync({ max_concurrent_executions: concurrency });
      form.reset({ concurrency: saved.max_concurrent_executions });
      toast.success(t("limits.saved"));
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "max_concurrent_executions"
          ? { field: "concurrency", message: t("limits.invalid", { max }) }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)}>
      <div className="flex flex-col gap-4 p-5">
        {!editable ? <Alert tone="info" title={t("limits.readOnly")} /> : null}
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field
          label={t("limits.maxConcurrent")}
          description={t("limits.maxConcurrentHelp", { max })}
          error={errors.concurrency?.message}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step={1}
            readOnly={!editable}
            className="w-32 tabular-nums"
            {...form.register("concurrency")}
          />
        </Field>
      </div>
      {editable ? (
        <div className="flex justify-end border-t border-line bg-surface-2/40 px-5 py-3">
          <Button type="submit" disabled={!isDirty} loading={update.isPending}>
            {t("limits.save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function DetailsSection({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation(["settings", "common"]);
  const { date } = useFormatters();
  return (
    <SettingsSection id="workspace-details" title={t("general.detailsTitle")}>
      <Card>
        <dl className="grid divide-y divide-line text-sm sm:grid-cols-2 sm:divide-y-0">
          <Detail label={t("general.id")}>
            <IdChip id={workspace.id} label={t("general.id")} chars={13} />
          </Detail>
          <Detail label={t("general.created")}>{date(workspace.created_at)}</Detail>
          <Detail label={t("general.yourRole")}>
            <Badge tone="brand">{t(`common:workspace.role.${asRole(workspace.role)}`)}</Badge>
          </Detail>
          <Detail label={t("general.members")}>
            <span className="tabular-nums">{workspace.member_count}</span>
          </Detail>
        </dl>
      </Card>
    </SettingsSection>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 px-5 py-3 sm:flex-col sm:items-start sm:justify-center sm:gap-1.5 sm:border-line sm:even:border-l sm:[&:nth-child(n+3)]:border-t">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/** Next stop after leaving or deleting: another workspace, or onboarding. */
function nextWorkspacePath(session: Session, leavingId: string): string {
  const other = session.workspaces.find((w) => w.id !== leavingId);
  return other ? `/w/${other.slug}/overview` : "/onboarding";
}

function DangerZone({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation(["settings", "common"]);
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const members = useMembers(workspace.id);
  const leave = useLeaveWorkspace(workspace.id);
  const remove = useDeleteWorkspace(workspace.id);
  const [dialog, setDialog] = useState<"transfer" | "leave" | "delete" | null>(null);
  const isOwner = workspace.role === "owner";
  const canTransfer = can(workspace, "ownership:transfer");
  const canDelete = can(workspace, "workspace:delete");
  const candidates = (members.data ?? []).filter((m) => !m.is_you && m.role !== "owner");

  const goAway = async (message: string) => {
    toast.success(message);
    await navigate(nextWorkspacePath(session, workspace.id), { replace: true });
    forgetWorkspace(queryClient, workspace.id);
    void refreshSession(queryClient);
  };

  return (
    <SettingsSection
      id="danger-zone"
      tone="danger"
      title={t("danger.title")}
      description={t("danger.description")}
    >
      <Card className="divide-y divide-line border-danger/30">
        <DangerRow
          title={t("danger.transferTitle")}
          body={t("danger.transferBody")}
          note={
            !canTransfer
              ? t("danger.transferOnlyOwner")
              : members.isSuccess && candidates.length === 0
                ? t("danger.transferNoCandidate")
                : null
          }
          action={
            <Button
              variant="secondary"
              leftIcon={<ArrowRightLeft aria-hidden />}
              disabled={!canTransfer || candidates.length === 0}
              onClick={() => setDialog("transfer")}
            >
              {t("danger.transferAction")}
            </Button>
          }
        />
        <DangerRow
          title={t("danger.leaveTitle")}
          body={t("danger.leaveBody")}
          note={isOwner ? t("danger.leaveOwner") : null}
          action={
            <Button
              variant="secondary"
              leftIcon={<LogOut aria-hidden />}
              disabled={isOwner}
              onClick={() => setDialog("leave")}
            >
              {t("danger.leaveAction")}
            </Button>
          }
        />
        <DangerRow
          title={t("danger.deleteTitle")}
          body={t("danger.deleteBody")}
          note={canDelete ? null : t("danger.deleteOnlyOwner")}
          action={
            <Button
              variant="danger"
              leftIcon={<Trash2 aria-hidden />}
              disabled={!canDelete}
              onClick={() => setDialog("delete")}
            >
              {t("danger.deleteAction")}
            </Button>
          }
        />
      </Card>

      <TransferDialog
        open={dialog === "transfer"}
        onOpenChange={(open) => setDialog(open ? "transfer" : null)}
        workspace={workspace}
        candidates={candidates}
      />
      <ConfirmDialog
        open={dialog === "leave"}
        onOpenChange={(open) => setDialog(open ? "leave" : null)}
        title={t("danger.leaveDialogTitle", { workspace: workspace.name })}
        description={
          leave.error ? (
            <>
              {t("danger.leaveDialogBody")}{" "}
              <span className="text-danger-text">
                {hasErrorCode(leave.error, "owner_cannot_leave")
                  ? t("errors.owner_cannot_leave")
                  : t("errors.generic")}
              </span>
            </>
          ) : (
            t("danger.leaveDialogBody")
          )
        }
        confirmLabel={t("danger.leaveConfirm")}
        pending={leave.isPending}
        onConfirm={async () => {
          try {
            await leave.mutateAsync(session.user.id);
            setDialog(null);
            await goAway(t("danger.left", { workspace: workspace.name }));
          } catch {
            /* shown in the dialog */
          }
        }}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        title={t("danger.deleteDialogTitle", { workspace: workspace.name })}
        description={
          remove.error ? (
            <>
              {t("danger.deleteDialogBody")}{" "}
              <span className="text-danger-text">{t("errors.generic")}</span>
            </>
          ) : (
            t("danger.deleteDialogBody")
          )
        }
        confirmLabel={t("danger.deleteConfirm")}
        resourceName={workspace.name}
        pending={remove.isPending}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(workspace.name);
            setDialog(null);
            await goAway(t("danger.deleted", { workspace: workspace.name }));
          } catch {
            /* shown in the dialog */
          }
        }}
      />
    </SettingsSection>
  );
}

function DangerRow({
  title,
  body,
  note,
  action,
}: {
  title: string;
  body: string;
  note: string | null;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{body}</p>
        {note ? <p className="mt-1.5 text-[13px] font-medium text-ink/80">{note}</p> : null}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

function TransferDialog({
  open,
  onOpenChange,
  workspace,
  candidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
  candidates: { user_id: string; display_name: string; email: string }[];
}) {
  const { t } = useTranslation(["settings", "common"]);
  const transfer = useTransferOwnership(workspace.id);
  const form = useForm<{ userId: string }>({
    defaultValues: { userId: "" },
  });
  const close = (next: boolean) => {
    if (!next) {
      form.reset();
      transfer.reset();
    }
    onOpenChange(next);
  };

  const onSubmit = form.handleSubmit(async ({ userId }) => {
    if (!userId) {
      form.setError("userId", { message: t("danger.transferRequired") }, { shouldFocus: true });
      return;
    }
    try {
      await transfer.mutateAsync(userId);
      const target = candidates.find((c) => c.user_id === userId);
      toast.success(
        t("danger.transferred", { name: target?.display_name ?? "", workspace: workspace.name }),
      );
      close(false);
    } catch {
      /* shown below */
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("danger.transferDialogTitle", { workspace: workspace.name })}
      description={t("danger.transferDialogBody")}
      dismissible={!transfer.isPending}
      footer={
        <>
          <Button variant="secondary" disabled={transfer.isPending} onClick={() => close(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="transfer-ownership"
            variant="danger"
            loading={transfer.isPending}
          >
            {t("danger.transferConfirm")}
          </Button>
        </>
      }
    >
      <form
        id="transfer-ownership"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-4 pb-4"
      >
        {transfer.error ? (
          <FormError>
            {hasErrorCode(transfer.error, "invalid_target")
              ? t("errors.invalid_target")
              : t("errors.generic")}
          </FormError>
        ) : null}
        <Controller
          control={form.control}
          name="userId"
          render={({ field, fieldState }) => (
            <Field label={t("danger.transferTo")} error={fieldState.error?.message}>
              <Select
                value={field.value || undefined}
                onValueChange={field.onChange}
                placeholder={t("danger.transferPlaceholder")}
                options={candidates.map((member) => ({
                  value: member.user_id,
                  label: member.display_name,
                  description: member.email,
                }))}
              />
            </Field>
          )}
        />
      </form>
    </Dialog>
  );
}

function GeneralSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-10" aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      {[0, 1].map((section) => (
        <div key={section} className="grid gap-x-10 gap-y-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Card className="space-y-5 p-5">
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          </Card>
        </div>
      ))}
    </div>
  );
}
