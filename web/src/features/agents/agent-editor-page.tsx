import { zodResolver } from "@hookform/resolvers/zod";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { isApiError } from "@/lib/api/errors";
import type { Schemas } from "@/lib/api/client";
import { can } from "@/lib/auth/permissions";
import { cn } from "@/lib/cn";
import { useDocumentTitle } from "@/lib/use-document-title";
import { PageContainer, PageHeader } from "@/components/layout/page-header";
import { UnsavedChangesGuard } from "@/components/layout/unsaved-changes";
import { fadeUp } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/controls";
import { Alert, Card, Skeleton } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { AccessDenied, ErrorState, NotFoundState } from "@/components/ui/states";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import {
  modelChoices,
  useProviderKinds,
  useProviders,
  type Provider,
} from "@/features/providers/api";
import { useTools, type Tool } from "@/features/tools/api";
import { ToolMark } from "@/features/tools/tool-visual";
import { useCurrentWorkspace } from "@/features/workspaces/use-current-workspace";
import { useAgent, useCreateAgent, useUpdateAgent, type Agent } from "./api";

const MAX_INSTRUCTIONS = 32_000;
const SECTIONS = ["identity", "instructions", "model", "tools", "limits", "review"] as const;
type Section = (typeof SECTIONS)[number];
const REASONING = ["auto", "off", "low", "medium", "high", "max"] as const;

type Values = {
  name: string;
  description: string;
  instructions: string;
  provider_id: string;
  model: string;
  temperature: string;
  max_output_tokens: string;
  reasoning: (typeof REASONING)[number];
  response_format: "text" | "json";
  tool_ids: string[];
  max_steps: string;
  max_tool_calls: string;
  timeout_s: string;
  max_total_tokens: string;
  max_cost_usd: string;
  change_note: string;
};

function initial(agent: Agent | undefined, providers: Provider[]): Values {
  const v = agent?.version;
  const firstProvider = providers.find((p) => p.status !== "error") ?? providers[0];
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    instructions: v?.instructions ?? "",
    provider_id: v?.provider_id ?? (agent ? "" : (firstProvider?.id ?? "")),
    model: v?.model ?? (agent ? "" : (firstProvider?.default_model ?? "")),
    temperature: v?.parameters.temperature?.toString() ?? "",
    max_output_tokens: v?.parameters.max_output_tokens?.toString() ?? "",
    reasoning: v?.parameters.reasoning ?? "auto",
    response_format: v?.parameters.response_format ?? "text",
    tool_ids: v?.tools.map((tool) => tool.id) ?? [],
    max_steps: String(v?.limits.max_steps ?? 8),
    max_tool_calls: String(v?.limits.max_tool_calls ?? 20),
    timeout_s: String(v?.limits.timeout_s ?? 120),
    max_total_tokens: v?.limits.max_total_tokens?.toString() ?? "",
    max_cost_usd: v?.limits.max_cost_usd ?? "",
    change_note: "",
  };
}

const optionalNumber = (min: number, max: number, message: string, integer = true) =>
  z
    .string()
    .trim()
    .refine((value) => {
      if (value === "") return true;
      const n = Number(value);
      return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
    }, message);

/** Screen I — create or edit an agent, section by section, validated before saving. */
export function AgentEditorPage() {
  const { agentId } = useParams();
  const { t } = useTranslation(["agents", "common"]);
  const { workspace, basePath, detail } = useCurrentWorkspace();
  const agent = useAgent(agentId ?? "", agentId !== undefined);
  const providers = useProviders(workspace.id);
  const tools = useTools(workspace.id);
  const editing = agentId !== undefined;
  const title = editing
    ? t("editor.editTitle", { name: agent.data?.name ?? "" })
    : t("editor.createTitle");
  useDocumentTitle(`${title} — ${workspace.name}`);

  if (detail.data && !can(detail.data, "agents:write")) {
    return <AccessDenied className="min-h-[60vh]" />;
  }
  if ((editing && agent.isPending) || providers.isPending || tools.isPending) {
    return (
      <PageContainer wide>
        <Skeleton className="mb-6 h-12 w-96" />
        <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
          <Skeleton className="hidden h-64 lg:block" />
          <Skeleton className="h-[32rem] rounded-card" />
        </div>
      </PageContainer>
    );
  }
  if (editing && agent.isError) {
    return isApiError(agent.error) && agent.error.isNotFound ? (
      <NotFoundState
        headingLevel="h1"
        title={t("detail.notFoundTitle")}
        description={t("detail.notFoundBody")}
        className="min-h-[60vh]"
      />
    ) : (
      <PageContainer>
        <Card>
          <ErrorState error={agent.error} onRetry={() => void agent.refetch()} />
        </Card>
      </PageContainer>
    );
  }
  if (providers.isError || tools.isError) {
    return (
      <PageContainer>
        <Card>
          <ErrorState
            error={providers.error ?? tools.error}
            onRetry={() => {
              void providers.refetch();
              void tools.refetch();
            }}
          />
        </Card>
      </PageContainer>
    );
  }
  return (
    <AgentEditor
      key={agent.data?.id ?? "new"}
      agent={editing ? agent.data : undefined}
      providers={providers.data}
      tools={tools.data}
      workspaceId={workspace.id}
      basePath={basePath}
      title={title}
    />
  );
}

