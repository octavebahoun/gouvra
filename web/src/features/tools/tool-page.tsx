import { Archive, CircleCheck, CircleX, ExternalLink, Pencil, Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { isApiError } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { useFormatters } from "@/lib/format";
import { useModEnter } from "@/lib/use-shortcut";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { duration as motionDuration, ease, fadeUp } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { parseJson, prettyJson } from "@/lib/json";
import { Switch } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, CardHeader, Kbd, Skeleton } from "@/components/ui/feedback";
import { Field } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { EmptyState, ErrorState, NotFoundState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { formatDuration } from "@/features/executions/format";
import {
  exampleFor,
  useArchiveTool,
  useTestTool,
  useTool,
  useToolCalls,
  useUpdateTool,
  type Tool,
  type ToolKind,
  type ToolTestResult,
} from "./api";
import { ToolFormDialog } from "./tool-form";
import { NetworkBadge, ToolMark } from "./tool-visual";

/** Screen N (detail) — schema, configuration, controlled test and usage history of a tool. */
export function ToolPage() {
  const { toolId = "" } = useParams();
  const { t } = useTranslation(["tools", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const tool = useTool(toolId);
  const [tab, setTab] = useState("overview");
  useDocumentTitle(tool.data ? `${tool.data.display_name} — ${workspace.name}` : null);

  if (tool.isPending) {
    return (
      <PageContainer>
        <Skeleton className="mb-6 h-12 w-80" />
        <Skeleton className="h-96 rounded-card" />
      </PageContainer>
    );
  }
  if (tool.isError) {
    if (isApiError(tool.error) && tool.error.isNotFound) {
      return (
        <NotFoundState
          headingLevel="h1"
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundBody")}
          className="min-h-[60vh]"
        />
      );
    }
    return (
      <PageContainer>
        <Card>
          <ErrorState error={tool.error} onRetry={() => void tool.refetch()} />
        </Card>
      </PageContainer>
    );
  }

  const write = can(detail.data, "tools:write");
  return (
    <PageContainer>
      <ToolHeader tool={tool.data} basePath={basePath} workspaceId={workspace.id} write={write} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          value={tab}
          aria-label={tool.data.display_name}
          items={[
            { value: "overview", label: t("detail.overview") },
            { value: "test", label: t("detail.test") },
            { value: "history", label: t("detail.history") },
          ]}
          className="mb-6"
        />
        <TabsContent value="overview">
          <ToolOverview tool={tool.data} />
        </TabsContent>
        <TabsContent value="test">
          <TestConsole tool={tool.data} />
        </TabsContent>
        <TabsContent value="history">
          <CallHistory tool={tool.data} basePath={basePath} />
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}

function ToolHeader({
  tool,
  basePath,
  workspaceId,
  write,
}: {
  tool: Tool;
  basePath: string;
  workspaceId: string;
  write: boolean;
}) {
  const { t } = useTranslation(["tools", "common"]);
  const navigate = useNavigate();
  const update = useUpdateTool(workspaceId);
  const archive = useArchiveTool(workspaceId);
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState(0);
  const [archiving, setArchiving] = useState(false);
  const active = tool.status === "active";

  return (
    <>
      <PageHeader
        breadcrumbs={[
          { label: t("detail.breadcrumb"), to: `${basePath}/tools` },
          { label: tool.display_name },
        ]}
        title={
          <span className="inline-flex items-center gap-3">
            <ToolMark kind={tool.kind} className="size-9" />
            {tool.display_name}
          </span>
        }
        meta={
          <>
            <Badge tone="outline">{t(`kinds.${tool.kind as ToolKind | "connector"}`)}</Badge>
            <Badge tone={active ? "success" : "neutral"}>
              {t(`status.${active ? "active" : "disabled"}`)}
            </Badge>
            <NetworkBadge usesNetwork={tool.uses_network} />
          </>
        }
        description={tool.description}
        actions={
          write ? (
            <>
              <label className="mr-2 inline-flex items-center gap-2 text-[13px] text-ink">
                <Switch
                  checked={active}
                  disabled={update.isPending}
                  onCheckedChange={(checked) =>
                    update.mutate(
                      { id: tool.id, body: { status: checked ? "active" : "disabled" } },
                      {
                        onSuccess: (saved) =>
                          toast.success(
                            t(checked ? "detail.enabledToast" : "detail.disabledToast", {
                              name: saved.display_name,
                            }),
                          ),
                        onError: (error) => toast.error(error.message),
                      },
                    )
                  }
                />
                {active ? t("detail.disable") : t("detail.enable")}
              </label>
              {tool.kind === "connector" ? (
                <Button asChild variant="secondary" leftIcon={<Pencil aria-hidden />}>
                  <Link to={`${basePath}/connectors`}>{t("detail.manageConnection")}</Link>
                </Button>
              ) : tool.kind !== "builtin" || tool.builtin_key === "http_request" ? (
                <Button
                  variant="secondary"
                  leftIcon={<Pencil aria-hidden />}
                  onClick={() => {
                    setSession((value) => value + 1);
                    setEditing(true);
                  }}
                >
                  {t("common:actions.edit")}
                </Button>
              ) : null}
              <Button
                variant="danger-ghost"
                leftIcon={<Archive aria-hidden />}
                onClick={() => setArchiving(true)}
              >
                {t("detail.archive")}
              </Button>
            </>
          ) : null
        }
      />
      <ToolFormDialog
        key={session}
        open={editing}
        onOpenChange={setEditing}
        workspaceId={workspaceId}
        kind={tool.kind as ToolKind}
        tool={tool}
        builtin={
          tool.builtin_key === "http_request"
            ? {
                key: "http_request",
                name: tool.name,
                display_name: tool.display_name,
                description: tool.description,
                input_schema: tool.input_schema,
                config_schema: { properties: { allowed_hosts: {} } },
                uses_network: true,
              }
            : null
        }
      />
      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={t("detail.archiveTitle", { name: tool.display_name })}
        description={t("detail.archiveBody")}
        confirmLabel={t("detail.archive")}
        pending={archive.isPending}
        onConfirm={() =>
          archive.mutate(tool.id, {
            onSuccess: () => {
              toast.success(t("detail.archived", { name: tool.display_name }));
              void navigate(`${basePath}/tools`);
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />
    </>
  );
}

/** A configuration value shown as text (unknown shapes fall back instead of "[object Object]"). */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function ConfigRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 border-b border-line px-5 py-3 text-[13px] last:border-b-0">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function ToolOverview({ tool }: { tool: Tool }) {
  const { t } = useTranslation(["tools", "common"]);
  const config = tool.config as Record<string, unknown>;
  const rows: [string, ReactNode][] = [];
  if (tool.kind === "http") {
    const auth = (config.auth ?? {}) as { type?: string; header_name?: string };
    rows.push([
      t("form.method"),
      <code key="m" className="font-mono">
        {text(config.method, "GET")}
      </code>,
    ]);
    rows.push([
      t("form.url"),
      <code key="u" className="font-mono break-all">
        {text(config.url, "")}
      </code>,
    ]);
    rows.push([
      t("form.auth"),
      auth.type === "bearer"
        ? t("form.authBearer")
        : auth.type === "header"
          ? `${t("form.authHeader")} · ${auth.header_name ?? ""}`
          : t("form.authNone"),
    ]);
  }
  if (tool.kind === "code") {
    rows.push([t("form.language"), text(config.language, "python")]);
    rows.push([t("form.network"), config.network ? t("network") : t("offline")]);
    rows.push([
      t("form.memory"),
      `${typeof config.memory_mb === "number" ? config.memory_mb : 256} MB`,
    ]);
  }
  if (Array.isArray(config.allowed_hosts)) {
    rows.push([
      t("form.allowedHosts"),
      <code key="h" className="font-mono">
        {(config.allowed_hosts as string[]).join(", ")}
      </code>,
    ]);
  }
  if (Array.isArray(config.allowed_methods)) {
    rows.push([
      t("form.allowedMethods"),
      <code key="am" className="font-mono">
        {(config.allowed_methods as string[]).join(", ")}
      </code>,
    ]);
  }
  if (tool.kind === "http") {
    rows.push([
      t("detail.credential"),
      tool.secret_set
        ? t("detail.credentialSet", { hint: tool.secret_hint ?? "••••" })
        : t("detail.credentialNone"),
    ]);
  }
  if (tool.kind === "connector") {
    rows.push([t("detail.connection"), t("detail.connectionManaged")]);
  }
  rows.push([t("form.timeoutMs"), `${tool.timeout_ms.toLocaleString()} ms`]);
  rows.push([t("usedBy", { count: tool.agent_count }), ""]);

  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="visible"
      className="grid gap-6 lg:grid-cols-[1.1fr_1fr]"
    >
      <Card className="overflow-hidden">
        <CardHeader title={t("detail.schema")} description={t("form.inputSchemaHelp")} />
        <div className="p-4">
          <CodeEditor
            value={prettyJson(tool.input_schema)}
            readOnly
            aria-label={t("detail.schema")}
            maxHeight="520px"
          />
        </div>
      </Card>
      <Card className="h-fit overflow-hidden">
        <CardHeader title={t("detail.config")} />
        {rows.length ? (
          <dl>
            {rows.map(([label, value]) => (
              <ConfigRow key={label} label={label}>
                {value}
              </ConfigRow>
            ))}
          </dl>
        ) : (
          <p className="px-5 py-4 text-[13px] text-muted">{t("detail.noConfig")}</p>
        )}
      </Card>
    </motion.div>
  );
}

function TestConsole({ tool }: { tool: Tool }) {
  const { t } = useTranslation(["tools", "executions", "common"]);
  const test = useTestTool(tool.id);
  const [text, setText] = useState(() => prettyJson(exampleFor(tool.input_schema as never) ?? {}));
  const [invalid, setInvalid] = useState<string | null>(null);
  const [result, setResult] = useState<ToolTestResult | null>(null);

  const run = () => {
    const parsed = parseJson(text);
    if (
      !parsed.ok ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      Array.isArray(parsed.value)
    ) {
      setInvalid(t("console.argumentsInvalid"));
      return;
    }
    setInvalid(null);
    test.mutate(parsed.value as Record<string, unknown>, {
      onSuccess: setResult,
      onError: (error) => toast.error(error.message),
    });
  };

  useModEnter(true, run);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="overflow-hidden">
        <CardHeader title={t("console.title")} description={t("console.description")} />
        <div className="flex flex-col gap-4 p-5">
          <Field
            label={t("console.arguments")}
            description={t("console.fromSchema")}
            error={invalid}
          >
            <CodeEditor value={text} onChange={setText} minHeight="180px" />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd>
            </span>
            <Button leftIcon={<Play aria-hidden />} loading={test.isPending} onClick={run}>
              {test.isPending ? t("console.running") : t("console.run")}
            </Button>
          </div>
        </div>
      </Card>
      <Card className="overflow-hidden" aria-live="polite">
        <CardHeader title={t("console.result")} />
        <div className="p-5">
          <AnimatePresence mode="wait" initial={false}>
            {result ? (
              <motion.div
                key={`${result.duration_ms}-${String(result.ok)}-${JSON.stringify(result.output ?? null).length}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{
                  opacity: 1,
                  y: 0,
                  transition: { duration: motionDuration.base, ease: ease.standard },
                }}
                exit={{ opacity: 0 }}
                className="flex flex-col gap-3"
              >
                <p className="flex items-center gap-2 text-sm font-medium">
                  {result.ok ? (
                    <CircleCheck aria-hidden className="size-4 text-success" />
                  ) : (
                    <CircleX aria-hidden className="size-4 text-danger" />
                  )}
                  <span className={result.ok ? "text-success-text" : "text-danger-text"}>
                    {t(result.ok ? "console.ok" : "console.failed", {
                      duration: formatDuration(result.duration_ms),
                    })}
                  </span>
                </p>
                {result.ok ? (
                  <CodeEditor
                    value={
                      typeof result.output === "string" ? result.output : prettyJson(result.output)
                    }
                    language={typeof result.output === "string" ? "text" : "json"}
                    readOnly
                    aria-label={t("console.result")}
                  />
                ) : (
                  <div className="rounded-field bg-danger-soft px-3 py-2.5 text-[13px] text-danger-text">
                    <p className="font-mono text-xs">{result.error_code}</p>
                    <p className="mt-1">{result.error_message}</p>
                  </div>
                )}
                {result.truncated ? (
                  <p className="text-xs text-muted">{t("console.truncated")}</p>
                ) : null}
              </motion.div>
            ) : (
              <motion.p key="empty" className="py-10 text-center text-[13px] text-muted">
                {t("console.empty")}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </Card>
    </div>
  );
}

function CallHistory({ tool, basePath }: { tool: Tool; basePath: string }) {
  const { t } = useTranslation(["tools", "common"]);
  const calls = useToolCalls(tool.id);
  const { relative, dateTime } = useFormatters();
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t("history.title")} description={t("history.description")} />
      {calls.isPending ? (
        <div className="space-y-2 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : calls.isError ? (
        <ErrorState compact error={calls.error} onRetry={() => void calls.refetch()} />
      ) : calls.data.length === 0 ? (
        <EmptyState compact title={t("history.empty")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line bg-surface-2/50 text-left text-xs text-muted">
              <tr>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t("history.agent")}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t("history.when")}
                </th>
                <th scope="col" className="px-5 py-2.5 font-medium">
                  {t("history.result")}
                </th>
                <th scope="col" className="px-5 py-2.5 text-right font-medium">
                  {t("history.duration")}
                </th>
                <th scope="col" className="px-5 py-2.5">
                  <span className="sr-only">{t("history.openExecution")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {calls.data.map((call, index) => (
                <tr
                  key={`${call.execution_id}-${String(index)}`}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-5 py-3 text-ink">{call.agent_name ?? "—"}</td>
                  <td className="px-5 py-3 text-muted" title={dateTime(call.called_at)}>
                    {relative(call.called_at)}
                  </td>
                  <td className="px-5 py-3">
                    {call.ok === null ? (
                      <Badge tone="neutral">{t("history.unknown")}</Badge>
                    ) : call.ok ? (
                      <Badge tone="success">{t("history.ok")}</Badge>
                    ) : (
                      <Badge tone="danger">{call.error_code ?? t("history.failed")}</Badge>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right text-muted tabular-nums">
                    {call.duration_ms !== null ? formatDuration(call.duration_ms) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      to={`${basePath}/executions/${call.execution_id}`}
                      className="inline-flex items-center gap-1 text-brand-text hover:underline"
                    >
                      {t("history.openExecution")}
                      <ExternalLink aria-hidden className="size-3.5" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
