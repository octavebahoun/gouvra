import { zodResolver } from "@hookform/resolvers/zod";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { z } from "zod";
import { hasErrorCode } from "@/lib/api/errors";
import { withNext } from "@/lib/auth/next";
import { endSigningOut, useLogin } from "@/lib/auth/session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field, FormError, Input, PasswordInput } from "@/components/ui/field";
import { AuthHeading, AuthItem, AuthStack, AuthSwitch } from "./components/auth-ui";
import { FormProblemAlert, RateLimitAlert } from "./components/form-alerts";
import { OAuthButtons } from "./components/oauth-buttons";
import { applyFieldErrors, useRetryAfter } from "./errors";
import { emailSchema } from "./schemas";

function oauthErrorMessage(reason: string, t: TFunction<"auth">): string {
  switch (reason) {
    case "state":
      return t("oauth.errors.state");
    case "denied":
      return t("oauth.errors.denied");
    case "exchange":
      return t("oauth.errors.exchange");
    case "email_unverified":
      return t("oauth.errors.email_unverified");
    case "unreachable":
      return t("oauth.errors.unreachable");
    case "disabled":
      return t("oauth.errors.disabled");
    default:
      return t("oauth.errors.unknown");
  }
}

/** Screen C — sign in. Errors stay neutral: they never reveal whether an account exists. */
export function LoginPage() {
  const { t } = useTranslation("auth");
  const [params, setParams] = useSearchParams();
  const next = params.get("next");
  const [oauthError] = useState(() => params.get("oauth_error"));
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const login = useLogin();
  const limit = useRetryAfter();
  useDocumentTitle(t("login.title"));

  useEffect(() => {
    endSigningOut();
  }, []);

  // The OAuth error is shown once; it doesn't stay in the address bar or history.
  useEffect(() => {
    if (!params.has("oauth_error")) return;
    const cleaned = new URLSearchParams(params);
    cleaned.delete("oauth_error");
    setParams(cleaned, { replace: true });
  }, [params, setParams]);

  const schema = useMemo(
    () =>
      z.object({
        email: emailSchema(t),
        password: z.string().min(1, t("validation.passwordRequired")),
      }),
    [t],
  );
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setInvalid(false);
    setProblem(null);
    limit.reset();
    try {
      await login.mutateAsync(values);
      // <GuestOnly> now sees the session and continues to `next`.
    } catch (error) {
      if (limit.capture(error)) return;
      if (hasErrorCode(error, "invalid_credentials")) {
        setInvalid(true);
        form.setFocus("password", { shouldSelect: true });
        return;
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "email"
          ? { field: "email", message: t("validation.emailInvalid") }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });

  const isInvite = next?.startsWith("/invite") ?? false;

  return (
    <AuthStack>
      <AuthItem>
        <AuthHeading title={t("login.title")} description={t("login.subtitle")} />
      </AuthItem>
      {isInvite ? (
        <AuthItem>
          <Alert tone="info" title={t("login.inviteHint")} />
        </AuthItem>
      ) : null}
      {oauthError ? (
        <AuthItem>
          <Alert tone="danger" title={t("oauth.errorTitle")}>
            {oauthErrorMessage(oauthError, t)}
          </Alert>
        </AuthItem>
      ) : null}
      <AuthItem>
        <OAuthButtons next={next} />
      </AuthItem>
      <AuthItem>
        <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
          {invalid ? <FormError>{t("login.invalid")}</FormError> : null}
          {problem ? <FormProblemAlert error={problem} /> : null}
          <RateLimitAlert
            remaining={limit.remaining}
            initialSeconds={limit.initialSeconds}
            over={limit.over}
          />
          <Field label={t("fields.email")} error={errors.email?.message}>
            <Input
              type="email"
              aria-required
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={t("fields.emailPlaceholder")}
              {...form.register("email")}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <Field label={t("fields.password")} error={errors.password?.message}>
              <PasswordInput
                aria-required
                autoComplete="current-password"
                {...form.register("password")}
              />
            </Field>
            <Link
              to={withNext("/forgot-password", next)}
              className="self-end rounded-sm text-[13px] font-medium text-brand-text underline-offset-4 hover:underline"
            >
              {t("login.forgot")}
            </Link>
          </div>
          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full"
            loading={login.isPending}
            loadingText={t("login.submitting")}
            disabled={limit.blocked}
          >
            {t("login.submit")}
          </Button>
        </form>
      </AuthItem>
      <AuthItem>
        <AuthSwitch
          prompt={t("login.noAccount")}
          to={withNext("/register", next)}
          label={t("login.createAccount")}
        />
      </AuthItem>
    </AuthStack>
  );
}
