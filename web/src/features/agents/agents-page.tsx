import {
  Archive,
  ArchiveRestore,
  Copy,
  Ellipsis,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { hasErrorCode } from "@/lib/api/errors";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useFormatters } from "@/lib/format";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { listItem, staggerChildren } from "@/components/motion/presets";
import { StatusBadge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useProviders } from "@/features/providers/api";
import { LaunchDialog } from "@/features/executions/launch-dialog";
import {
  useAgents,
  useDeleteAgent,
  useDuplicateAgent,
  useSetArchived,
  type Agent,
  type AgentStatusFilter,
} from "./api";
import { ModelChip, ReadinessBadge } from "./agent-visual";

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Screen H — agents: search, filters, readiness and the last execution of each. */
export function AgentsPage() {
  const { t } = useTranslation(["agents", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const write = can(detail.data, "agents:write");
  const launchAllowed = can(detail.data, "executions:launch");
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useDebounced(search);
  const status = (params.get("status") as AgentStatusFilter | null) ?? "active";
  const providerId = params.get("provider");
  const providers = useProviders(workspace.id);
  const agents = useAgents(workspace.id, { q, status, providerId });
  const [launching, setLaunching] = useState<Agent | null>(null);
  useDocumentTitle(`${t("title")} — ${workspace.name}`);

  const rows = useMemo(() => agents.data?.pages.flatMap((page) => page.data) ?? [], [agents.data]);
  const filtered = q !== "" || status !== "active" || providerId !== null;

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    setParam("q", q || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror the debounced search only
  }, [q]);

  const noProvider = providers.data?.length === 0;

  return (
    <PageContainer wide>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          write ? (
            <Button asChild leftIcon={<Plus aria-hidden />}>
              <Link to={`${basePath}/agents/new`}>{t("new")}</Link>
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="pl-9"
          />
        </div>
        <Select
          aria-label={t("filters.status")}
          value={status}
          onValueChange={(value) => setParam("status", value === "active" ? null : value)}
          className="sm:w-44"
          options={[
            { value: "active", label: t("filters.active") },
            { value: "archived", label: t("filters.archived") },
            { value: "all", label: t("filters.all") },
          ]}
        />
        {providers.data && providers.data.length > 1 ? (
          <Select
            aria-label={t("filters.provider")}
            value={providerId ?? "all"}
            onValueChange={(value) => setParam("provider", value === "all" ? null : value)}
            className="sm:w-56"
            options={[
              { value: "all", label: t("filters.allProviders") },
              ...providers.data.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        ) : null}
      </div>

      {agents.isPending ? (
        <Card className="divide-y divide-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <Skeleton className="h-10 flex-1" />
              <Skeleton className="hidden h-6 w-40 md:block" />
              <Skeleton className="hidden h-6 w-28 lg:block" />
            </div>
          ))}
        </Card>
      ) : agents.isError ? (
        <Card>
          <ErrorState
            title={t("loadError")}
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              illustration="agents"
              title={t("empty.filteredTitle")}
              description={t("empty.filteredBody")}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch("");
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  {t("common:actions.clearFilters")}
                </Button>
              }
            />
          ) : noProvider ? (
            <EmptyState
              illustration="providers"
              title={t("empty.title")}
              description={t("empty.noProvider")}
              action={
                <Button asChild>
                  <Link to={`${basePath}/providers`}>{t("empty.connectProvider")}</Link>
                </Button>
              }
              className="py-16"
            />
          ) : (
            <EmptyState
              illustration="agents"
              title={t("empty.title")}
              description={t("empty.body")}
              action={
                write ? (
                  <Button asChild leftIcon={<Plus aria-hidden />}>
                    <Link to={`${basePath}/agents/new`}>{t("new")}</Link>
                  </Button>
                ) : undefined
              }
              className="py-16"
            />
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div
            aria-hidden
            className="hidden grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_6rem_3rem] gap-4 border-b border-line bg-surface-2/50 px-5 py-2.5 text-xs font-medium text-muted lg:grid"
          >
            <span>{t("columns.agent")}</span>
            <span>{t("columns.model")}</span>
            <span>{t("columns.lastExecution")}</span>
            <span className="text-right">{t("columns.executions30d")}</span>
            <span />
          </div>
          <motion.ul
            variants={staggerChildren(0.03)}
            initial="hidden"
            animate="visible"
            className="divide-y divide-line"
            aria-label={t("title")}
          >
            <AnimatePresence initial={false}>
              {rows.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  basePath={basePath}
                  workspaceId={workspace.id}
                  write={write}
                  launchAllowed={launchAllowed}
                  onRun={() => setLaunching(agent)}
                />
              ))}
            </AnimatePresence>
          </motion.ul>
          {agents.hasNextPage ? (
            <div className="border-t border-line p-3 text-center">
              <Button
                variant="tertiary"
                loading={agents.isFetchingNextPage}
                onClick={() => void agents.fetchNextPage()}
              >
                {t("common:actions.loadMore")}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
      {launching ? (
        <LaunchDialog
          open
          onOpenChange={(open) => {
            if (!open) setLaunching(null);
          }}
          agent={launching}
          workspaceId={workspace.id}
          basePath={basePath}
        />
      ) : null}
    </PageContainer>
  );
}

function AgentRow({
  agent,
  basePath,
  workspaceId,
  write,
  launchAllowed,
  onRun,
}: {
  agent: Agent;
  basePath: string;
  workspaceId: string;
  write: boolean;
  launchAllowed: boolean;
  onRun: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { relative, dateTime } = useFormatters();
  const navigate = useNavigate();
  const duplicate = useDuplicateAgent(workspaceId);
  const setArchived = useSetArchived(workspaceId);
  const remove = useDeleteAgent(workspaceId);
  const [deleting, setDeleting] = useState(false);
  const href = `${basePath}/agents/${agent.id}`;
  const archived = agent.status === "archived";

  return (
    <motion.li
      variants={listItem}
      layout="position"
      exit={{ opacity: 0, height: 0 }}
      className={cn(
        "group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-surface-2/50",
        "lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_6rem_3rem]",
        archived && "opacity-75",
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={href}
            className="truncate text-[15px] font-semibold text-ink after:absolute after:inset-0 hover:text-brand-text focus-visible:outline-none"
          >
            {agent.name}
          </Link>
          {!agent.ready || archived ? <ReadinessBadge agent={agent} /> : null}
        </div>
        {agent.description ? (
          <p className="mt-0.5 truncate text-[13px] text-muted">{agent.description}</p>
        ) : null}
      </div>
      <ModelChip agent={agent} className="col-span-2 row-start-2 lg:col-span-1 lg:row-start-auto" />
      <div className="col-span-2 row-start-3 flex items-center gap-2 lg:col-span-1 lg:row-start-auto">
        {agent.last_execution ? (
          <>
            <StatusBadge status={agent.last_execution.status as "succeeded"} />
            <span
              className="text-[13px] text-muted"
              title={dateTime(agent.last_execution.created_at)}
            >
              {relative(agent.last_execution.created_at)}
            </span>
          </>
        ) : (
          <span className="text-[13px] text-muted">{t("neverRun")}</span>
        )}
      </div>
      <span className="hidden text-right text-sm text-ink tabular-nums lg:block">
        {agent.executions_30d.toLocaleString()}
        <span className="sr-only"> {t("columns.executions30d")}</span>
      </span>
      <div className="relative z-10 col-start-2 row-start-1 flex justify-end lg:col-start-auto lg:row-start-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="icon-sm"
              label={t("menu.label", { name: agent.name })}
              icon={<Ellipsis aria-hidden />}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => void navigate(href)}>
              <ExternalLink aria-hidden />
              {t("menu.open")}
            </DropdownMenuItem>
            {launchAllowed && !archived ? (
              <DropdownMenuItem disabled={!agent.ready} onSelect={onRun}>
                <Play aria-hidden />
                {t("menu.run")}
              </DropdownMenuItem>
            ) : null}
            {write && !archived ? (
              <DropdownMenuItem onSelect={() => void navigate(`${href}/edit`)}>
                <Pencil aria-hidden />
                {t("menu.edit")}
              </DropdownMenuItem>
            ) : null}
            {write ? (
              <>
                <DropdownMenuItem
                  onSelect={() =>
                    duplicate.mutate(agent.id, {
                      onSuccess: (copy) =>
                        toast.success(t("toasts.duplicated", { name: copy.name })),
                      onError: (error) => toast.error(error.message),
                    })
                  }
                >
                  <Copy aria-hidden />
                  {t("menu.duplicate")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() =>
                    setArchived.mutate(
                      { id: agent.id, archived: !archived },
                      {
                        onSuccess: (saved) =>
                          toast.success(
                            t(archived ? "toasts.restored" : "toasts.archived", {
                              name: saved.name,
                            }),
                          ),
                        onError: (error) => toast.error(error.message),
                      },
                    )
                  }
                >
                  {archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                  {archived ? t("menu.restore") : t("menu.archive")}
                </DropdownMenuItem>
                <DropdownMenuItem tone="danger" onSelect={() => setDeleting(true)}>
                  <Trash2 aria-hidden />
                  {t("menu.delete")}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t("deleteDialog.title", { name: agent.name })}
        description={t("deleteDialog.body")}
        confirmLabel={t("deleteDialog.confirm")}
        resourceName={agent.name}
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(agent.id, {
            onSuccess: () => {
              setDeleting(false);
              toast.success(t("toasts.deleted", { name: agent.name }));
            },
            onError: (error) => {
              setDeleting(false);
              toast.error(
                hasErrorCode(error, "agent_has_history")
                  ? t("deleteDialog.hasRuns")
                  : error.message,
              );
            },
          })
        }
      />
    </motion.li>
  );
}
