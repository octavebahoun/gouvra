import { LogOut, Monitor, Smartphone, Tablet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TFunction } from "i18next";
import { useFormatters } from "@/lib/format";
import { parseUserAgent } from "@/lib/user-agent";
import { SettingsSection } from "@/components/layout/settings-section";
import { duration, ease, listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, Skeleton } from "@/components/ui/feedback";
import { ErrorState } from "@/components/ui/states";
import {
  useDeviceSessions,
  useRevokeDeviceSession,
  useRevokeOtherSessions,
  type DeviceSession,
} from "./api";

const DEVICE_ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

function deviceName(session: DeviceSession, t: TFunction<"account">): string {
  const { browser, os } = parseUserAgent(session.user_agent);
  if (!browser && !os) return t("sessions.unknownDevice");
  return t("sessions.device", {
    browser: browser ?? t("sessions.unknownBrowser"),
    os: os ?? t("sessions.unknownOs"),
  });
}

function methodLabel(method: string, t: TFunction<"account">): string {
  switch (method) {
    case "password":
      return t("sessions.method.password");
    case "email_link":
      return t("sessions.method.email_link");
    case "github":
      return t("sessions.method.github");
    case "google":
      return t("sessions.method.google");
    default:
      return method;
  }
}

/** Devices signed in to this account; any of them can be signed out from here. */
export function SessionsSection() {
  const { t } = useTranslation("account");
  const sessions = useDeviceSessions();
  const revoke = useRevokeDeviceSession();
  const revokeOthers = useRevokeOtherSessions();
  const [revoking, setRevoking] = useState<DeviceSession | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const others = sessions.data?.filter((s) => !s.current).length ?? 0;

  return (
    <SettingsSection
      id="sessions"
      title={t("sessions.title")}
      description={t("sessions.description")}
    >
      <Card className="overflow-hidden">
        {sessions.isPending ? (
          <SessionsSkeleton />
        ) : sessions.isError ? (
          <ErrorState
            compact
            title={t("sessions.loadError")}
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
          />
        ) : (
          <>
            <motion.ul
              variants={staggerChildren(0.04)}
              initial="hidden"
              animate="visible"
              aria-label={t("sessions.title")}
              className="divide-y divide-line"
            >
              <AnimatePresence initial={false}>
                {[...sessions.data]
                  .sort((a, b) => Number(b.current) - Number(a.current))
                  .map((session) => (
                    <motion.li
                      key={session.id}
                      layout="position"
                      variants={listItem}
                      exit={{
                        opacity: 0,
                        x: -8,
                        transition: { duration: duration.fast, ease: ease.exit },
                      }}
                    >
                      <SessionRow session={session} onRevoke={() => setRevoking(session)} />
                    </motion.li>
                  ))}
              </AnimatePresence>
            </motion.ul>
            <div className="flex flex-col gap-3 border-t border-line bg-surface-2/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] text-muted">
                {others === 0 ? t("sessions.onlyThis") : null}
              </p>
              {others > 0 ? (
                <Button
                  variant="danger-ghost"
                  leftIcon={<LogOut aria-hidden />}
                  onClick={() => setConfirmOthers(true)}
                >
                  {t("sessions.revokeOthers")}
                </Button>
              ) : null}
            </div>
          </>
        )}
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={t("sessions.revokeDialogTitle", { device: revoking ? deviceName(revoking, t) : "" })}
        description={t("sessions.revokeDialogBody")}
        confirmLabel={t("sessions.revokeConfirm")}
        pending={revoke.isPending}
        onConfirm={() => {
          if (!revoking) return;
          const target = revoking;
          revoke.mutate(target.id, {
            onSuccess: () => {
              setRevoking(null);
              toast.success(t("sessions.revoked", { device: deviceName(target, t) }));
            },
            onError: () => toast.error(t("sessions.loadError")),
          });
        }}
      />
      <ConfirmDialog
        open={confirmOthers}
        onOpenChange={setConfirmOthers}
        title={t("sessions.revokeOthersDialogTitle")}
        description={t("sessions.revokeOthersDialogBody")}
        confirmLabel={t("sessions.revokeOthersConfirm")}
        pending={revokeOthers.isPending}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: (result) => {
              setConfirmOthers(false);
              toast.success(t("sessions.revokedOthers", { count: result.revoked ?? others }));
            },
            onError: () => toast.error(t("sessions.loadError")),
          })
        }
      />
    </SettingsSection>
  );
}

function SessionRow({ session, onRevoke }: { session: DeviceSession; onRevoke: () => void }) {
  const { t } = useTranslation("account");
  const { relative, dateTime } = useFormatters();
  const { kind } = parseUserAgent(session.user_agent);
  const Icon = DEVICE_ICONS[kind];
  const name = deviceName(session, t);
  const [renderedAt] = useState(() => Date.now());
  // The API refreshes last_seen_at every 5 minutes: within that window the device is "active now".
  const recentlyActive = renderedAt - new Date(session.last_seen_at).getTime() < 5 * 60_000;

  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={
            session.current
              ? "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-text"
              : "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"
          }
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{name}</span>
            {session.current ? <Badge tone="brand">{t("sessions.thisDevice")}</Badge> : null}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {session.current || recentlyActive ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 rounded-full bg-success" />
                {t("sessions.activeNow")}
              </span>
            ) : (
              <time dateTime={session.last_seen_at} title={dateTime(session.last_seen_at)}>
                {t("sessions.lastActive", { time: relative(session.last_seen_at) })}
              </time>
            )}
            {" · "}
            <time dateTime={session.created_at} title={dateTime(session.created_at)}>
              {t("sessions.signedIn", { time: relative(session.created_at) })}
            </time>{" "}
            {t("sessions.via", { method: methodLabel(session.auth_method, t) })}
          </p>
          <p className="mt-0.5 font-mono text-xs text-muted">
            {session.ip_address ?? t("sessions.unknownIp")}
          </p>
        </div>
      </div>
      {session.current ? null : (
        <Button
          size="sm"
          variant="secondary"
          className="self-start sm:self-center"
          aria-label={t("sessions.revokeLabel", { device: name })}
          onClick={onRevoke}
        >
          {t("sessions.revoke")}
        </Button>
      )}
    </div>
  );
}

function SessionsSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="divide-y divide-line" aria-busy="true">
      <span className="sr-only">{t("a11y.loading")}</span>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3 px-5 py-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-44" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
