import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Link2Off, Mail, MailCheck, RotateCw, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import { z } from "zod";
import { hasErrorCode, isNetworkError } from "@/lib/api/errors";
import { clearFragmentToken, getFragmentToken } from "@/lib/auth/fragment-token";
import { applySignedIn, useResendVerification, useSession, verifyEmail } from "@/lib/auth/session";
import type { Session } from "@/lib/auth/types";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useTokenExchange } from "@/lib/use-token-exchange";
import { PageLoader } from "@/components/layout/page-loader";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { Field, Input } from "@/components/ui/field";
import { AuthHeading, AuthItem, AuthStack, PendingPanel, StatusPanel } from "./components/auth-ui";
import { FormProblemAlert, RateLimitAlert } from "./components/form-alerts";
import { ResendButton } from "./components/resend-button";
import { applyFieldErrors, useRetryAfter } from "./errors";
import { emailSchema, pathAfterLinkSignIn } from "./schemas";

/**
 * Screen D — e-mail verification:
 * - opened from the e-mail (`#token=…`): confirm the address, which signs the user in;
 * - signed in but not confirmed yet: "check your inbox" with resend and sign out;
 * - signed out without a link: ask for a new link.
 */
export function VerifyEmailPage() {
  const [token] = useState(() => getFragmentToken("/verify-email"));
  const session = useSession();
  if (token) return <VerifyWithToken token={token} signedIn={Boolean(session.data)} />;
  if (session.isPending) return <PageLoader className="min-h-[40vh]" />;
  if (session.data?.user.email_verified) return <Navigate to="/app" replace />;
  if (session.data) return <PendingVerification session={session.data} />;
  return <RequestNewLink />;
}

function VerifyWithToken({ token, signedIn }: { token: string; signedIn: boolean }) {
  const { t } = useTranslation(["auth", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { state, retry } = useTokenExchange("verify-email", token, verifyEmail);
  const settled = state.status === "success" || state.status === "error";
  const networkFailure = state.status === "error" && isNetworkError(state.error);

  useEffect(() => {
    if (state.status === "success") {
      clearFragmentToken();
      applySignedIn(queryClient, state.data);
    } else if (state.status === "error" && !isNetworkError(state.error)) {
      clearFragmentToken();
    }
  }, [state, queryClient]);

  useDocumentTitle(
    state.status === "success"
      ? t("verify.successTitle")
      : state.status === "error"
        ? t("verify.invalidTitle")
        : t("verify.checking"),
  );

  if (!settled) return <PendingPanel title={t("verify.checking")} />;

  if (state.status === "success") {
    const target = pathAfterLinkSignIn(state.data);
    const body =
      target === "/invite"
        ? t("verify.successInvite")
        : target === "/onboarding"
          ? t("verify.successNext")
          : t("verify.successReady");
    return (
      <StatusPanel
        tone="success"
        icon={<Check strokeWidth={2.5} />}
        title={t("verify.successTitle")}
        focusOnMount
        actions={
          <Button size="lg" onClick={() => void navigate(target)}>
            {target === "/invite" ? t("verify.continueInvite") : t("verify.continue")}
          </Button>
        }
      >
        <p>{body}</p>
      </StatusPanel>
    );
  }

  if (networkFailure) {
    return (
      <StatusPanel
        tone="warning"
        icon={<WifiOff />}
        title={t("verify.checking")}
        focusOnMount
        actions={
          <Button size="lg" leftIcon={<RotateCw aria-hidden />} onClick={retry}>
            {t("common:actions.retry")}
          </Button>
        }
      >
        <p>{t("errors.network")}</p>
      </StatusPanel>
    );
  }

  const expired = hasErrorCode(state.error, "token_invalid");
  return (
    <AuthStack>
      <StatusPanel tone="danger" icon={<Link2Off />} title={t("verify.invalidTitle")} focusOnMount>
        {expired ? <p>{t("verify.invalidBody")}</p> : <FormProblemAlert error={state.error} />}
      </StatusPanel>
      <AuthItem>{signedIn ? <ResendSignedIn /> : <RequestNewLinkForm />}</AuthItem>
    </AuthStack>
  );
}

function ResendSignedIn() {
  const resend = useResendVerification();
  return <ResendButton variant="secondary" onResend={() => resend.mutateAsync(undefined)} />;
}

function PendingVerification({ session }: { session: Session }) {
  const { t } = useTranslation(["auth", "common"]);
  const sessionQuery = useSession();
  const resend = useResendVerification();
  const { signOut, pending: signingOut } = useSignOut();
  const [checking, setChecking] = useState(false);
  const [stillPending, setStillPending] = useState(false);
  useDocumentTitle(t("verify.pendingTitle"));

  /** Confirmed in another tab or device? Refresh the session; the page moves on by itself. */
  const recheck = async () => {
    setChecking(true);
    setStillPending(false);
    const result = await sessionQuery.refetch();
    setChecking(false);
    if (!result.data?.user.email_verified) setStillPending(true);
  };

  return (
    <StatusPanel
      tone="info"
      icon={<Mail />}
      title={t("verify.pendingTitle")}
      actions={
        <>
          <ResendButton onResend={() => resend.mutateAsync(undefined)} />
          <Button
            variant="tertiary"
            size="lg"
            loading={checking}
            leftIcon={<MailCheck aria-hidden />}
            onClick={() => void recheck()}
          >
            {t("verify.pendingRefresh")}
          </Button>
        </>
      }
      footer={
        <div className="flex flex-col gap-1.5">
          <p className="[overflow-wrap:anywhere]">
            {t("verify.signedInAs", { email: session.user.email })}
          </p>
          <p>
            {t("verify.wrongAddress")}{" "}
            <Button
              variant="link"
              loading={signingOut}
              className="align-baseline"
              onClick={() => signOut("/login")}
            >
              {t("common:actions.signOut")}
            </Button>
          </p>
        </div>
      }
    >
      <p>{t("verify.pendingBody", { email: session.user.email })}</p>
      {stillPending ? <Alert tone="warning" title={t("verify.pendingStill")} /> : null}
    </StatusPanel>
  );
}

function RequestNewLink() {
  const { t } = useTranslation("auth");
  useDocumentTitle(t("verify.requestTitle"));
  return (
    <AuthStack>
      <AuthItem>
        <AuthHeading title={t("verify.requestTitle")} description={t("verify.requestSubtitle")} />
      </AuthItem>
      <AuthItem>
        <RequestNewLinkForm />
      </AuthItem>
    </AuthStack>
  );
}

/** Signed out: ask for a new confirmation link. The answer never reveals the account. */
function RequestNewLinkForm() {
  const { t } = useTranslation("auth");
  const resend = useResendVerification();
  const limit = useRetryAfter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const schema = useMemo(() => z.object({ email: emailSchema(t) }), [t]);
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = form.handleSubmit(async ({ email }) => {
    setProblem(null);
    limit.reset();
    try {
      await resend.mutateAsync(email);
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

  return (
    <form noValidate onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5">
      {sentTo ? <Alert tone="success" title={t("verify.requestSent", { email: sentTo })} /> : null}
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
        variant={sentTo ? "secondary" : "primary"}
        loading={resend.isPending}
        disabled={limit.blocked}
      >
        {t("verify.requestSubmit")}
      </Button>
    </form>
  );
}
