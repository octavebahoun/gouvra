import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import {
  Archive,
  ArchiveRestore,
  Check,
  CircleAlert,
  CircleX,
  CloudOff,
  LayoutGrid,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { UnsavedChangesGuard } from "@/components/layout/unsaved-changes";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "@/components/ui/menu";
import { ErrorState, NotFoundState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { isApiError } from "@/lib/api/errors";
import { useAgentOptions } from "@/features/agents/api";
import { useTools } from "@/features/tools/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  useArchiveWorkflow,
  useDeleteWorkflow,
  useRestoreVersion,
  useVersions,
  useWorkflow,
  useWorkflowRuns,
  type Workflow,
} from "./api";
import { WorkflowCanvas, type Names, type Selection } from "./canvas";
import { PublishDialog, RenameWorkflowDialog, RunWorkflowDialog } from "./dialogs";
import { ADDABLE_TYPES, buildStep, tidy, type AddableType } from "./graph";
import { Inspector } from "./inspector";
import { useDraft, type SaveStatus } from "./use-draft";
import { TypeIcon } from "./visual";
import { RecentRuns } from "./workflows-page";

/** Screen T — the workflow editor, its runs and its published versions. */
export function WorkflowPage() {
  const { workflowId = "" } = useParams();
  const { t } = useTranslation(["workflows", "common"]);
  const query = useWorkflow(workflowId);
  if (query.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-14 w-80" />
        <Skeleton className="h-[540px] rounded-card" />
      </PageContainer>
    );
  }
  if (query.isError) {
    return isApiError(query.error) && query.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("editor.notFound")}
        description={t("editor.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      </PageContainer>
    );
  }
  return (
    <ReactFlowProvider>
      <WorkflowEditor key={query.data.id} workflow={query.data} reload={query.refetch} />
    </ReactFlowProvider>
  );
}

function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const { t } = useTranslation(["workflows", "common"]);
  const content = {
    saved: { Icon: Check, label: t("editor.saved"), className: "text-muted" },
    dirty: { Icon: Pencil, label: t("editor.unsaved"), className: "text-muted" },
    saving: { Icon: LoaderCircle, label: t("editor.saving"), className: "text-muted" },
    error: { Icon: CloudOff, label: t("editor.saveError"), className: "text-danger-text" },
    conflict: {
      Icon: CircleAlert,
      label: t("editor.conflictShort"),
      className: "text-danger-text",
    },
  }[status];
  return (
    <span
      role="status"
      className={cn("inline-flex items-center gap-1.5 text-[12px]", content.className)}
    >
      <content.Icon aria-hidden className={cn("size-3.5", status === "saving" && "animate-spin")} />
      {content.label}
      {status === "error" ? (
        <Button size="sm" variant="link" onClick={onRetry} className="ml-1 text-[12px]">
          {t("common:actions.retry")}
        </Button>
      ) : null}
    </span>
  );
}

