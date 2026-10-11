import { Check, Plus, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { can } from "@/lib/auth/permissions";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/field";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import {
  needsConfig,
  useBuiltinTools,
  useCreateTool,
  useTools,
  type BuiltinTool,
  type Tool,
  type ToolKind,
} from "./api";
import { ToolFormDialog } from "./tool-form";
import { NetworkBadge, ToolMark } from "./tool-visual";

/** Screen N — the tools agents may be allowed to call. */
export function ToolsPage() {
  const { t } = useTranslation(["tools", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const tools = useTools(workspace.id);
  const write = can(detail.data, "tools:write");
  const [query, setQuery] = useState("");
  const [choosing, setChoosing] = useState(false);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!tools.data) return [];
    if (!needle) return tools.data;
    return tools.data.filter((tool) =>
      [tool.display_name, tool.name, tool.description].some((v) =>
        v.toLowerCase().includes(needle),
      ),
    );
  }, [tools.data, query]);

  return (
    <PageContainer>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          write && tools.data && tools.data.length > 0 ? (
            <Button leftIcon={<Plus aria-hidden />} onClick={() => setChoosing(true)}>
              {t("add")}
            </Button>
          ) : null
        }
      />
      {!write && detail.data ? <Alert tone="info" title={t("readOnly")} className="mb-5" /> : null}
      {tools.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-card" />
          ))}
        </div>
      ) : tools.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={tools.error}
            onRetry={() => void tools.refetch()}
          />
        </Card>
      ) : tools.data.length === 0 ? (
        <Card>
          <EmptyState
            illustration="tools"
            title={t("empty.title")}
            description={t("empty.body")}
            action={
              write ? (
                <Button leftIcon={<Plus aria-hidden />} onClick={() => setChoosing(true)}>
                  {t("empty.action")}
                </Button>
              ) : undefined
            }
            className="py-16"
          />
        </Card>
      ) : (
        <>
          <div className="relative mb-4 max-w-sm">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("search")}
              aria-label={t("search")}
              className="pl-9"
            />
          </div>
          <motion.ul
            variants={staggerChildren(0.04)}
            initial="hidden"
            animate="visible"
            className="grid gap-3 lg:grid-cols-2"
          >
            <AnimatePresence initial={false}>
              {visible.map((tool) => (
                <ToolCard key={tool.id} tool={tool} to={`${basePath}/tools/${tool.id}`} />
              ))}
            </AnimatePresence>
          </motion.ul>
        </>
      )}
      {write ? (
        <NewToolDialog
          open={choosing}
          onOpenChange={setChoosing}
          workspaceId={workspace.id}
          basePath={basePath}
          existing={tools.data ?? []}
        />
      ) : null}
    </PageContainer>
  );
}

function ToolCard({ tool, to }: { tool: Tool; to: string }) {
  const { t } = useTranslation("tools");
  return (
    <motion.li variants={listItem} layout exit={{ opacity: 0 }}>
      <Link
        to={to}
        className="group flex h-full gap-4 rounded-card border border-line bg-surface p-4 shadow-sm transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-line-strong hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <ToolMark kind={tool.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-[15px] font-semibold text-ink group-hover:text-brand-text">
              {tool.display_name}
            </h2>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
              {tool.name}
            </code>
            {tool.status === "disabled" ? (
              <Badge tone="neutral">{t("status.disabled")}</Badge>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-[13px] text-muted">{tool.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="outline">{t(`kinds.${tool.kind as ToolKind | "connector"}`)}</Badge>
            <NetworkBadge usesNetwork={tool.uses_network} />
            <span className="text-xs text-muted">{t("usedBy", { count: tool.agent_count })}</span>
          </div>
        </div>
      </Link>
    </motion.li>
  );
}

function NewToolDialog({
  open,
  onOpenChange,
  workspaceId,
  basePath,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  basePath: string;
  existing: Tool[];
}) {
  const { t } = useTranslation(["tools", "common"]);
  const builtins = useBuiltinTools();
  const create = useCreateTool(workspaceId);
  const navigate = useNavigate();
  const [form, setForm] = useState<{ kind: ToolKind; builtin: BuiltinTool | null } | null>(null);
  const [session, setSession] = useState(0);
  const openForm = (next: { kind: ToolKind; builtin: BuiltinTool | null }) => {
    setSession((value) => value + 1);
    setForm(next);
  };
  const added = new Set(existing.map((tool) => tool.builtin_key).filter(Boolean));

  const addBuiltin = (builtin: BuiltinTool) => {
    if (needsConfig(builtin)) {
      onOpenChange(false);
      openForm({ kind: "builtin", builtin });
      return;
    }
    create.mutate(
      { kind: "builtin", builtin_key: builtin.key },
      {
        onSuccess: (tool) => {
          toast.success(t("create.createdToast", { name: tool.display_name }));
          onOpenChange(false);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="xl"
        title={t("create.title")}
        description={t("create.description")}
      >
        <div className="flex flex-col gap-6 pb-2">
          <section aria-labelledby="builtin-tools">
            <h3 id="builtin-tools" className="mb-3 text-[13px] font-medium text-ink">
              {t("create.builtinTitle")}
            </h3>
            {builtins.isPending ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {(builtins.data ?? []).map((builtin) => {
                  const isAdded = added.has(builtin.key);
                  return (
                    <li
                      key={builtin.key}
                      className="flex items-start gap-3 rounded-card border border-line p-3"
                    >
                      <ToolMark kind="builtin" className="size-9" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">{builtin.display_name}</p>
                        <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">
                          {builtin.description}
                        </p>
                      </div>
                      {isAdded ? (
                        <Badge tone="success" icon={<Check aria-hidden />}>
                          {t("create.added")}
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={t("create.add", { name: builtin.display_name })}
                          loading={create.isPending && create.variables.builtin_key === builtin.key}
                          onClick={() => addBuiltin(builtin)}
                        >
                          {t("common:actions.create")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section aria-labelledby="custom-tools">
            <h3 id="custom-tools" className="mb-3 text-[13px] font-medium text-ink">
              {t("create.custom")}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["http", "code"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    openForm({ kind, builtin: null });
                  }}
                  className="flex items-start gap-3 rounded-card border border-line p-3 text-left transition-[border-color,box-shadow] hover:border-brand hover:shadow-glow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  <ToolMark kind={kind} className="size-9" />
                  <span>
                    <span className="block text-sm font-medium text-ink">{t(`kinds.${kind}`)}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">
                      {t(`kindDescriptions.${kind}`)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </Dialog>
      <ToolFormDialog
        key={session}
        open={form !== null}
        onOpenChange={(next) => {
          if (!next) setForm(null);
        }}
        workspaceId={workspaceId}
        kind={form?.kind ?? "http"}
        tool={null}
        builtin={form?.builtin ?? null}
        onSaved={(tool) => void navigate(`${basePath}/tools/${tool.id}`)}
      />
    </>
  );
}
