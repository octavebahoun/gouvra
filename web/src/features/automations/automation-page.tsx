import {
  Bot,
  KeyRound,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { prettyJson } from "@/lib/json";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge, StatusBadge, type ExecutionStatus } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { CopyButton } from "@/components/ui/copy-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Card, CardHeader, Skeleton } from "@/components/ui/feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { ErrorState, NotFoundState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  useAutomation,
  useDeleteAutomation,
  useFires,
  useRotateSecret,
  useRunAutomation,
  useUpdateAutomation,
  type Automation,
  type Fire,
} from "./api";
import { AutomationDialog, SecretDialog } from "./automation-dialog";
import { describeCron } from "./cron";
import { AutomationState, FireBadge, KindIcon } from "./visual";

function reasonOf(fire: Fire): string | null {
  const message = fire.reason?.message;
  return typeof message === "string" && message ? message : null;
}

export function AutomationPage() {
  const { automationId = "" } = useParams();
  const { t } = useTranslation(["automations", "common"]);
  const automation = useAutomation(automationId);
  if (automation.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-80" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-80 rounded-card" />
          <Skeleton className="h-80 rounded-card" />
        </div>
      </PageContainer>
    );
  }
  if (automation.isError) {
    return isApiError(automation.error) && automation.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("detail.notFound")}
        description={t("detail.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={automation.error} onRetry={() => void automation.refetch()} />
        </Card>
      </PageContainer>
    );
  }
  return <AutomationView automation={automation.data} />;
}

