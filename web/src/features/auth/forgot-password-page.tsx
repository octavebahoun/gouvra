import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, MailCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";
import { withNext } from "@/lib/auth/next";
import { useForgotPassword } from "@/lib/auth/session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { AuthHeading, AuthItem, AuthStack, StatusPanel } from "./components/auth-ui";
import { FormProblemAlert, RateLimitAlert } from "./components/form-alerts";
import { ResendButton } from "./components/resend-button";
import { applyFieldErrors, useRetryAfter } from "./errors";
import { emailSchema } from "./schemas";

/** Screen E — request a reset link. The answer is neutral whether the account exists or not. */
export function ForgotPasswordPage() {
  const { t } = useTranslation("auth");
  const [params] = useSearchParams();
  const next = params.get("next");
  const forgot = useForgotPassword();
  const limit = useRetryAfter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  useDocumentTitle(sentTo ? t("forgot.sentTitle") : t("forgot.title"));

  const schema = useMemo(() => z.object({ email: emailSchema(t) }), [t]);
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setProblem(null);
    limit.reset();
    try {
      await forgot.mutateAsync(email);
      setSentTo(email);
    } catch (error) {
      if (limit.capture(error)) return;
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "email"
          ? { field: "email", message: t("validation.emailInvalid") }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });

  const backToLogin = (
    <Button asChild variant="tertiary" size="lg" leftIcon={<ArrowLeft aria-hidden />}>
      <Link to={withNext("/login", next)}>{t("forgot.back")}</Link>
    </Button>
  );

  if (sentTo) {
    return (
      <StatusPanel
        tone="info"
        icon={<MailCheck />}
        title={t("forgot.sentTitle")}
        focusOnMount
        actions={
          <>
            <ResendButton onResend={() => forgot.mutateAsync(sentTo)} />
            {backToLogin}
          </>
        }
      >
        <p>{t("forgot.sentBody", { email: sentTo })}</p>
        <p>{t("register.sentHelp")}</p>
      </StatusPanel>
    );
  }

  return (
    <AuthStack>
      <AuthItem>
        <AuthHeading title={t("forgot.title")} description={t("forgot.subtitle")} />
      </AuthItem>
      <AuthItem>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
          {problem ? <FormProblemAlert error={problem} /> : null}
          <RateLimitAlert
            remaining={limit.remaining}
            initialSeconds={limit.initialSeconds}
            over={limit.over}
          />
          <Field label={t("fields.email")} error={form.formState.errors.email?.message}>
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
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={forgot.isPending}
            disabled={limit.blocked}
          >
            {t("forgot.submit")}
          </Button>
        </form>
      </AuthItem>
      <AuthItem className="flex justify-center">{backToLogin}</AuthItem>
    </AuthStack>
  );
}
