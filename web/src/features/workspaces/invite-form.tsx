import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Send, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@/lib/auth/types";
import { duration, ease } from "@/components/motion/presets";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Field, Input } from "@/components/ui/field";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useInvite } from "./api";

const MAX_ROWS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type InviteFormProps = {
  workspaceId: string;
  /** Called once every filled row was invited. */
  onSent?: (count: number) => void;
  /** Extra actions next to the submit button (e.g. "Skip for now"). */
  secondaryAction?: ReactNode;
};

/** Invite one or several people, each with a role. Sent rows leave the form; failures stay. */
export function InviteForm({ workspaceId, onSent, secondaryAction }: InviteFormProps) {
  const { t } = useTranslation(["settings", "common", "auth"]);
  const invite = useInvite(workspaceId);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        rows: z
          .array(
            z.object({ email: z.string().trim(), role: z.enum(["admin", "member", "viewer"]) }),
          )
          .superRefine((rows, context) => {
            const seen = new Set<string>();
            let filled = 0;
            rows.forEach((row, index) => {
              const email = row.email.toLowerCase();
              if (!email) return;
              filled += 1;
              if (!EMAIL_PATTERN.test(email)) {
                context.addIssue({
                  code: "custom",
                  path: [index, "email"],
                  message: t("auth:validation.emailInvalid"),
                });
              } else if (seen.has(email)) {
                context.addIssue({
                  code: "custom",
                  path: [index, "email"],
                  message: t("invite.duplicate"),
                });
              }
              seen.add(email);
            });
            if (filled === 0) {
              context.addIssue({
                code: "custom",
                path: [0, "email"],
                message: t("auth:validation.emailRequired"),
              });
            }
          }),
      }),
    [t],
  );

  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { rows: [{ email: "", role: "member" as AssignableRole }] },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "rows",
  });
  const rows = useWatch({ control: form.control, name: "rows" });
  const filled = rows.filter((row) => row.email.trim()).length;

  const roleOptions = ASSIGNABLE_ROLES.map((role) => ({
    value: role,
    label: t(`common:workspace.role.${role}`),
    description: t(`roles.${role}`),
  }));

  const onSubmit = form.handleSubmit(async ({ rows: values }) => {
    setProblem(null);
    setSending(true);
    const targets = values
      .map((row, index) => ({ ...row, index, email: row.email.trim() }))
      .filter((row) => row.email);
    const results = await Promise.allSettled(
      targets.map((row) => invite.mutateAsync({ email: row.email, role: row.role })),
    );
    setSending(false);

    const failed: { email: string; role: AssignableRole; message: string }[] = [];
    let sent = 0;
    let unexpected: unknown = null;
    results.forEach((result, i) => {
      const target = targets[i];
      if (!target) return;
      if (result.status === "fulfilled") {
        sent += 1;
        return;
      }
      const error: unknown = result.reason;
      let message = t("invite.failed");
      if (hasErrorCode(error, "already_member")) message = t("invite.alreadyMember");
      else if (hasErrorCode(error, "invitation_pending")) message = t("invite.pending");
      else if (isApiError(error) && error.fieldErrors.some((f) => f.field === "email")) {
        message = t("auth:validation.emailInvalid");
      } else if (!isApiError(error) || error.status >= 500 || error.isRateLimited) {
        unexpected = error;
      }
      failed.push({ email: target.email, role: target.role, message });
    });

    if (sent > 0) {
      const first = targets.find((_, i) => results[i]?.status === "fulfilled");
      toast.success(
        sent === 1 && first
          ? t("invite.sent", { email: first.email })
          : t("invite.sentMany", { count: sent }),
      );
    }
    if (failed.length === 0) {
      replace([{ email: "", role: "member" }]);
      onSent?.(sent);
      return;
    }
    // Keep only the rows that still need attention, with their reason.
    replace(failed.map(({ email, role }) => ({ email, role })));
    window.requestAnimationFrame(() => {
      failed.forEach(({ message }, index) => {
        form.setError(
          `rows.${index}.email`,
          { type: "server", message },
          { shouldFocus: index === 0 },
        );
      });
    });
    if (unexpected) setProblem(unexpected);
  });

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      {problem ? <FormProblemAlert error={problem} /> : null}
      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {fields.map((field, index) => {
            const n = index + 1;
            const error = form.formState.errors.rows?.[index]?.email?.message;
            return (
              <motion.li
                key={field.id}
                layout="position"
                initial={{ opacity: 0, y: -6 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: duration.base, ease: ease.standard },
                }}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
                className={
                  fields.length > 1
                    ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-2 sm:grid-cols-[minmax(0,1fr)_11rem_auto]"
                    : "grid grid-cols-1 items-start gap-x-2 gap-y-2 sm:grid-cols-[minmax(0,1fr)_11rem]"
                }
              >
                <Field
                  label={index === 0 ? t("invite.email") : t("invite.emailRow", { n })}
                  hideLabel={index > 0}
                  error={error}
                  className={fields.length > 1 ? "col-span-2 sm:col-span-1" : undefined}
                >
                  <Input
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={t("auth:fields.emailPlaceholder")}
                    {...form.register(`rows.${index}.email`)}
                  />
                </Field>
                <div className="flex flex-col gap-1.5">
                  {index === 0 ? (
                    <span className="hidden text-[13px] font-medium text-ink sm:block" aria-hidden>
                      {t("invite.role")}
                    </span>
                  ) : null}
                  <Controller
                    control={form.control}
                    name={`rows.${index}.role`}
                    render={({ field: roleField }) => (
                      <Select
                        value={roleField.value}
                        onValueChange={roleField.onChange}
                        options={roleOptions}
                        aria-label={t("invite.roleRow", { n })}
                      />
                    )}
                  />
                </div>
                {fields.length > 1 ? (
                  <div className={index === 0 ? "sm:pt-[26px]" : undefined}>
                    <IconButton
                      label={t("invite.removeRow", { n })}
                      icon={<X aria-hidden />}
                      onClick={() => remove(index)}
                    />
                  </div>
                ) : null}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="tertiary"
          size="sm"
          leftIcon={<Plus aria-hidden />}
          disabled={fields.length >= MAX_ROWS}
          onClick={() => {
            append({ email: "", role: "member" });
          }}
        >
          {t("invite.addRow")}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {secondaryAction}
          <Button
            type="submit"
            loading={sending}
            loadingText={t("invite.sending")}
            leftIcon={<Send aria-hidden />}
          >
            {t("invite.submit", { count: Math.max(1, filled) })}
          </Button>
        </div>
      </div>
    </form>
  );
}