function WorkflowEditor({
  workflow,
  reload,
}: {
  workflow: Workflow;
  reload: () => Promise<{ data?: Workflow }>;
}) {
  const { t } = useTranslation(["workflows", "common"]);
  const navigate = useNavigate();
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const permissions = detail.data;
  const write = can(permissions, "workflows:write") && !workflow.archived;
  const launch = can(permissions, "executions:launch") && !workflow.archived;
  const draft = useDraft(workflow);
  const flow = useReactFlow();
  const agents = useAgentOptions(workspace.id);
  const tools = useTools(workspace.id);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tab, setTab] = useState("editor");
  const [dialog, setDialog] = useState<
    null | "test" | "run" | "publish" | "rename" | "delete" | "restore"
  >(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  useDocumentTitle(`${workflow.name} — ${t("title")}`);

  const names = useMemo<Names>(
    () => ({
      agents: new Map((agents.data ?? []).map((a) => [a.id, a.name])),
      tools: new Map((tools.data ?? []).map((tool) => [tool.id, tool.display_name])),
    }),
    [agents.data, tools.data],
  );
  const readyAgent = (agents.data ?? []).find((a) => a.status === "active");
  const activeTool = (tools.data ?? []).find((tool) => tool.status === "active");
  const errors = workflow.issues.filter((i) => i.severity === "error").length;
  const warnings = workflow.issues.length - errors;

  // Keyboard: undo, redo, save now — but never inside a text field (its own undo wins).
  useEffect(() => {
    if (!write) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.closest("input, textarea, [contenteditable=true], .cm-editor") !== null &&
        target !== null;
      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void draft.flush();
      } else if (!typing && key === "z") {
        event.preventDefault();
        if (event.shiftKey) draft.redo();
        else draft.undo();
      } else if (!typing && key === "y") {
        event.preventDefault();
        draft.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [write, draft]);

  function addStep(type: AddableType) {
    const built = buildStep(
      draft.graph,
      type,
      { label: t(`types.${type}`), agentId: readyAgent?.id, toolId: activeTool?.id },
      selection?.kind === "node" ? selection.id : null,
    );
    if (!built) return;
    draft.update(built.graph);
    setSelection({ kind: "node", id: built.id });
    const node = built.graph.nodes?.find((n) => n.id === built.id);
    if (node?.position) {
      void flow.setCenter((node.position.x ?? 0) + 116, (node.position.y ?? 0) + 40, {
        zoom: Math.max(flow.getZoom(), 0.8),
        duration: 400,
      });
    }
  }

  async function reloadDraft() {
    const fresh = await reload();
    if (fresh.data) {
      draft.reset(fresh.data);
      setSelection(null);
      toast.success(t("editor.reloaded"));
    }
  }

  const header = (
    <PageHeader
      breadcrumbs={[{ label: t("title"), to: `${basePath}/workflows` }, { label: workflow.name }]}
      title={workflow.name}
      description={workflow.description || undefined}
      meta={
        <>
          {workflow.current_version ? (
            <Badge tone="brand">{t("list.published", { version: workflow.current_version })}</Badge>
          ) : (
            <Badge tone="outline">{t("list.draftOnly")}</Badge>
          )}
          {workflow.current_version && workflow.has_unpublished_changes ? (
            <Badge tone="warning">{t("list.unpublished")}</Badge>
          ) : null}
          {workflow.archived ? <Badge tone="outline">{t("list.archived")}</Badge> : null}
        </>
      }
      actions={
        <>
          {write ? (
            <SaveIndicator status={draft.status} onRetry={() => void draft.flush()} />
          ) : null}
          {launch && write ? (
            <Button
              variant="secondary"
              leftIcon={<Play aria-hidden />}
              onClick={() => setDialog("test")}
              disabled={errors > 0}
            >
              {t("editor.testRun")}
            </Button>
          ) : null}
          {write ? (
            <Tooltip
              content={
                errors
                  ? t("editor.fixFirst", { count: errors })
                  : !workflow.can_publish
                    ? t("editor.nothingToPublish")
                    : t("editor.publishHint")
              }
            >
              <span tabIndex={workflow.can_publish ? -1 : 0} className="inline-flex rounded-field">
                <Button
                  variant={workflow.current_version ? "secondary" : "primary"}
                  leftIcon={<Upload aria-hidden />}
                  disabled={!workflow.can_publish || draft.status === "conflict"}
                  onClick={() => setDialog("publish")}
                >
                  {t("editor.publish")}
                </Button>
              </span>
            </Tooltip>
          ) : null}
          {launch && workflow.current_version ? (
            <Button leftIcon={<Play aria-hidden />} onClick={() => setDialog("run")}>
              {t("editor.run")}
            </Button>
          ) : null}
          {can(permissions, "workflows:write") ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  variant="secondary"
                  label={t("menu.more")}
                  icon={<MoreHorizontal aria-hidden />}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {write ? (
                  <DropdownMenuItem onSelect={() => setDialog("rename")}>
                    <Pencil aria-hidden />
                    {t("menu.rename")}
                  </DropdownMenuItem>
                ) : null}
                <ArchiveItem workflow={workflow} workspaceId={workspace.id} />
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setDialog("delete")}>
                  <Trash2 aria-hidden />
                  {t("menu.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
    />
  );

  return (
    <PageContainer wide>
      {header}
      <UnsavedChangesGuard when={draft.status === "saving"} />
      {workflow.archived ? (
        <Alert tone="info" title={t("editor.archivedBanner")} className="mb-4" />
      ) : !can(permissions, "workflows:write") && permissions ? (
        <Alert tone="info" title={t("editor.readOnlyBanner")} className="mb-4" />
      ) : null}
      {draft.status === "conflict" ? (
        <Alert
          tone="danger"
          title={t("editor.conflictTitle")}
          className="mb-4"
          action={
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<RefreshCw aria-hidden />}
              onClick={() => void reloadDraft()}
            >
              {t("editor.reload")}
            </Button>
          }
        >
          {t("editor.conflictBody")}
        </Alert>
      ) : null}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          value={tab}
          aria-label={t("editor.sections")}
          items={[
            { value: "editor", label: t("editor.tab") },
            { value: "runs", label: t("editor.runsTab") },
            {
              value: "versions",
              label: t("editor.versionsTab"),
              count: workflow.current_version ?? 0,
            },
          ]}
          className="mb-4"
        />
        <TabsContent value="editor" className="focus-visible:outline-none">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
              {write ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" leftIcon={<Plus aria-hidden />}>
                        {t("editor.add")}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-72">
                      {ADDABLE_TYPES.map((type) => {
                        const missing =
                          (type === "agent" && !readyAgent) || (type === "tool" && !activeTool);
                        return (
                          <DropdownMenuItem
                            key={type}
                            disabled={missing}
                            onSelect={() => addStep(type)}
                            className="items-start py-2"
                          >
                            <TypeIcon type={type} />
                            <span className="min-w-0">
                              <span className="block text-[13px] font-medium text-ink">
                                {t(`types.${type}`)}
                              </span>
                              <span className="block text-[12px] leading-snug whitespace-normal text-muted">
                                {missing
                                  ? t(type === "agent" ? "editor.noAgents" : "editor.noTools")
                                  : t(`typeHelp.${type}`)}
                              </span>
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span aria-hidden className="mx-1 h-5 w-px bg-line" />
                  <IconButton
                    size="icon-sm"
                    label={t("editor.undo")}
                    icon={<Undo2 aria-hidden />}
                    disabled={!draft.canUndo}
                    onClick={draft.undo}
                  />
                  <IconButton
                    size="icon-sm"
                    label={t("editor.redo")}
                    icon={<Redo2 aria-hidden />}
                    disabled={!draft.canRedo}
                    onClick={draft.redo}
                  />
                  <Button
                    size="sm"
                    variant="tertiary"
                    leftIcon={<LayoutGrid aria-hidden />}
                    onClick={() => {
                      draft.update(tidy(draft.graph));
                      window.setTimeout(
                        () => void flow.fitView({ padding: 0.2, duration: 400, maxZoom: 1 }),
                        50,
                      );
                    }}
                  >
                    {t("editor.tidy")}
                  </Button>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setSelection(null)}
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                  errors
                    ? "bg-danger-soft text-danger-text"
                    : warnings
                      ? "bg-warning-soft text-warning-text"
                      : "bg-success-soft text-success-text",
                )}
              >
                {errors ? (
                  <CircleX aria-hidden className="size-3.5" />
                ) : warnings ? (
                  <TriangleAlert aria-hidden className="size-3.5" />
                ) : (
                  <Check aria-hidden className="size-3.5" />
                )}
                {errors
                  ? t("editor.problems", { count: errors })
                  : warnings
                    ? t("editor.warnings", { count: warnings })
                    : t("editor.noProblems")}
              </button>
            </div>
            <div className="grid lg:grid-cols-[minmax(0,1fr)_340px]">
              <WorkflowCanvas
                graph={draft.graph}
                names={names}
                label={t("editor.canvasLabel")}
                selection={selection}
                onSelect={setSelection}
                onChange={write ? (graph, commit) => draft.update(graph, commit) : undefined}
                issues={workflow.issues}
                className="h-[min(68vh,720px)] min-h-[420px] bg-canvas"
              />
              <aside
                aria-label={t("inspector.title")}
                className="max-h-[min(68vh,720px)] overflow-y-auto border-line bg-surface max-lg:border-t lg:border-l"
              >
                <Inspector
                  graph={draft.graph}
                  selection={selection}
                  issues={workflow.issues}
                  editable={write && draft.status !== "conflict"}
                  agents={agents.data ?? []}
                  tools={tools.data ?? []}
                  onChange={(graph, coalesce) => draft.update(graph, true, coalesce)}
                  onSelect={setSelection}
                />
              </aside>
            </div>
          </Card>
        </TabsContent>
        <TabsContent value="runs" className="focus-visible:outline-none">
          <WorkflowRuns workspaceId={workspace.id} workflowId={workflow.id} basePath={basePath} />
        </TabsContent>
        <TabsContent value="versions" className="focus-visible:outline-none">
          <Versions
            workflow={workflow}
            canRestore={write}
            onRestore={(number) => {
              setRestoring(number);
              setDialog("restore");
            }}
          />
        </TabsContent>
      </Tabs>

      {dialog === "test" || dialog === "run" ? (
        <RunWorkflowDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          workspaceId={workspace.id}
          workflowId={workflow.id}
          workflowName={workflow.name}
          graph={draft.graph}
          draft={dialog === "test"}
          version={workflow.current_version}
          basePath={basePath}
          beforeStart={dialog === "test" ? draft.flush : undefined}
        />
      ) : null}
      {dialog === "publish" ? (
        <PublishDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          workspaceId={workspace.id}
          workflowId={workflow.id}
          nextVersion={(workflow.current_version ?? 0) + 1}
          beforePublish={draft.flush}
          onPublished={() => undefined}
        />
      ) : null}
      {dialog === "rename" ? (
        <RenameWorkflowDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          workspaceId={workspace.id}
          workflowId={workflow.id}
          name={workflow.name}
          description={workflow.description}
        />
      ) : null}
      <DeleteWorkflowDialog
        open={dialog === "delete"}
        onOpenChange={(open) => setDialog(open ? "delete" : null)}
        workflow={workflow}
        workspaceId={workspace.id}
        onDeleted={() => void navigate(`${basePath}/workflows`)}
      />
      <RestoreVersionDialog
        open={dialog === "restore" && restoring !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        workflowId={workflow.id}
        workspaceId={workspace.id}
        number={restoring ?? 0}
        onRestored={(fresh) => {
          draft.reset(fresh);
          setSelection(null);
          setTab("editor");
        }}
      />
    </PageContainer>
  );
}

function ArchiveItem({ workflow, workspaceId }: { workflow: Workflow; workspaceId: string }) {
  const { t } = useTranslation("workflows");
  const archive = useArchiveWorkflow(workspaceId, workflow.id);
  return (
    <DropdownMenuItem
      onSelect={() =>
        archive.mutate(!workflow.archived, {
          onSuccess: () => toast.success(t(workflow.archived ? "menu.restored" : "menu.archived")),
        })
      }
    >
      {workflow.archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
      {t(workflow.archived ? "menu.restore" : "menu.archive")}
    </DropdownMenuItem>
  );
}

function DeleteWorkflowDialog({
  open,
  onOpenChange,
  workflow,
  workspaceId,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: Workflow;
  workspaceId: string;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("workflows");
  const remove = useDeleteWorkflow(workspaceId, workflow.id);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("menu.deleteTitle", { name: workflow.name })}
      description={workflow.last_run ? t("menu.hasHistory") : t("menu.deleteBody")}
      confirmLabel={t("menu.delete")}
      resourceName={workflow.last_run ? undefined : workflow.name}
      pending={remove.isPending}
      onConfirm={() => {
        if (workflow.last_run) {
          onOpenChange(false);
          return;
        }
        remove.mutate(undefined, {
          onSuccess: () => {
            toast.success(t("menu.deleted"));
            onDeleted();
          },
          onError: (error) => toast.error(error.message),
        });
      }}
    />
  );
}

function RestoreVersionDialog({
  open,
  onOpenChange,
  workflowId,
  workspaceId,
  number,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string;
  workspaceId: string;
  number: number;
  onRestored: (workflow: Workflow) => void;
}) {
  const { t } = useTranslation("workflows");
  const restore = useRestoreVersion(workspaceId, workflowId);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={t("versions.restoreTitle", { version: number })}
      description={t("versions.restoreBody")}
      confirmLabel={t("versions.restore")}
      pending={restore.isPending}
      onConfirm={() =>
        restore.mutate(number, {
          onSuccess: (workflow) => {
            toast.success(t("versions.restored", { version: number }));
            onOpenChange(false);
            onRestored(workflow);
          },
          onError: (error) => toast.error(error.message),
        })
      }
    />
  );
}

function WorkflowRuns({
  workspaceId,
  workflowId,
  basePath,
}: {
  workspaceId: string;
  workflowId: string;
  basePath: string;
}) {
  const { t } = useTranslation("workflows");
  const runs = useWorkflowRuns(workspaceId, workflowId, 50);
  return (
    <RecentRuns
      runs={runs.data}
      pending={runs.isPending}
      basePath={basePath}
      title={t("editor.runsTab")}
      showWorkflow={false}
    />
  );
}

function Versions({
  workflow,
  canRestore,
  onRestore,
}: {
  workflow: Workflow;
  canRestore: boolean;
  onRestore: (number: number) => void;
}) {
  const { t } = useTranslation("workflows");
  const { dateTime } = useFormatters();
  const versions = useVersions(workflow.id);
  if (versions.isPending) return <Skeleton className="h-40 rounded-card" />;
  if (versions.isError) {
    return (
      <Card>
        <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />
      </Card>
    );
  }
  if (versions.data.length === 0) {
    return (
      <Card>
        <p className="px-5 py-10 text-center text-[13px] text-muted">{t("versions.empty")}</p>
      </Card>
    );
  }
  return (
    <Card>
      <ol className="divide-y divide-line">
        {versions.data.map((version) => (
          <li key={version.number} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
            <Badge tone={version.is_current ? "brand" : "outline"}>v{version.number}</Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-ink">
                {version.note?.trim() ? version.note : t("versions.noNote")}
              </p>
              <p className="text-[12px] text-muted">
                {dateTime(version.created_at)}
                {version.created_by ? ` · ${t("versions.by", { name: version.created_by })}` : ""}
              </p>
            </div>
            {version.is_current ? <Badge tone="success">{t("versions.current")}</Badge> : null}
            {canRestore ? (
              <Button size="sm" variant="secondary" onClick={() => onRestore(version.number)}>
                {t("versions.restore")}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}
