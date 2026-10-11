import { useQueryClient } from "@tanstack/react-query";
import { Check, Link2Off, MailX, RotateCw, UserRoundX } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { hasErrorCode, isNetworkError } from "@/lib/api/errors";
import { clearFragmentToken, getFragmentToken } from "@/lib/auth/fragment-token";
import { applySignedIn, confirmEmailChange } from "@/lib/auth/session";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useTokenExchange } from "@/lib/use-token-exchange";
import { Button } from "@/components/ui/button";
import { PendingPanel, StatusPanel } from "./components/auth-ui";
import { FormProblemAlert } from "./components/form-alerts";

/** Confirms a new sign-in address from the e-mailed link (signs the user in again). */
export function ConfirmEmailPage() {
  const { t } = useTranslation("auth");
  const [token] = useState(() => getFragmentToken("/confirm-email"));
  if (!token) {
    return (
      <Outcome
        title={t("confirmEmail.missingTitle")}
        tone="warning"
        icon={<MailX />}
        body={t("confirmEmail.missingBody")}
      />
    );
  }
  return <ConfirmWithToken token={token} />;
}

function Outcome({
  title,
  tone,
  icon,
  body,
  focus = false,
}: {
  title: string;
  tone: "warning" | "danger";
  icon: ReactNode;
  body: ReactNode;
  focus?: boolean;
}) {
  const { t } = useTranslation("account");
  useDocumentTitle(title);
  return (
    <StatusPanel
      tone={tone}
      icon={icon}
      title={title}
      focusOnMount={focus}
      actions={
        <Button asChild size="lg" variant="secondary">
          <Link to="/account">{t("title")}</Link>
        </Button>
      }
    >
      {body}
    </StatusPanel>
  );
}

function ConfirmWithToken({ token }: { token: string }) {
  const { t } = useTranslation(["auth", "common"]);
  const queryClient = useQueryClient();
  const { state, retry } = useTokenExchange("confirm-email", token, confirmEmailChange);

  useEffect(() => {
    if (state.status === "success") {
      clearFragmentToken();
      applySignedIn(queryClient, state.data);
    } else if (state.status === "error" && !isNetworkError(state.error)) {
      clearFragmentToken();
    }
  }, [state, queryClient]);

  useDocumentTitle(
    state.status === "success" ? t("confirmEmail.successTitle") : t("confirmEmail.checking"),
  );

  if (state.status === "pending" || state.status === "idle") {
    return <PendingPanel title={t("confirmEmail.checking")} />;
  }
  if (state.status === "success") {
    return (
      <StatusPanel
        tone="success"
        icon={<Check strokeWidth={2.5} />}
        title={t("confirmEmail.successTitle")}
        focusOnMount
        actions={
          <Button asChild size="lg">
            <Link to="/account">{t("confirmEmail.continue")}</Link>
          </Button>
        }
      >
        <p>{t("confirmEmail.successBody", { email: state.data.user.email })}</p>
      </StatusPanel>
    );
  }
  if (isNetworkError(state.error)) {
    return (
      <StatusPanel
        tone="warning"
        icon={<RotateCw />}
        title={t("confirmEmail.checking")}
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
  if (hasErrorCode(state.error, "email_taken")) {
    return (
      <Outcome
        title={t("confirmEmail.takenTitle")}
        tone="danger"
        icon={<UserRoundX />}
        body={<p>{t("confirmEmail.takenBody")}</p>}
        focus
      />
    );
  }
  return (
    <Outcome
      title={t("confirmEmail.invalidTitle")}
      tone="danger"
      icon={<Link2Off />}
      body={
        hasErrorCode(state.error, "token_invalid") ? (
          <p>{t("confirmEmail.invalidBody")}</p>
        ) : (
          <FormProblemAlert error={state.error} />
        )
      }
      focus
    />
  );
}
