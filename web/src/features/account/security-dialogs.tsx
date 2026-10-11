import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { useCurrentSession } from "@/lib/auth/session";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { FormProblemAlert, RateLimitAlert } from "@/features/auth/components/form-alerts";
import { PasswordRequirements } from "@/features/auth/components/password-requirements";
import { applyFieldErrors, passwordErrorMessage, useRetryAfter } from "@/features/auth/errors";
import { emailSchema, newPasswordSchema } from "@/features/auth/schemas";
import { useChangeEmail, useChangePassword } from "./api";

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };

/** Change the sign-in address: a link is sent to the new one (D-064); nothing changes until then. */
export function EmailDialog({
  open,
  onOpenChange,
  onNeedPassword,
}: DialogProps & { onNeedPassword: () => void }) {
  const { t } = useTranslation(["account", "auth", "common"]);
  const { t: tAuth } = useTranslation("auth");
  const { user } = useCurrentSession();
  const change = useChangeEmail();
  const limit = useRetryAfter();
  const [problem, setProblem] = useState<unknown>(null);

  const schema = useMemo(
    () =>
      z.object({
        newEmail: emailSchema(tAuth),
        password: z.string().min(1, t("auth:validation.passwordRequired")),
      }),
    [t, tAuth],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { newEmail: "", password: "" },
  });

  const close = (next: boolean) => {
    if (!next) {
      form.reset();
      setProblem(null);
      change.reset();
      limit.reset();
    }
    onOpenChange(next);
  };

  const onSubmit = form.handleSubmit(async ({ newEmail, password }) => {
    setProblem(null);
    limit.reset();
    try {
      await change.mutateAsync({ new_email: newEmail, password });
      toast.success(t("email.sent", { email: newEmail }), { description: t("email.sentBody") });
      close(false);
    } catch (error) {
      if (limit.capture(error)) return;
      if (hasErrorCode(error, "password_required")) {
        setProblem(error);
        return;
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        if (fieldError.field === "password")
          return { field: "password", message: t("email.wrongPassword") };
        if (fieldError.field === "new_email") {
          return {
            field: "newEmail",
            message:
              fieldError.code === "unchanged"
                ? t("email.unchanged")
                : t("auth:validation.emailInvalid"),
          };
        }
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  const needsPassword = !user.has_password || hasErrorCode(problem, "password_required");

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t("email.dialogTitle")}
      description={t("email.dialogBody")}
      dismissible={!change.isPending}
      footer={
        needsPassword ? (
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              leftIcon={<KeyRound aria-hidden />}
              onClick={() => {
                close(false);
                onNeedPassword();
              }}
            >
              {t("password.set")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={change.isPending} onClick={() => close(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="submit"
              form="change-email"
              loading={change.isPending}
              disabled={limit.blocked}
            >
              {t("email.submit")}
            </Button>
          </>
        )
      }
    >
      {needsPassword ? (
        <div className="pb-4">
          <Alert tone="info" title={t("email.passwordRequired")} />
        </div>
      ) : (
        <form
          id="change-email"
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="flex flex-col gap-5 pb-4"
        >
          {problem ? <FormProblemAlert error={problem} /> : null}
          <RateLimitAlert
            remaining={limit.remaining}
            initialSeconds={limit.initialSeconds}
            over={limit.over}
          />
          <Field label={t("email.newEmail")} error={form.formState.errors.newEmail?.message}>
            <Input
              type="email"
              aria-required
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("auth:fields.emailPlaceholder")}
              {...form.register("newEmail")}
            />
          </Field>
          <Field
            label={t("email.password")}
            description={t("email.passwordHelp")}
            error={form.formState.errors.password?.message}
          >
            <PasswordInput
              aria-required
              autoComplete="current-password"
              {...form.register("password")}
            />
          </Field>
        </form>
      )}
    </Dialog>
  );
}

/** Change the password (current one required) or set one for OAuth-only accounts. */
export function PasswordDialog({ open, onOpenChange }: DialogProps) {
  const { t } = useTranslation(["account", "auth", "common"]);
  const { t: tAuth } = useTranslation("auth");
  const { user } = useCurrentSession();
  const change = useChangePassword();
  const limit = useRetryAfter();
  const [problem, setProblem] = useState<unknown>(null);
  const [serverCodes, setServerCodes] = useState<string[]>([]);
  const setting = !user.has_password;

  const schema = useMemo(
    () =>
      z.object({
        current: setting ? z.string() : z.string().min(1, t("password.currentRequired")),
        next: newPasswordSchema(tAuth),
      }),
    [t, tAuth, setting],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { current: "", next: "" },
  });
  const nextValue = useWatch({ control: form.control, name: "next" });

  const close = (value: boolean) => {
    if (!value) {
      form.reset();
      setProblem(null);
      setServerCodes([]);
      change.reset();
      limit.reset();
    }
    onOpenChange(value);
  };

  const onSubmit = form.handleSubmit(async ({ current, next }) => {
    setProblem(null);
    setServerCodes([]);
    limit.reset();
    try {
      await change.mutateAsync({ current_password: setting ? null : current, new_password: next });
      if (setting) toast.success(t("password.setDone"), { description: t("password.setDoneBody") });
      else toast.success(t("password.changed"), { description: t("password.changedBody") });
      close(false);
    } catch (error) {
      if (limit.capture(error)) return;
      if (isApiError(error)) {
        setServerCodes(
          error.fieldErrors.filter((f) => f.field === "new_password").map((f) => f.code),
        );
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        if (fieldError.field === "current_password")
          return { field: "current", message: t("password.wrongCurrent") };
        if (fieldError.field === "new_password") {
          return { field: "next", message: passwordErrorMessage(fieldError.code, tAuth) };
        }
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={setting ? t("password.setTitle") : t("password.changeTitle")}
      description={
        setting ? t("password.setDescriptionNoProvider") : t("password.changeDescription")
      }
      dismissible={!change.isPending}
      footer={
        <>
          <Button variant="secondary" disabled={change.isPending} onClick={() => close(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="submit"
            form="change-password"
            loading={change.isPending}
            disabled={limit.blocked}
          >
            {setting ? t("password.submitSet") : t("password.submitChange")}
          </Button>
        </>
      }
    >
      <form
        id="change-password"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5 pb-4"
      >
        {/* Lets password managers attach the new password to the right account. */}
        <input
          type="email"
          name="username"
          autoComplete="username"
          value={user.email}
          readOnly
          hidden
        />
        {problem ? <FormProblemAlert error={problem} /> : null}
        <RateLimitAlert
          remaining={limit.remaining}
          initialSeconds={limit.initialSeconds}
          over={limit.over}
        />
        {setting ? null : (
          <Field label={t("password.current")} error={form.formState.errors.current?.message}>
            <PasswordInput
              aria-required
              autoComplete="current-password"
              {...form.register("current")}
            />
          </Field>
        )}
        <Field
          label={t("auth:fields.newPassword")}
          error={form.formState.errors.next?.message}
          hint={
            <PasswordRequirements
              value={nextValue}
              email={user.email}
              serverCodes={serverCodes}
              invalid={Boolean(form.formState.errors.next)}
            />
          }
        >
          <PasswordInput aria-required autoComplete="new-password" {...form.register("next")} />
        </Field>
      </form>
    </Dialog>
  );
}