function AutomationView({ automation }: { automation: Automation }) {
  const { t, i18n } = useTranslation(["automations", "common"]);
  const navigate = useNavigate();
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const manage = can(detail.data, "automations:manage");
  const update = useUpdateAutomation(workspace.id, automation.id);
  const run = useRunAutomation(workspace.id, automation.id);
  const remove = useDeleteAutomation(workspace.id, automation.id);
  const rotate = useRotateSecret(workspace.id, automation.id);
  const [dialog, setDialog] = useState<null | "edit" | "delete" | "rotate">(null);
  const [rotated, setRotated] = useState<string | null>(null);
  useDocumentTitle(`${automation.name} — ${t("title")}`);
  const TargetIcon = automation.target_type === "agent" ? Bot : Workflow;
  const targetPath =
    automation.target_type === "agent"
      ? `${basePath}/agents/${automation.agent_id ?? ""}`
      : `${basePath}/workflows/${automation.workflow_id ?? ""}`;

  function runNow() {
    const sample = automation.kind === "webhook" ? { event: "test", sent_from: "Gouvra" } : null;
    run.mutate(sample, {
      onSuccess: (fire) =>
        fire.status === "launched"
          ? toast.success(t(automation.kind === "webhook" ? "detail.testSent" : "detail.started"))
          : toast.error(reasonOf(fire) ?? t(`fire.status.${fire.status}`)),
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <PageContainer wide>
      <PageHeader
        breadcrumbs={[
          { label: t("title"), to: `${basePath}/automations` },
          { label: automation.name },
        ]}
        title={automation.name}
        description={automation.description || undefined}
        meta={
          <>
            <Badge tone="outline">{t(`kind.${automation.kind}`)}</Badge>
            <AutomationState automation={automation} />
          </>
        }
        actions={
          manage ? (
            <>
              <Button
                variant="secondary"
                leftIcon={automation.enabled ? <Pause aria-hidden /> : <Play aria-hidden />}
                loading={update.isPending}
                onClick={() =>
                  update.mutate(
                    { enabled: !automation.enabled },
                    {
                      onSuccess: (next) =>
                        toast.success(t(next.enabled ? "detail.resumed" : "detail.paused")),
                    },
                  )
                }
              >
                {automation.enabled ? t("detail.pause") : t("detail.resume")}
              </Button>
              <Button
                leftIcon={
                  automation.kind === "webhook" ? <Send aria-hidden /> : <Play aria-hidden />
                }
                loading={run.isPending}
                onClick={runNow}
              >
                {automation.kind === "webhook" ? t("detail.sendTest") : t("detail.runNow")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    variant="secondary"
                    label={t("detail.more")}
                    icon={<MoreHorizontal aria-hidden />}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onSelect={() => setDialog("edit")}>
                    <Pencil aria-hidden />
                    {t("detail.edit")}
                  </DropdownMenuItem>
                  {automation.kind === "webhook" ? (
                    <DropdownMenuItem onSelect={() => setDialog("rotate")}>
                      <KeyRound aria-hidden />
                      {t("detail.rotate")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem tone="danger" onSelect={() => setDialog("delete")}>
                    <Trash2 aria-hidden />
                    {t("detail.delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null
        }
      />
      {automation.paused_reason ? (
        <Alert tone="warning" title={t("detail.pausedTitle")} className="mb-5">
          {automation.paused_reason}
        </Alert>
      ) : automation.target_problem ? (
        <Alert tone="danger" title={t("detail.problemTitle")} className="mb-5">
          {automation.target_problem}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title={t("detail.target")} />
            <div className="flex items-center gap-3 px-5 pb-5">
              <KindIcon kind={automation.kind} />
              <span aria-hidden className="text-muted">
                →
              </span>
              <TargetIcon aria-hidden className="size-4 text-muted" />
              {automation.target_name ? (
                <Link to={targetPath} className="font-medium text-brand-text hover:underline">
                  {automation.target_name}
                </Link>
              ) : (
                <span className="text-muted">{t("target.missing")}</span>
              )}
            </div>
          </Card>
          {automation.kind === "schedule" ? (
            <ScheduleCard automation={automation} language={i18n.language} />
          ) : (
            <WebhookCard automation={automation} />
          )}
        </div>
        <Deliveries automation={automation} basePath={basePath} />
      </div>

      {dialog === "edit" ? (
        <AutomationDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          kind={automation.kind}
          workspaceId={workspace.id}
          basePath={basePath}
          automation={automation}
        />
      ) : null}
      <ConfirmDialog
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        title={t("detail.deleteTitle", { name: automation.name })}
        description={t("detail.deleteBody")}
        confirmLabel={t("detail.delete")}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              toast.success(t("detail.deleted"));
              void navigate(`${basePath}/automations`);
            },
          })
        }
      />
      <ConfirmDialog
        open={dialog === "rotate"}
        onOpenChange={(open) => setDialog(open ? "rotate" : null)}
        title={t("detail.rotateTitle")}
        description={t("detail.rotateBody")}
        confirmLabel={t("detail.rotate")}
        pending={rotate.isPending}
        onConfirm={() =>
          rotate.mutate(undefined, {
            onSuccess: (result) => {
              setDialog(null);
              setRotated(result.secret);
            },
          })
        }
      />
      {rotated ? (
        <SecretDialog
          open
          onOpenChange={(open) => !open && setRotated(null)}
          secret={rotated}
          url={automation.hook_url ?? ""}
        />
      ) : null}
    </PageContainer>
  );
}

function ScheduleCard({ automation, language }: { automation: Automation; language: string }) {
  const { t } = useTranslation("automations");
  const { dateTime, relative } = useFormatters();
  const words = automation.cron ? describeCron(automation.cron, language) : null;
  return (
    <Card>
      <CardHeader title={t("detail.when")} />
      <div className="space-y-4 px-5 pb-5">
        <div>
          <p className="text-[17px] font-semibold text-ink">{words ?? automation.cron}</p>
          <p className="mt-0.5 text-[13px] text-muted">
            <code className="text-[12.5px]">{automation.cron}</code> · {automation.timezone}
          </p>
        </div>
        {automation.upcoming.length ? (
          <div>
            <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
              {t("detail.upcoming")}
            </h3>
            <ol className="space-y-1.5 text-[13px]">
              {automation.upcoming.map((when) => (
                <li key={when} className="flex justify-between gap-3">
                  <span className="text-ink">{dateTime(when)}</span>
                  <span className="text-muted">{relative(when)}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-[13px] text-muted">{t("detail.noUpcoming")}</p>
        )}
        <div>
          <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
            {t("detail.input")}
          </h3>
          {automation.input && "json" in automation.input ? (
            <CodeEditor
              value={prettyJson(automation.input.json)}
              readOnly
              aria-label={t("detail.input")}
              maxHeight="200px"
            />
          ) : (
            <pre className="rounded-field bg-surface-2 p-3 text-[13px] whitespace-pre-wrap text-ink">
              {typeof automation.input?.text === "string" ? automation.input.text : "—"}
            </pre>
          )}
        </div>
        <p className="text-[13px] text-muted">
          {t(automation.overlap === "skip" ? "detail.overlapSkip" : "detail.overlapAllow")}
        </p>
      </div>
    </Card>
  );
}

const SAMPLES = ["curl", "python", "node"] as const;

function WebhookCard({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  const [sample, setSample] = useState<(typeof SAMPLES)[number]>("curl");
  const url = automation.hook_url ?? "";
  const code = {
    curl: `SECRET='YOUR_SIGNING_SECRET'
BODY='{"event":"ticket.created","ticket":{"id":42}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -sS '${url}' -H 'Content-Type: application/json' \\
  -H "Gouvra-Signature: t=$TS,v1=$SIG" -d "$BODY"`,
    python: `import hashlib, hmac, json, time, urllib.request

secret = "YOUR_SIGNING_SECRET"
body = json.dumps({"event": "ticket.created", "ticket": {"id": 42}}).encode()
ts = int(time.time())
sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
req = urllib.request.Request("${url}", data=body, headers={
    "Content-Type": "application/json",
    "Gouvra-Signature": f"t={ts},v1={sig}",
})
print(urllib.request.urlopen(req).read().decode())`,
    node: `import { createHmac } from "node:crypto";

const secret = "YOUR_SIGNING_SECRET";
const body = JSON.stringify({ event: "ticket.created", ticket: { id: 42 } });
const ts = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", secret).update(\`\${ts}.\${body}\`).digest("hex");
const res = await fetch("${url}", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Gouvra-Signature": \`t=\${ts},v1=\${sig}\` },
  body,
});
console.log(res.status, await res.json());`,
  }[sample];
  return (
    <Card>
      <CardHeader title={t("detail.address")} description={t("detail.addressHelp")} />
      <div className="space-y-4 px-5 pb-5">
        <div className="flex items-center gap-2 rounded-field border border-line bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{url}</code>
          <CopyButton value={url} label={t("secret.copyUrl")} />
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-muted">{t("detail.signature")}</dt>
          <dd className="text-ink">{t(`signature.${automation.signature_format}`)}</dd>
          <dt className="text-muted">{t("detail.secret")}</dt>
          <dd className="font-mono text-ink">••••{automation.secret_hint ?? ""}</dd>
          <dt className="text-muted">{t("detail.inputFrom")}</dt>
          <dd className="text-ink">
            {automation.input_template ? (
              <code className="text-[12.5px] break-words">{automation.input_template}</code>
            ) : (
              t("detail.wholePayload")
            )}
          </dd>
        </dl>
        {automation.signature_format === "gouvra" ? (
          <div>
            <div role="tablist" aria-label={t("detail.samples")} className="mb-2 flex gap-1">
              {SAMPLES.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={sample === key}
                  onClick={() => setSample(key)}
                  className={
                    sample === key
                      ? "rounded-full bg-surface-2 px-3 py-1 text-[12px] font-medium text-ink"
                      : "rounded-full px-3 py-1 text-[12px] font-medium text-muted hover:text-ink"
                  }
                >
                  {t(`detail.sample.${key}`)}
                </button>
              ))}
            </div>
            <div className="relative">
              <pre className="rounded-field bg-terminal p-3 pr-10 text-[12px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-terminal-ink">
                {code}
              </pre>
              <div className="absolute top-2 right-2">
                <CopyButton value={code} label={t("detail.copySample")} />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">{t("detail.githubHelp")}</p>
        )}
      </div>
    </Card>
  );
}

function Deliveries({ automation, basePath }: { automation: Automation; basePath: string }) {
  const { t } = useTranslation("automations");
  const fires = useFires(automation.id);
  return (
    <Card>
      <CardHeader
        title={t(automation.kind === "schedule" ? "detail.history" : "detail.deliveries")}
        description={t("detail.historyHelp")}
      />
      {fires.isPending ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : fires.isError ? (
        <ErrorState compact error={fires.error} onRetry={() => void fires.refetch()} />
      ) : fires.data.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted">
          {t(automation.kind === "schedule" ? "detail.noHistory" : "detail.noDeliveries")}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {fires.data.map((fire) => (
            <FireRow key={fire.id} fire={fire} basePath={basePath} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function FireRow({ fire, basePath }: { fire: Fire; basePath: string }) {
  const { t } = useTranslation("automations");
  const { relative, dateTime } = useFormatters();
  const runPath = fire.execution_id
    ? `${basePath}/executions/${fire.execution_id}`
    : fire.workflow_run_id
      ? `${basePath}/workflows/runs/${fire.workflow_run_id}`
      : null;
  const meta = fire.request_meta as {
    size?: number;
    ip?: string | null;
    late_by_s?: number;
  } | null;
  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <FireBadge status={fire.status} />
        <Badge tone="outline">{t(`fire.source.${fire.source}`)}</Badge>
        <time
          dateTime={fire.created_at}
          title={dateTime(fire.created_at)}
          className="text-[12px] text-muted"
        >
          {relative(fire.created_at)}
        </time>
        {runPath ? (
          <Link
            to={runPath}
            className="ml-auto inline-flex items-center gap-2 text-[13px] font-medium text-brand-text hover:underline"
          >
            {fire.run_status ? <StatusBadge status={fire.run_status as ExecutionStatus} /> : null}
            {t("fire.openRun")}
          </Link>
        ) : null}
      </div>
      {reasonOf(fire) ? <p className="mt-1.5 text-[13px] text-muted">{reasonOf(fire)}</p> : null}
      <p className="mt-1 text-[12px] text-muted">
        {[
          fire.delivery_id ? `${t("fire.delivery")} ${fire.delivery_id.slice(0, 24)}` : null,
          meta?.size !== undefined ? t("fire.size", { size: meta.size }) : null,
          meta?.ip ?? null,
          meta?.late_by_s ? t("fire.late", { seconds: meta.late_by_s }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  );
}
