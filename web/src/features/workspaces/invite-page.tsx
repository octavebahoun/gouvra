import { useQuery } from "@tanstack/react-query";
import {
  AtSign,
  CalendarClock,
  CircleSlash,
  Hourglass,
  Link2Off,
  LogIn,
  LogOut,
  MailQuestion,
  RotateCw,
  ShieldCheck,
  UserPlus,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { hasErrorCode, isNetworkError } from "@/lib/api/errors";
import { clearFragmentToken, getFragmentToken } from "@/lib/auth/fragment-token";
import { useSession } from "@/lib/auth/session";
import { clearPendingInvite, readPendingInvite, savePendingInvite } from "@/lib/auth/storage";
import { asRole, type Session } from "@/lib/auth/types";
import { useSignOut } from "@/lib/auth/use-sign-out";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { fadeUp } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import {
  AuthHeading,
  AuthItem,
  AuthStack,
  PendingPanel,
  StatusPanel,
} from "@/features/auth/components/auth-ui";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { previewInvitation, useAcceptInvitation, type InvitationPreview } from "./api";

/**
 * Invitation link (`/invite#token=…`): preview what it points to, then sign in or create an
 * account (coming back here), and accept with the invited address (D-065).
 */
export function InvitePage() {
  const { t } = useTranslation("auth");
  const [fromLink] = useState(() => getFragmentToken("/invite"));
  const [token] = useState(() => fromLink ?? readPendingInvite());

  // Opened from the e-mail: keep the invitation across sign-in / sign-up (maybe in a new tab).
  useEffect(() => {
    if (fromLink) {
      savePendingInvite(fromLink);
      clearFragmentToken();
    }
  }, [fromLink]);

  if (!token) {
    return <Missing title={t("invite.missingTitle")} body={t("invite.missingBody")} />;
  }
  return <InviteWithToken token={token} />;
}

function Missing({ title, body }: { title: string; body: string }) {
  useDocumentTitle(title);
  return (
    <StatusPanel tone="warning" icon={<MailQuestion />} title={title}>
      <p>{body}</p>
    </StatusPanel>
  );
}

function InviteWithToken({ token }: { token: string }) {
  const { t } = useTranslation(["auth", "common"]);
  const session = useSession();
  const preview = useQuery({
    queryKey: ["invitation-preview", token],
    queryFn: () => previewInvitation(token),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const final =
    preview.data && preview.data.status !== "pending"
      ? preview.data.status
      : preview.error && !isNetworkError(preview.error)
        ? "invalid"
        : null;
  useEffect(() => {
    if (final) clearPendingInvite();
  }, [final]);

  if (preview.isPending || session.isPending) return <PendingPanel title={t("invite.loading")} />;

  if (preview.error) {
    if (isNetworkError(preview.error)) {
      return (
        <StatusPanel
          tone="warning"
          icon={<RotateCw />}
          title={t("invite.loading")}
          actions={
            <Button size="lg" onClick={() => void preview.refetch()}>
              {t("common:actions.retry")}
            </Button>
          }
        >
          <p>{t("errors.network")}</p>
        </StatusPanel>
      );
    }
    if (hasErrorCode(preview.error, "invitation_invalid")) {
      return (
        <Final
          icon={<Link2Off />}
          title={t("invite.invalidTitle")}
          body={t("invite.invalidBody")}
          signedIn={Boolean(session.data)}
        />
      );
    }
    return (
      <StatusPanel tone="danger" icon={<Link2Off />} title={t("invite.invalidTitle")}>
        <FormProblemAlert error={preview.error} />
      </StatusPanel>
    );
  }

  const invitation = preview.data;
  switch (invitation.status) {
    case "expired":
      return (
        <Final
          icon={<Hourglass />}
          title={t("invite.expiredTitle")}
          body={
            invitation.inviter_name
              ? t("invite.expiredBody", { inviter: invitation.inviter_name })
              : t("invite.expiredBodyAnonymous")
          }
          signedIn={Boolean(session.data)}
        />
      );
    case "revoked":
      return (
        <Final
          icon={<CircleSlash />}
          title={t("invite.revokedTitle")}
          body={t("invite.revokedBody")}
          signedIn={Boolean(session.data)}
        />
      );
    case "accepted":
      return (
        <Final
          icon={<UserRoundCheck />}
          title={t("invite.acceptedTitle")}
          body={t("invite.acceptedBody")}
          signedIn={Boolean(session.data)}
          tone="info"
        />
      );
    default:
      return (
        <PendingInvitation token={token} invitation={invitation} session={session.data ?? null} />
      );
  }
}

function Final({
  icon,
  title,
  body,
  signedIn,
  tone = "danger",
}: {
  icon: ReactNode;
  title: string;
  body: string;
  signedIn: boolean;
  tone?: "danger" | "info";
}) {
  const { t } = useTranslation("auth");
  useDocumentTitle(title);
  return (
    <StatusPanel
      tone={tone}
      icon={icon}
      title={title}
      actions={
        <Button asChild size="lg" variant="secondary">
          <Link to={signedIn ? "/app" : "/login"}>
            {signedIn ? t("invite.openWorkspaces") : t("login.submit")}
          </Link>
        </Button>
      }
    >
      <p>{body}</p>
    </StatusPanel>
  );
}

function PendingInvitation({
  token,
  invitation,
  session,
}: {
  token: string;
  invitation: InvitationPreview;
  session: Session | null;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const { date } = useFormatters();
  const navigate = useNavigate();
  const accept = useAcceptInvitation();
  const { signOut, pending: signingOut } = useSignOut();
  const role = t(`common:workspace.role.${asRole(invitation.role)}`);
  useDocumentTitle(t("invite.title", { workspace: invitation.workspace_name }));

  const onAccept = () => {
    accept.mutate(token, {
      onSuccess: (workspace) => {
        clearPendingInvite();
        toast.success(t("invite.joined", { workspace: workspace.name }));
        void navigate(`/w/${workspace.slug}/overview`, { replace: true });
      },
    });
  };

  const mismatch = hasErrorCode(accept.error, "invitation_email_mismatch");
  const gone = hasErrorCode(accept.error, "invitation_invalid");
  if (mismatch && session) {
    return (
      <StatusPanel
        tone="warning"
        icon={<UserRoundX />}
        title={t("invite.mismatchTitle")}
        focusOnMount
        actions={
          <Button
            size="lg"
            loading={signingOut}
            leftIcon={<LogOut aria-hidden />}
            onClick={() => signOut(null)}
          >
            {t("invite.signOutAndContinue")}
          </Button>
        }
      >
        <p>
          {t("invite.mismatchBody", { hint: invitation.email_hint, email: session.user.email })}
        </p>
      </StatusPanel>
    );
  }
  if (gone) {
    return (
      <Final
        icon={<Link2Off />}
        title={t("invite.invalidTitle")}
        body={t("invite.invalidBody")}
        signedIn
      />
    );
  }

  return (
    <AuthStack>
      <AuthItem>
        <p className="mb-4 text-xs font-semibold tracking-[0.14em] text-brand-text uppercase">
          {t("invite.eyebrow")}
        </p>
        <div className="flex items-center gap-4">
          <Avatar name={invitation.workspace_name} square size="lg" />
          <AuthHeading title={t("invite.title", { workspace: invitation.workspace_name })} />
        </div>
        <p className="mt-4 text-sm leading-relaxed text-pretty text-muted">
          {invitation.inviter_name
            ? t("invite.invitedBy", { inviter: invitation.inviter_name, role })
            : t("invite.invitedAnonymous", { role })}
        </p>
      </AuthItem>
      <AuthItem>
        <dl className="divide-y divide-line rounded-card border border-line bg-surface text-sm shadow-sm">
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <dt className="flex items-center gap-2 text-muted">
              <AtSign aria-hidden className="size-4" />
              {t("invite.sentTo")}
            </dt>
            <dd className="min-w-0 truncate text-ink">{invitation.email_hint}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <dt className="flex items-center gap-2 text-muted">
              <CalendarClock aria-hidden className="size-4" />
              {t("invite.expires")}
            </dt>
            <dd className="text-ink">{date(invitation.expires_at)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <dt className="flex items-center gap-2 text-muted">
              <ShieldCheck aria-hidden className="size-4" />
              {t("common:workspace.role.label")}
            </dt>
            <dd>
              <Badge tone="brand">{role}</Badge>
            </dd>
          </div>
        </dl>
      </AuthItem>
      {session && !session.user.email_verified ? (
        <AuthItem>
          <Alert
            tone="warning"
            title={t("verify.pendingTitle")}
            action={
              <Button asChild size="sm" variant="secondary">
                <Link to="/verify-email">{t("common:actions.continue")}</Link>
              </Button>
            }
          >
            {t("verify.pendingBody", { email: session.user.email })}
          </Alert>
        </AuthItem>
      ) : null}
      {accept.error && !mismatch ? (
        <AuthItem>
          <FormProblemAlert error={accept.error} />
        </AuthItem>
      ) : null}
      <AuthItem className="flex flex-col gap-2.5">
        {session ? (
          <>
            <Button
              size="lg"
              loading={accept.isPending}
              loadingText={t("invite.accepting")}
              disabled={!session.user.email_verified}
              leftIcon={<UserPlus aria-hidden />}
              onClick={onAccept}
            >
              {t("invite.accept")}
            </Button>
            <motion.p
              variants={fadeUp}
              className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-[13px] text-muted"
            >
              <span>{t("invite.signedInAs", { email: session.user.email })}</span>
              <span>{t("invite.notYou")}</span>
              <Button variant="link" size="sm" loading={signingOut} onClick={() => signOut(null)}>
                {t("invite.signOut")}
              </Button>
            </motion.p>
          </>
        ) : (
          <>
            <Button asChild size="lg" leftIcon={<LogIn aria-hidden />}>
              <Link to="/login?next=%2Finvite">{t("invite.signInToAccept")}</Link>
            </Button>
            <Button asChild size="lg" variant="secondary" leftIcon={<UserPlus aria-hidden />}>
              <Link to="/register?next=%2Finvite">{t("invite.createAccount")}</Link>
            </Button>
            <p className="pt-1 text-center text-[13px] text-pretty text-muted">
              {t("invite.signedOutHint")}
            </p>
          </>
        )}
      </AuthItem>
    </AuthStack>
  );
}