function AgentEditor({
  agent,
  providers,
  tools,
  workspaceId,
  basePath,
  title,
}: {
  agent: Agent | undefined;
  providers: Provider[];
  tools: Tool[];
  workspaceId: string;
  basePath: string;
  title: string;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const navigate = useNavigate();
  const kinds = useProviderKinds();
  const create = useCreateAgent(workspaceId);
  const update = useUpdateAgent(workspaceId);
  const [problem, setProblem] = useState<unknown>(null);
  const [active, setActive] = useState<Section>("identity");
  const nextVersion = (agent?.latest_version_number ?? 0) + 1;

  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t("editor.nameRequired")).max(80, t("editor.nameTooLong")),
        description: z.string().trim().max(500),
        instructions: z.string().max(MAX_INSTRUCTIONS),
        provider_id: z.string(),
        model: z.string().trim().max(120),
        temperature: optionalNumber(0, 2, "0 – 2", false),
        max_output_tokens: optionalNumber(1, 400_000, "1 – 400 000"),
        reasoning: z.enum(REASONING),
        response_format: z.enum(["text", "json"]),
        tool_ids: z.array(z.string()),
        max_steps: optionalNumber(1, 50, "1 – 50"),
        max_tool_calls: optionalNumber(0, 200, "0 – 200"),
        timeout_s: optionalNumber(5, 3600, "5 – 3600"),
        max_total_tokens: optionalNumber(100, 10_000_000, "100 – 10 000 000"),
        max_cost_usd: optionalNumber(0.0001, 1000, "0.0001 – 1000", false),
        change_note: z.string().trim().max(280),
      }),
    [t],
  );

  const defaults = useMemo(() => initial(agent, providers), [agent, providers]);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });
  const { errors, isDirty, isSubmitting } = form.formState;
  // Set (and rendered) before leaving after a save, so the unsaved-changes guard lets us go.
  const [saved, setSaved] = useState(false);
  const values = useWatch({ control: form.control });

  const provider = providers.find((p) => p.id === values.provider_id);
  const kind = kinds.data?.find((k) => k.kind === provider?.kind);
  const choices = modelChoices(kind, provider);
  const modelInfo = choices.find((c) => c.id === values.model)?.info ?? null;
  const selectedTools = tools.filter((tool) => values.tool_ids?.includes(tool.id));

  // Scroll-spy: highlight the section being read.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id.replace("section-", "") as Section);
      },
      { rootMargin: "-20% 0px -60% 0px" },
    );
    for (const section of SECTIONS) {
      const element = document.getElementById(`section-${section}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const issues: string[] = [];
  if (!values.provider_id) issues.push("no_provider");
  else if (provider?.status === "error") issues.push("provider_error");
  if (!values.model) issues.push("no_model");
  if (selectedTools.some((tool) => tool.status !== "active")) issues.push("tool_unavailable");
  const blocking = issues.some((issue) => issue === "no_provider" || issue === "no_model");

  const onSubmit = form.handleSubmit(async (v) => {
    setProblem(null);
    const parameters: Schemas["AgentParameters-Input"] = {
      temperature: v.temperature ? Number(v.temperature) : null,
      max_output_tokens: v.max_output_tokens ? Number(v.max_output_tokens) : null,
      reasoning: v.reasoning,
      response_format: v.response_format,
    };
    const limits: Schemas["AgentLimits-Input"] = {
      max_steps: Number(v.max_steps || 8),
      max_tool_calls: Number(v.max_tool_calls || 20),
      timeout_s: Number(v.timeout_s || 120),
      max_total_tokens: v.max_total_tokens ? Number(v.max_total_tokens) : null,
      max_cost_usd: v.max_cost_usd ? v.max_cost_usd : null,
    };
    try {
      const result = agent
        ? await update.mutateAsync({
            id: agent.id,
            body: {
              name: v.name,
              description: v.description,
              instructions: v.instructions,
              provider_id: v.provider_id || null,
              model: v.model || null,
              parameters,
              tool_ids: v.tool_ids,
              limits,
              change_note: v.change_note || null,
            },
          })
        : await create.mutateAsync({
            name: v.name,
            description: v.description,
            instructions: v.instructions,
            provider_id: v.provider_id || null,
            model: v.model || null,
            parameters,
            tool_ids: v.tool_ids,
            limits,
          });
      toast.success(
        agent
          ? t("toasts.saved", { name: result.name, version: result.latest_version_number })
          : t("toasts.created", { name: result.name }),
      );
      flushSync(() => setSaved(true));
      void navigate(`${basePath}/agents/${result.id}`);
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        const [root, leaf] = fieldError.field.split(".");
        if (root === "name") {
          return {
            field: "name",
            message: fieldError.code === "taken" ? t("editor.nameTaken") : fieldError.message,
          };
        }
        if (root === "limits" && leaf) {
          const field = leaf as keyof Values;
          return field in defaults ? { field, message: fieldError.message } : null;
        }
        if (
          root === "provider_id" ||
          root === "model" ||
          root === "tool_ids" ||
          root === "instructions"
        ) {
          return { field: root, message: fieldError.message };
        }
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  return (
    <PageContainer wide>
      <UnsavedChangesGuard when={isDirty && !saved} />
      <PageHeader
        breadcrumbs={[
          { label: t("editor.breadcrumb"), to: `${basePath}/agents` },
          ...(agent ? [{ label: agent.name, to: `${basePath}/agents/${agent.id}` }] : []),
          { label: agent ? t("common:actions.edit") : t("editor.createTitle") },
        ]}
        title={title}
        description={
          agent ? t("editor.editDescription", { next: nextVersion }) : t("editor.createDescription")
        }
      />
      {agent?.status === "archived" ? (
        <Alert tone="warning" title={t("editor.archivedTitle")} className="mb-6">
          {t("editor.archivedBody")}
        </Alert>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label={t("editor.sectionsLabel")} className="hidden lg:block">
          <ol className="sticky top-6 flex flex-col gap-0.5 border-l border-line">
            {SECTIONS.map((section) => (
              <li key={section}>
                <a
                  href={`#section-${section}`}
                  aria-current={active === section ? "location" : undefined}
                  className={cn(
                    "-ml-px block border-l-2 border-transparent py-1.5 pl-4 text-[13px] text-muted transition-colors hover:text-ink",
                    active === section && "border-brand font-medium text-ink",
                  )}
                >
                  {t(`editor.sections.${section}`)}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <form
          noValidate
          onSubmit={(event) => void onSubmit(event)}
          className="flex min-w-0 flex-col gap-6"
          aria-label={title}
        >
          {problem ? <FormProblemAlert error={problem} /> : null}

          <EditorSection id="identity" title={t("editor.sections.identity")}>
            <Field label={t("editor.name")} error={errors.name?.message} required>
              <Input
                maxLength={80}
                placeholder={t("editor.namePlaceholder")}
                {...form.register("name")}
              />
            </Field>
            <Field label={t("editor.descriptionLabel")} error={errors.description?.message}>
              <Input
                maxLength={500}
                placeholder={t("editor.descriptionPlaceholder")}
                {...form.register("description")}
              />
            </Field>
          </EditorSection>

          <EditorSection id="instructions" title={t("editor.sections.instructions")}>
            <Field
              label={t("editor.instructions")}
              description={t("editor.instructionsHelp")}
              error={errors.instructions?.message}
              hint={
                <span className="tabular-nums">
                  {t("editor.characters", {
                    count: (values.instructions ?? "").length.toLocaleString(),
                    max: MAX_INSTRUCTIONS.toLocaleString(),
                  })}
                </span>
              }
            >
              <Textarea
                rows={10}
                maxLength={MAX_INSTRUCTIONS}
                placeholder={t("editor.instructionsPlaceholder")}
                className="font-mono text-[13px] leading-relaxed"
                {...form.register("instructions")}
              />
            </Field>
          </EditorSection>

          <EditorSection id="model" title={t("editor.sections.model")}>
            {providers.length === 0 ? (
              <Alert tone="info" title={t("editor.noProviders")}>
                <Link to={`${basePath}/providers`} className="font-medium underline">
                  {t("editor.addProvider")}
                </Link>
              </Alert>
            ) : null}
            <div className="grid gap-5 md:grid-cols-2">
              <Field label={t("editor.provider")} error={errors.provider_id?.message}>
                <Controller
                  control={form.control}
                  name="provider_id"
                  render={({ field }) => (
                    <Select
                      value={field.value || undefined}
                      placeholder={t("editor.providerPlaceholder")}
                      onValueChange={(value) => {
                        field.onChange(value);
                        const next = providers.find((p) => p.id === value);
                        form.setValue("model", next?.default_model ?? "", { shouldDirty: true });
                      }}
                      options={providers.map((p) => ({
                        value: p.id,
                        label: p.name,
                        description: p.kind_label,
                      }))}
                    />
                  )}
                />
              </Field>
              <Field label={t("editor.model")} error={errors.model?.message}>
                {choices.length > 0 ? (
                  <Controller
                    control={form.control}
                    name="model"
                    render={({ field }) => (
                      <Select
                        value={field.value || undefined}
                        placeholder={t("editor.modelPlaceholder")}
                        onValueChange={field.onChange}
                        disabled={!provider}
                        options={choices.map((choice) => ({
                          value: choice.id,
                          label: choice.info?.display_name ?? choice.id,
                        }))}
                      />
                    )}
                  />
                ) : (
                  <Input className="font-mono" disabled={!provider} {...form.register("model")} />
                )}
              </Field>
            </div>
            <ModelFacts
              info={modelInfo}
              known={Boolean(values.model)}
              toolsSelected={selectedTools.length}
            />

            <div className="grid gap-5 border-t border-line pt-5 md:grid-cols-2">
              <Field
                label={t("editor.temperature")}
                description={t("editor.temperatureHelp")}
                error={errors.temperature?.message}
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  step={0.1}
                  min={0}
                  max={2}
                  {...form.register("temperature")}
                />
              </Field>
              <Field
                label={t("editor.maxOutput")}
                description={t("editor.maxOutputHelp")}
                error={errors.max_output_tokens?.message}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  {...form.register("max_output_tokens")}
                />
              </Field>
              <Field label={t("editor.reasoning")} description={t("editor.reasoningHelp")}>
                <Controller
                  control={form.control}
                  name="reasoning"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={REASONING.map((level) => ({
                        value: level,
                        label: t(`editor.reasoningLevels.${level}`),
                      }))}
                    />
                  )}
                />
              </Field>
              <Field label={t("editor.responseFormat")}>
                <Controller
                  control={form.control}
                  name="response_format"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      options={(["text", "json"] as const).map((format) => ({
                        value: format,
                        label: t(`editor.responseFormats.${format}`),
                      }))}
                    />
                  )}
                />
              </Field>
            </div>
          </EditorSection>

          <EditorSection
            id="tools"
            title={t("editor.sections.tools")}
            aside={
              <span className="text-[13px] text-muted">
                {t("editor.selectedTools", { count: selectedTools.length })}
              </span>
            }
          >
            <p className="text-[13px] text-muted">{t("editor.toolsHelp")}</p>
            {tools.length === 0 ? (
              <p className="text-[13px] text-muted">
                {t("editor.toolsEmpty")}{" "}
                <Link
                  to={`${basePath}/tools`}
                  className="font-medium text-brand-text hover:underline"
                >
                  {t("editor.manageTools")}
                </Link>
              </p>
            ) : (
              <Controller
                control={form.control}
                name="tool_ids"
                render={({ field }) => (
                  <ul className="grid gap-2 md:grid-cols-2">
                    {tools.map((tool) => {
                      const checked = field.value.includes(tool.id);
                      const id = `tool-${tool.id}`;
                      return (
                        <li key={tool.id}>
                          <label
                            htmlFor={id}
                            className={cn(
                              "flex h-full cursor-pointer items-start gap-3 rounded-card border border-line p-3 transition-[border-color,background-color,box-shadow]",
                              "hover:border-line-strong has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
                              checked && "border-brand bg-brand-soft/30",
                            )}
                          >
                            <Checkbox
                              id={id}
                              checked={checked}
                              className="mt-0.5"
                              onCheckedChange={(next) =>
                                field.onChange(
                                  next
                                    ? [...field.value, tool.id]
                                    : field.value.filter((value) => value !== tool.id),
                                )
                              }
                            />
                            <ToolMark kind={tool.kind} className="size-8 rounded-md" />
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                                {tool.display_name}
                                {tool.status !== "active" ? (
                                  <Badge tone="neutral" className="h-5 px-2 text-[11px]">
                                    {t("editor.toolDisabled")}
                                  </Badge>
                                ) : null}
                              </span>
                              <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">
                                {tool.description}
                              </span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              />
            )}
          </EditorSection>

          <EditorSection id="limits" title={t("editor.sections.limits")}>
            <div className="grid gap-5 md:grid-cols-3">
              <Field
                label={t("editor.maxSteps")}
                description={t("editor.maxStepsHelp")}
                error={errors.max_steps?.message}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50}
                  {...form.register("max_steps")}
                />
              </Field>
              <Field label={t("editor.maxToolCalls")} error={errors.max_tool_calls?.message}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={200}
                  {...form.register("max_tool_calls")}
                />
              </Field>
              <Field label={t("editor.timeout")} error={errors.timeout_s?.message}>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={5}
                  max={3600}
                  {...form.register("timeout_s")}
                />
              </Field>
              <Field
                label={t("editor.maxTokens")}
                description={t("editor.maxTokensHelp")}
                error={errors.max_total_tokens?.message}
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  min={100}
                  {...form.register("max_total_tokens")}
                />
              </Field>
              <Field
                label={t("editor.maxCost")}
                description={t("editor.maxCostHelp")}
                error={errors.max_cost_usd?.message}
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min={0}
                  {...form.register("max_cost_usd")}
                />
              </Field>
            </div>
          </EditorSection>

          <EditorSection id="review" title={t("editor.sections.review")}>
            <motion.div variants={fadeUp} initial="hidden" animate="visible">
              {blocking || issues.length > 0 ? (
                <Alert tone="warning" title={t("editor.notReadyTitle")}>
                  <ul className="mt-1 list-disc pl-5">
                    {issues.map((issue) => (
                      <li key={issue}>{t(`issues.${issue as "no_provider"}`)}</li>
                    ))}
                  </ul>
                </Alert>
              ) : (
                <div className="flex items-start gap-3 rounded-card bg-success-soft px-4 py-3 text-success-text">
                  <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <p className="font-medium">{t("editor.readyTitle")}</p>
                    <p className="text-[13px] opacity-90">{t("editor.readyBody")}</p>
                  </div>
                </div>
              )}
            </motion.div>
            {agent ? (
              <Field
                label={t("editor.changeNote")}
                description={t("editor.changeNoteHelp")}
                error={errors.change_note?.message}
              >
                <Input
                  maxLength={280}
                  placeholder={t("editor.changeNotePlaceholder")}
                  {...form.register("change_note")}
                />
              </Field>
            ) : null}
          </EditorSection>

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-canvas/90 px-4 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:items-center sm:justify-end sm:rounded-card sm:border sm:px-5">
            <Button
              variant="secondary"
              onClick={() =>
                void navigate(agent ? `${basePath}/agents/${agent.id}` : `${basePath}/agents`)
              }
            >
              {t("editor.cancel")}
            </Button>
            <Button
              type="submit"
              loading={isSubmitting}
              disabled={agent?.status === "archived" || (Boolean(agent) && !isDirty)}
            >
              {agent ? t("editor.saveVersion", { next: nextVersion }) : t("editor.save")}
            </Button>
          </div>
        </form>
      </div>
    </PageContainer>
  );
}

function EditorSection({
  id,
  title,
  aside,
  children,
}: {
  id: Section;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={`section-${id}`} aria-labelledby={`heading-${id}`} className="scroll-mt-6">
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 id={`heading-${id}`} className="text-[15px] font-semibold text-ink">
            {title}
          </h2>
          {aside}
        </div>
        <div className="flex flex-col gap-5 p-5">{children}</div>
      </Card>
    </section>
  );
}

function ModelFacts({
  info,
  known,
  toolsSelected,
}: {
  info: Schemas["ModelInfoOut"] | null;
  known: boolean;
  toolsSelected: number;
}) {
  const { t } = useTranslation("agents");
  if (!known) return null;
  if (!info) {
    return (
      <p className="flex items-start gap-2 text-[13px] text-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        {t("editor.modelUnknown")}
      </p>
    );
  }
  const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
  return (
    <div className="flex flex-col gap-2 rounded-card bg-surface-2/60 px-4 py-3 text-[13px]">
      <p className="text-ink">
        {t("editor.modelFacts", {
          window: compact.format(info.context_window),
          output: compact.format(info.max_output_tokens),
        })}
      </p>
      {info.pricing ? (
        <p className="text-muted">
          {t("editor.modelPrice", {
            input: info.pricing.standard.input,
            output: info.pricing.standard.output,
            currency: info.pricing.currency,
          })}
        </p>
      ) : null}
      {!info.supports_tools && toolsSelected > 0 ? (
        <p className="flex items-start gap-2 text-warning-text">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("editor.modelNoTools")}
        </p>
      ) : null}
    </div>
  );
}
