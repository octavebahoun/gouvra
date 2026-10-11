import { Mail, RotateCw, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { hasErrorCode } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { asRole, ASSIGNABLE_ROLES, type AssignableRole } from "@/lib/auth/types";
import { useFormatters } from "@/lib/format";
import { useMediaQuery } from "@/lib/use-media-query";
import { SettingsSection } from "@/components/layout/settings-section";
import { duration, ease, listItem, staggerChildren } from "@/components/motion/presets";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { EmptyState, ErrorState } from "@/components/ui/states";
import {
  useChangeRole,
  useInvitations,
  useMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  type Invitation,
  type Member,
  type Workspace,
} from "../api";
import { InviteForm } from "../invite-form";
import { useCurrentWorkspace } from "../use-current-workspace";

/** Settings › Members: invite people, change roles, remove members, follow invitations. */
export function MembersTab() {
  const { t } = useTranslation("settings");
  const { workspace, detail } = useCurrentWorkspace();
  const canInvite = can(detail.data, "invitations:manage");
  return (
    <motion.div
      variants={staggerChildren(0.06)}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-10"
    >
      {canInvite ? (
        <SettingsSection
          id="invite"
          title={t("invite.title")}
          description={t("invite.description")}
        >
          <Card className="p-5">
            <InviteForm workspaceId={workspace.id} />
          </Card>
        </SettingsSection>
      ) : null}
      <SettingsSection
        id="members"
        title={t("members.title")}
        description={t("members.description")}
      >
        <MembersList
          workspace={detail.data}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
        />
      </SettingsSection>
      <SettingsSection
        id="invitations"
        title={t("invitations.title")}
        description={t("invitations.description")}
      >
        <InvitationsList workspaceId={workspace.id} canManage={canInvite} />
      </SettingsSection>
    </motion.div>
  );
}

function roleError(
  error: unknown,
  t: (key: "errors.owner_immutable" | "errors.self_role_change" | "errors.generic") => string,
) {
  if (hasErrorCode(error, "owner_immutable")) return t("errors.owner_immutable");
  if (hasErrorCode(error, "self_role_change")) return t("errors.self_role_change");
  return t("errors.generic");
}

function MembersList({
  workspace,
  workspaceId,
  workspaceName,
}: {
  workspace: Workspace | undefined;
  workspaceId: string;
  workspaceName: string;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const members = useMembers(workspaceId);
  const changeRole = useChangeRole(workspaceId);
  const removeMember = useRemoveMember(workspaceId);
  const [removing, setRemoving] = useState<Member | null>(null);
  const canManage = can(workspace, "members:manage");
  const wide = useMediaQuery("(min-width: 768px)");

  if (members.isPending) return <ListSkeleton rows={3} />;
  if (members.isError) {
    return (
      <Card>
        <ErrorState
          compact
          title={t("members.loadError")}
          error={members.error}
          onRetry={() => void members.refetch()}
        />
      </Card>
    );
  }

  const onRoleChange = (member: Member, role: AssignableRole) => {
    changeRole.mutate(
      { userId: member.user_id, role },
      {
        onSuccess: () =>
          toast.success(
            t("members.roleChanged", {
              name: member.display_name,
              role: t(`common:workspace.role.${role}`).toLowerCase(),
            }),
          ),
        onError: (error) => toast.error(roleError(error, t)),
      },
    );
  };

  const rows = members.data.map((member) => ({
    member,
    editable: canManage && !member.is_you && member.role !== "owner",
  }));

  return (
    <Card className="overflow-hidden">
      {!canManage ? (
        <div className="border-b border-line p-4">
          <Alert tone="info" title={t("members.readOnly")} />
        </div>
      ) : null}
      {wide ? (
        <table className="w-full text-sm">
          <caption className="sr-only">{t("members.title")}</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs font-medium text-muted">
              <th scope="col" className="px-5 py-2.5 font-medium">
                {t("members.name")}
              </th>
              <th scope="col" className="w-44 px-3 py-2.5 font-medium">
                {t("members.role")}
              </th>
              <th scope="col" className="w-36 px-3 py-2.5 font-medium">
                {t("members.joined")}
              </th>
              <th scope="col" className="w-16 px-5 py-2.5">
                <span className="sr-only">{t("members.actions")}</span>
              </th>
            </tr>
          </thead>
          <motion.tbody variants={staggerChildren(0.04)} initial="hidden" animate="visible">
            <AnimatePresence initial={false}>
              {rows.map(({ member, editable }) => (
                <motion.tr
                  key={member.user_id}
                  layout="position"
                  variants={listItem}
                  exit={{ opacity: 0, transition: { duration: duration.fast, ease: ease.exit } }}
                  className="border-b border-line last:border-0"
                >
                  <td className="px-5 py-3">
                    <MemberIdentity member={member} />
                  </td>
                  <td className="px-3 py-3">
                    <RoleControl member={member} editable={editable} onChange={onRoleChange} />
                  </td>
                  <td className="px-3 py-3 text-[13px] text-muted">
                    <JoinedDate value={member.joined_at} />
                  </td>
                  <td className="px-5 py-3 text-right">
                    {editable ? (
                      <IconButton
                        label={t("members.removeLabel", { name: member.display_name })}
                        icon={<Trash2 aria-hidden />}
                        variant="danger-ghost"
                        size="icon-sm"
                        onClick={() => setRemoving(member)}
                      />
                    ) : null}
                  </td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </motion.tbody>
        </table>
      ) : (
        <motion.ul
          variants={staggerChildren(0.04)}
          initial="hidden"
          animate="visible"
          className="divide-y divide-line"
          aria-label={t("members.title")}
        >
          <AnimatePresence initial={false}>
            {rows.map(({ member, editable }) => (
              <motion.li
                key={member.user_id}
                layout="position"
                variants={listItem}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
                className="flex flex-col gap-3 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <MemberIdentity member={member} />
                  {editable ? (
                    <IconButton
                      label={t("members.removeLabel", { name: member.display_name })}
                      icon={<Trash2 aria-hidden />}
                      variant="danger-ghost"
                      onClick={() => setRemoving(member)}
                    />
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-3 pl-12">
                  <RoleControl member={member} editable={editable} onChange={onRoleChange} />
                  <span className="shrink-0 text-xs text-muted">
                    <JoinedDate value={member.joined_at} />
                  </span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("members.removeDialogTitle", {
          name: removing?.display_name ?? "",
          workspace: workspaceName,
        })}
        description={t("members.removeDialogBody")}
        confirmLabel={t("members.removeConfirm")}
        pending={removeMember.isPending}
        onConfirm={() => {
          if (!removing) return;
          const target = removing;
          removeMember.mutate(target.user_id, {
            onSuccess: () => {
              setRemoving(null);
              toast.success(t("members.removed", { name: target.display_name }));
            },
            onError: (error) => toast.error(roleError(error, t)),
          });
        }}
      />
    </Card>
  );
}

function MemberIdentity({ member }: { member: Member }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={member.display_name} size="md" />
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{member.display_name}</span>
          {member.is_you ? <Badge tone="neutral">{t("members.you")}</Badge> : null}
        </p>
        <p className="truncate text-[13px] text-muted">{member.email}</p>
      </div>
    </div>
  );
}

function RoleControl({
  member,
  editable,
  onChange,
}: {
  member: Member;
  editable: boolean;
  onChange: (member: Member, role: AssignableRole) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const role = asRole(member.role);
  if (!editable) {
    return (
      <Badge
        tone={role === "owner" ? "brand" : "outline"}
        title={
          role === "owner"
            ? t("members.ownerHint")
            : member.is_you
              ? t("members.selfHint")
              : undefined
        }
      >
        {t(`common:workspace.role.${role}`)}
      </Badge>
    );
  }
  return (
    <Select
      value={role}
      onValueChange={(value) => {
        if (value !== role) onChange(member, value as AssignableRole);
      }}
      aria-label={t("members.roleLabel", { name: member.display_name })}
      className="w-40"
      options={ASSIGNABLE_ROLES.map((value) => ({
        value,
        label: t(`common:workspace.role.${value}`),
        description: t(`roles.${value}`),
      }))}
    />
  );
}

function JoinedDate({ value }: { value: string }) {
  const { date, dateTime } = useFormatters();
  return (
    <time dateTime={value} title={dateTime(value)}>
      {date(value)}
    </time>
  );
}

function InvitationsList({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const invitations = useInvitations(workspaceId);
  const resend = useResendInvitation(workspaceId);
  const revoke = useRevokeInvitation(workspaceId);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  if (invitations.isPending) return <ListSkeleton rows={2} />;
  if (invitations.isError) {
    return (
      <Card>
        <ErrorState
          compact
          title={t("invitations.loadError")}
          error={invitations.error}
          onRetry={() => void invitations.refetch()}
        />
      </Card>
    );
  }
  if (invitations.data.length === 0) {
    return (
      <Card>
        <EmptyState
          compact
          illustration="members"
          title={t("invitations.emptyTitle")}
          description={t("invitations.emptyBody")}
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <motion.ul
        variants={staggerChildren(0.04)}
        initial="hidden"
        animate="visible"
        className="divide-y divide-line"
        aria-label={t("invitations.title")}
      >
        <AnimatePresence initial={false}>
          {invitations.data.map((invitation) => (
            <motion.li
              key={invitation.id}
              layout="position"
              variants={listItem}
              exit={{ opacity: 0, x: -8, transition: { duration: duration.fast, ease: ease.exit } }}
            >
              <InvitationRow
                invitation={invitation}
                canManage={canManage}
                resending={resend.isPending && resend.variables === invitation.id}
                onResend={() =>
                  resend.mutate(invitation.id, {
                    onSuccess: () =>
                      toast.success(t("invitations.resent", { email: invitation.email })),
                    onError: () => toast.error(t("errors.generic")),
                  })
                }
                onRevoke={() => setRevoking(invitation)}
              />
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("invitations.revokeDialogTitle", { email: revoking?.email ?? "" })}
        description={t("invitations.revokeDialogBody")}
        confirmLabel={t("invitations.revokeConfirm")}
        pending={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          const target = revoking;
          revoke.mutate(target.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success(t("invitations.revoked", { email: target.email }));
            },
            onError: () => toast.error(t("errors.generic")),
          });
        }}
      />
    </Card>
  );
}

function InvitationRow({
  invitation,
  canManage,
  resending,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  canManage: boolean;
  resending: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { relative, dateTime } = useFormatters();
  const expired = invitation.status === "expired";
  const statusTone = {
    pending: "brand",
    expired: "warning",
    accepted: "success",
    revoked: "neutral",
  } as const;
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <Mail aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-ink">{invitation.email}</span>
            <Badge tone={statusTone[invitation.status]}>
              {t(`invitations.status.${invitation.status}`)}
            </Badge>
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {t(`common:workspace.role.${asRole(invitation.role)}`)}
            {invitation.invited_by ? (
              <> · {t("invitations.invitedBy", { name: invitation.invited_by })}</>
            ) : null}
            {" · "}
            <time
              dateTime={invitation.last_sent_at ?? invitation.created_at}
              title={dateTime(invitation.last_sent_at ?? invitation.created_at)}
            >
              {t("invitations.sent", {
                time: relative(invitation.last_sent_at ?? invitation.created_at),
              })}
            </time>
            {" · "}
            <time
              dateTime={invitation.expires_at}
              title={dateTime(invitation.expires_at)}
              className={expired ? "text-warning-text" : undefined}
            >
              {expired
                ? t("invitations.expired", { time: relative(invitation.expires_at) })
                : t("invitations.expires", { time: relative(invitation.expires_at) })}
            </time>
          </p>
        </div>
      </div>
      {canManage ? (
        <div className="flex shrink-0 items-center gap-2 pl-12 sm:pl-0">
          <Button
            size="sm"
            variant="secondary"
            loading={resending}
            leftIcon={<RotateCw aria-hidden />}
            aria-label={t("invitations.resendLabel", { email: invitation.email })}
            onClick={onResend}
          >
            {t("invitations.resend")}
          </Button>
          <Button
            size="sm"
            variant="danger-ghost"
            leftIcon={<X aria-hidden />}
            aria-label={t("invitations.revokeLabel", { email: invitation.email })}
            onClick={onRevoke}
          >
            {t("invitations.revoke")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  const { t } = useTranslation();
  return (
    <Card className="divide-y divide-line" aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-36 sm:block" />
        </div>
      ))}
    </Card>
  );
}
