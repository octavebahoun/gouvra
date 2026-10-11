import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, MailCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { isApiError } from "@/lib/api/errors";
import { withNext } from "@/lib/auth/next";
import { useRegister, useResendVerification } from "@/lib/auth/session";
import { currentLanguage } from "@/lib/i18n";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { AuthHeading, AuthItem, AuthStack, AuthSwitch, StatusPanel } from "./components/auth-ui";
import { FieldMessage } from "./components/field-message";
import { FormProblemAlert, RateLimitAlert } from "./components/form-alerts";
import { OAuthButtons } from "./components/oauth-buttons";
import { PasswordRequirements } from "./components/password-requirements";
import { ResendButton } from "./components/resend-button";
import { applyFieldErrors, passwordErrorMessage, useRetryAfter } from "./errors";
import { displayNameSchema, emailSchema, newPasswordSchema } from "./schemas";

/** Screen B — create an account. The answer is always the same "check your inbox" (D-060). */
export function RegisterPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const next = params.get("next");
  const register = useRegister();
  const resend = useResendVerification();
  const limit = useRetryAfter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [serverCodes, setServerCodes] = useState<string[]>([]);
  useDocumentTitle(sentTo ? t("register.sentTitle") : t("register.title"));

  const schema = useMemo(
    () =>
      z.object({
        displayName: displayNameSchema(t),
        email: emailSchema(t),
        password: newPasswordSchema(t),
        terms: z.boolean().refine((value) => value, t("validation.termsRequired")),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { displayName: "", email: "", password: "", terms: false },
  });
  const { errors } = form.formState;
  const password = useWatch({ control: form.control, name: "password" });
  const email = useWatch({ control: form.control, name: "email" });

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    setServerCodes([]);
    limit.reset();
    try {
      await register.mutateAsync({
        email: values.email,
        password: values.password,
        display_name: values.displayName,
        locale: currentLanguage(),
        accept_terms: true,
      });
      setSentTo(values.email);
    } catch (error) {
      if (limit.capture(error)) return;
      if (isApiError(error)) {
        setServerCodes(error.fieldErrors.filter((f) => f.field === "password").map((f) => f.code));
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        switch (fieldError.field) {
          case "password":
            return { field: "password", message: passwordErrorMessage(fieldError.code, t) };
          case "email":
            return { field: "email", message: t("validation.emailInvalid") };
          case "display_name":
            return { field: "displayName", message: t("validation.nameRequired") };
          default:
            return null;
        }
      });
      if (!placed) setProblem(error);
    }
  });

  if (sentTo) {
    return (
      <StatusPanel
        tone="info"
        icon={<MailCheck />}
        title={t("register.sentTitle")}
        focusOnMount
        actions={
          <>
            <ResendButton onResend={() => resend.mutateAsync(sentTo)} />
            <Button
              variant="tertiary"
              size="lg"
              leftIcon={<ArrowLeft aria-hidden />}
              onClick={() => setSentTo(null)}
            >
              {t("register.differentAddress")}
            </Button>
          </>
        }
      >
        <p>{t("register.sentBody", { email: sentTo })}</p>
        <p>{t("register.sentHelp")}</p>
      </StatusPanel>
    );
  }

  return (
    <AuthStack>
      <AuthItem>
        <AuthHeading title={t("register.title")} description={t("register.subtitle")} />
      </AuthItem>
      {next?.startsWith("/invite") ? (
        <AuthItem>
          <Alert tone="info" title={t("register.inviteHint")} />
        </AuthItem>
      ) : null}
      <AuthItem>
        <OAuthButtons next={next} />
      </AuthItem>
      <AuthItem>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
          {problem ? <FormProblemAlert error={problem} /> : null}
          <RateLimitAlert
            remaining={limit.remaining}
            initialSeconds={limit.initialSeconds}
            over={limit.over}
          />
          <Field
            label={t("fields.displayName")}
            description={t("fields.displayNameHelp")}
            error={errors.displayName?.message}
          >
            <Input
              aria-required
              autoComplete="name"
              placeholder={t("fields.displayNamePlaceholder")}
              {...form.register("displayName")}
            />
          </Field>
          <Field label={t("fields.email")} error={errors.email?.message}>
            <Input
              type="email"
              aria-required
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("fields.emailPlaceholder")}
              {...form.register("email")}
            />
          </Field>
          <Field
            label={t("fields.password")}
            error={errors.password?.message}
            hint={
              <PasswordRequirements
                value={password}
                email={email}
                serverCodes={serverCodes}
                invalid={Boolean(errors.password)}
              />
            }
          >
            <PasswordInput
              aria-required
              autoComplete="new-password"
              {...form.register("password")}
            />
          </Field>
          <Controller
            control={form.control}
            name="terms"
            render={({ field, fieldState }) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="register-terms"
                    ref={field.ref}
                    checked={field.value}
                    onCheckedChange={(value) => field.onChange(value === true)}
                    onBlur={field.onBlur}
                    aria-required
                    aria-invalid={fieldState.invalid || undefined}
                    aria-describedby={fieldState.error ? "register-terms-error" : undefined}
                    className="mt-0.5"
                  />
                  <label htmlFor="register-terms" className="text-sm leading-snug text-ink">
                    {t("register.terms")}
                  </label>
                </div>
                <FieldMessage id="register-terms-error" message={fieldState.error?.message} />
              </div>
            )}
          />
          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full"
            loading={register.isPending}
            loadingText={t("register.submitting")}
            disabled={limit.blocked}
          >
            {t("register.submit")}
          </Button>
        </form>
      </AuthItem>
      <AuthItem>
        <AuthSwitch
          prompt={t("register.haveAccount")}
          to={withNext("/login", next)}
          label={t("register.signIn")}
        />
      </AuthItem>
    </AuthStack>
  );
}
