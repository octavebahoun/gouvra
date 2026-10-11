import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Link2Off } from "lucide-react";
import { useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { clearFragmentToken, getFragmentToken } from "@/lib/auth/fragment-token";
import { applySignedIn, resetPassword } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/types";
import { useDocumentTitle } from "@/lib/use-document-title";
import { Button } from "@/components/ui/button";
import { Field, PasswordInput } from "@/components/ui/field";
import { AuthHeading, AuthItem, AuthStack, StatusPanel } from "./components/auth-ui";
import { FormProblemAlert, RateLimitAlert } from "./components/form-alerts";
import { PasswordRequirements } from "./components/password-requirements";
import { applyFieldErrors, passwordErrorMessage, useRetryAfter } from "./errors";
import { newPasswordSchema, pathAfterLinkSignIn } from "./schemas";

/** Screen E — choose a new password from the e-mailed link (signs the user in, D-064). */
export function ResetPasswordPage() {
  const { t } = useTranslation("auth");
  const [token] = useState(() => getFragmentToken("/reset-password"));
  const [outcome, setOutcome] = useState<"form" | "invalid">("form");
  const [session, setSession] = useState<Session | null>(null);
  useDocumentTitle(
    !token
      ? t("reset.missingTitle")
      : session
        ? t("reset.successTitle")
        : outcome === "invalid"
          ? t("reset.invalidTitle")
          : t("reset.title"),
  );

  if (!token) {
    return (
      <StatusPanel
        tone="warning"
        icon={<KeyRound />}
        title={t("reset.missingTitle")}
        actions={
          <Button asChild size="lg">
            <Link to="/forgot-password">{t("reset.requestNew")}</Link>
          </Button>
        }
      >
        <p>{t("reset.missingBody")}</p>
      </StatusPanel>
    );
  }
  if (session) return <ResetDone session={session} />;
  if (outcome === "invalid") {
    return (
      <StatusPanel
        tone="danger"
        icon={<Link2Off />}
        title={t("reset.invalidTitle")}
        focusOnMount
        actions={
          <Button asChild size="lg">
            <Link to="/forgot-password">{t("reset.requestNew")}</Link>
          </Button>
        }
      >
        <p>{t("reset.invalidBody")}</p>
      </StatusPanel>
    );
  }
  return (
    <ResetForm
      token={token}
      onDone={setSession}
      onInvalid={() => {
        clearFragmentToken();
        setOutcome("invalid");
      }}
    />
  );
}

function ResetForm({
  token,
  onDone,
  onInvalid,
}: {
  token: string;
  onDone: (session: Session) => void;
  onInvalid: () => void;
}) {
  const { t } = useTranslation("auth");
  const queryClient = useQueryClient();
  const limit = useRetryAfter();
  const [problem, setProblem] = useState<unknown>(null);
  const [serverCodes, setServerCodes] = useState<string[]>([]);
  const reset = useMutation({
    mutationFn: (password: string) => resetPassword(token, password),
  });

  const schema = useMemo(() => z.object({ password: newPasswordSchema(t) }), [t]);
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
  });
  const password = useWatch({ control: form.control, name: "password" });

  const onSubmit = form.handleSubmit(async ({ password: value }) => {
    setProblem(null);
    setServerCodes([]);
    limit.reset();
    try {
      const session = await reset.mutateAsync(value);
      clearFragmentToken();
      applySignedIn(queryClient, session);
      onDone(session);
    } catch (error) {
      if (limit.capture(error)) return;
      if (hasErrorCode(error, "token_invalid")) {
        onInvalid();
        return;
      }
      if (isApiError(error)) {
        setServerCodes(error.fieldErrors.filter((f) => f.field === "password").map((f) => f.code));
      }
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "password"
          ? { field: "password", message: passwordErrorMessage(fieldError.code, t) }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });

  return (
    <AuthStack>
      <AuthItem>
        <AuthHeading title={t("reset.title")} description={t("reset.subtitle")} />
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
            label={t("fields.newPassword")}
            error={form.formState.errors.password?.message}
            hint={
              <PasswordRequirements
                value={password}
                serverCodes={serverCodes}
                invalid={Boolean(form.formState.errors.password)}
              />
            }
          >
            <PasswordInput
              aria-required
              autoComplete="new-password"
              {...form.register("password")}
            />
          </Field>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            loading={reset.isPending}
            disabled={limit.blocked}
          >
            {t("reset.submit")}
          </Button>
        </form>
      </AuthItem>
    </AuthStack>
  );
}

function ResetDone({ session }: { session: Session }) {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  return (
    <StatusPanel
      tone="success"
      icon={<Check strokeWidth={2.5} />}
      title={t("reset.successTitle")}
      focusOnMount
      actions={
        <Button size="lg" onClick={() => void navigate(pathAfterLinkSignIn(session))}>
          {t("verify.continue")}
        </Button>
      }
    >
      <p>{t("reset.successBody")}</p>
    </StatusPanel>
  );
}
