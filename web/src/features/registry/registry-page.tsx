import { Braces, Brain, Code2, Eye, Globe, Plug, Plus, Search, Wrench } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, Skeleton } from "@/components/ui/feedback";
import { Input } from "@/components/ui/field";
import { ErrorState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs";
import { useCreateTool } from "@/features/tools/api";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useRegistry, type RegistryModel, type RegistryTool } from "./api";

type ModelFilter = "all" | "used" | "configured";

function compactTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`
    : `${Math.round(value / 1000).toLocaleString()}K`;
}

function money(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 3,
  }).format(Number(amount));
}

/** The registry: every model and tool the workspace can use, with price and use. */
export function RegistryPage() {
  const { t } = useTranslation(["registry", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const registry = useRegistry(workspace.id);
  const [tab, setTab] = useState("models");
  useDocumentTitle(`${t("title")} — ${workspace.name}`);
  return (
    <PageContainer wide>
      <PageHeader title={t("title")} description={t("description")} />
      {registry.isPending ? (
        <Skeleton className="h-96 rounded-card" />
      ) : registry.isError ? (
        <Card>
          <ErrorState error={registry.error} onRetry={() => void registry.refetch()} />
        </Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList
            value={tab}
            aria-label={t("sections")}
            className="mb-4"
            items={[
              { value: "models", label: t("models.tab"), count: registry.data.models.length },
              { value: "tools", label: t("tools.tab"), count: registry.data.tools.length },
            ]}
          />
          <TabsContent value="models" className="focus-visible:outline-none">
            <Models models={registry.data.models} basePath={basePath} />
          </TabsContent>
          <TabsContent value="tools" className="focus-visible:outline-none">
            <Tools
              tools={registry.data.tools}
              basePath={basePath}
              workspaceId={workspace.id}
              canAdd={can(detail.data, "tools:write")}
            />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}

function Capabilities({ model }: { model: RegistryModel["model"] }) {
  const { t } = useTranslation("registry");
  const items = [
    { on: model.supports_tools, Icon: Wrench, label: t("models.caps.tools") },
    { on: model.supports_json, Icon: Braces, label: t("models.caps.json") },
    { on: model.supports_vision, Icon: Eye, label: t("models.caps.vision") },
    { on: model.reasoning !== "none", Icon: Brain, label: t("models.caps.reasoning") },
  ].filter((item) => item.on);
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t("models.capabilities")}>
      {items.map(({ Icon, label }) => (
        <li key={label}>
          <span
            role="img"
            aria-label={label}
            title={label}
            className="grid size-6 place-items-center rounded-md bg-surface-2 text-muted"
          >
            <Icon aria-hidden className="size-3.5" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Models({ models, basePath }: { models: RegistryModel[]; basePath: string }) {
  const { t } = useTranslation("registry");
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // What the workspace uses comes first, then what it can use right away.
    const rank = (entry: RegistryModel) =>
      entry.agents.length > 0 ? 0 : entry.providers.length > 0 ? 1 : 2;
    return [...models]
      .sort((a, b) => rank(a) - rank(b))
      .filter(
        (entry) =>
          (filter === "all" ||
            (filter === "used" && entry.agents.length > 0) ||
            (filter === "configured" && entry.providers.length > 0)) &&
          (!needle ||
            `${entry.model.display_name} ${entry.model.id} ${entry.provider_label}`
              .toLowerCase()
              .includes(needle)),
      );
  }, [models, filter, query]);
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("models.search")}
            aria-label={t("models.search")}
            className="pl-9"
          />
        </div>
        <div
          role="radiogroup"
          aria-label={t("models.filter")}
          className="inline-flex rounded-field border border-line p-0.5"
        >
          {(["all", "configured", "used"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                "h-8 rounded-[7px] px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                filter === value ? "bg-surface-2 text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              {t(`models.filters.${value}`)}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted">{t("models.none")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((entry) => {
            const pricing = entry.model.pricing;
            return (
              <li
                key={`${entry.provider_kind}:${entry.model.id}`}
                className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-ink">
                      {entry.model.display_name}
                    </span>
                    {entry.model.recommended ? (
                      <Badge tone="brand">{t("models.recommended")}</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[12px] text-muted">
                    {entry.model.id}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                    <span>{entry.provider_label}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {t("models.context", { size: compactTokens(entry.model.context_window) })}
                    </span>
                    <Capabilities model={entry.model} />
                  </div>
                </div>
                <div className="text-[13px]">
                  {pricing ? (
                    <>
                      <p className="text-ink tabular-nums">
                        {t("models.price", {
                          input: money(pricing.standard.input, pricing.currency),
                          output: money(pricing.standard.output, pricing.currency),
                        })}
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {t("models.perMillion")} ·{" "}
                        <a
                          href={pricing.source_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:text-ink hover:underline"
                        >
                          {t("models.asOf", { date: pricing.as_of })}
                        </a>
                      </p>
                    </>
                  ) : (
                    <p className="text-muted">{t("models.noPrice")}</p>
                  )}
                </div>
                <div className="text-[13px]">
                  {entry.providers.length === 0 ? (
                    <Link to={`${basePath}/providers`} className="text-brand-text hover:underline">
                      {t("models.configure")}
                    </Link>
                  ) : entry.agents.length === 0 ? (
                    <span className="text-muted">{t("models.unused")}</span>
                  ) : (
                    <AgentChips agents={entry.agents} basePath={basePath} />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function AgentChips({
  agents,
  basePath,
}: {
  agents: { id: string; name: string }[];
  basePath: string;
}) {
  const { t } = useTranslation("registry");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="sr-only">{t("usedBy")}</span>
      {agents.slice(0, 3).map((agent) => (
        <Link
          key={agent.id}
          to={`${basePath}/agents/${agent.id}`}
          className="rounded-full border border-line px-2 py-0.5 text-[12px] text-ink hover:border-line-strong"
        >
          {agent.name}
        </Link>
      ))}
      {agents.length > 3 ? (
        <span className="text-[12px] text-muted">{t("more", { count: agents.length - 3 })}</span>
      ) : null}
    </div>
  );
}

const KIND_ICONS = { builtin: Wrench, http: Globe, code: Code2, connector: Plug };

function Tools({
  tools,
  basePath,
  workspaceId,
  canAdd,
}: {
  tools: RegistryTool[];
  basePath: string;
  workspaceId: string;
  canAdd: boolean;
}) {
  const { t } = useTranslation("registry");
  const create = useCreateTool(workspaceId);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {tools.map((tool) => {
          const Icon = KIND_ICONS[tool.kind];
          return (
            <li
              key={tool.id ?? `builtin:${tool.builtin_key ?? tool.name}`}
              className="flex flex-wrap items-center gap-3 px-5 py-3.5"
            >
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted"
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {tool.id ? (
                    <Link
                      to={`${basePath}/tools/${tool.id}`}
                      className="text-[14px] font-medium text-ink hover:underline"
                    >
                      {tool.display_name}
                    </Link>
                  ) : (
                    <span className="text-[14px] font-medium text-ink">{tool.display_name}</span>
                  )}
                  <Badge tone="outline">{t(`tools.kind.${tool.kind}`)}</Badge>
                  {tool.uses_network ? <Badge tone="warning">{t("tools.network")}</Badge> : null}
                  {tool.id ? null : <Badge tone="neutral">{t("tools.available")}</Badge>}
                </div>
                <p className="mt-0.5 line-clamp-1 text-[12px] text-muted">{tool.description}</p>
              </div>
              <div className="text-[13px]">
                {tool.id === null ? (
                  canAdd ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Plus aria-hidden />}
                      loading={adding === tool.builtin_key}
                      onClick={() => {
                        setAdding(tool.builtin_key);
                        create.mutate(
                          { kind: "builtin", builtin_key: tool.builtin_key },
                          {
                            onSuccess: () => {
                              toast.success(t("tools.added", { name: tool.display_name }));
                              void queryClient.invalidateQueries({
                                queryKey: ["workspaces", workspaceId, "registry"],
                              });
                            },
                            onError: (error) => toast.error(error.message),
                            onSettled: () => setAdding(null),
                          },
                        );
                      }}
                    >
                      {t("tools.add")}
                    </Button>
                  ) : null
                ) : tool.agents.length ? (
                  <AgentChips agents={tool.agents} basePath={basePath} />
                ) : (
                  <span className="text-muted">{t("tools.unused")}</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
