import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { cn } from "@/lib/cn";
import { prettyJson } from "@/lib/json";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useAgentOptions } from "@/features/agents/api";
import {
  useCreateWorkflow,
  usePublish,
  useStartRun,
  useUpdateWorkflow,
  type Graph,
  type WorkflowRun,
} from "./api";
import { skeleton, templateGraph, type Template } from "./graph";
import { TypeIcon } from "./visual";

const TEMPLATES: { value: Template; needsAgent: boolean }[] = [
  { value: "blank", needsAgent: false },
  { value: "agent", needsAgent: true },
  { value: "branch", needsAgent: true },
];

type CreateValues = { name: string; description: string };

export function CreateWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  basePath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation(["workflows", "common"]);
  const navigate = useNavigate();
  const agents = useAgentOptions(workspaceId);
  const create = useCreateWorkflow(workspaceId);
  const [problem, setProblem] = useState<unknown>(null);
  const [template, setTemplate] = useState<Template>("blank");
  const agent = (agents.data ?? []).find((a) => a.status === "active" && a.ready);
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t("create.nameRequired")).max(80),
        description: z.string().trim().max(500),
      }),
    [t],
  );
  const form = useForm<CreateValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "" },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    const graph = templateGraph(
      template,
      {
        input: t("types.start"),
        output: t("types.end"),
        answer: t("create.labels.answer"),
        check: t("create.labels.check"),
        escalate: t("create.labels.escalate"),
        escalation: t("create.labels.escalation"),
      },
      agent?.id,
    );
    try {
      const workflow = await create.mutateAsync({ ...values, graph });
      toast.success(t("create.created", { name: workflow.name }));
      onOpenChange(false);
      form.reset();
      void navigate(`${basePath}/workflows/${workflow.id}`);
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "name"
          ? {
              field: "name",
              message: fieldError.code === "taken" ? t("create.nameTaken") : fieldError.message,
            }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("create.title")}
      description={t("create.description")}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="workflow-form" loading={isSubmitting}>
            {t("create.submit")}
          </Button>
        </>
      }
    >
      <form
        id="workflow-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5"
      >
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("create.name")} error={errors.name?.message} required>
          <Input
            maxLength={80}
            placeholder={t("create.namePlaceholder")}
            {...form.register("name")}
          />
        </Field>
        <Field label={t("create.descriptionLabel")}>
          <Textarea
            rows={2}
            maxLength={500}
            placeholder={t("create.descriptionPlaceholder")}
            {...form.register("description")}
          />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-ink">{t("create.template")}</legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {TEMPLATES.map((item) => {
              const disabled = item.needsAgent && !agent;
              const checked = template === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={disabled}
                  onClick={() => setTemplate(item.value)}
                  className={cn(
                    "flex h-full flex-col gap-1.5 rounded-card border p-3 text-left transition-[border-color,box-shadow,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    checked
                      ? "border-brand bg-brand-soft/40 shadow-[var(--gv-glow-brand)]"
                      : "border-line hover:border-line-strong",
                    disabled && "cursor-not-allowed opacity-55",
                  )}
                >
                  <span className="flex items-center gap-1.5" aria-hidden>
                    <TypeIcon type="start" className="size-6" />
                    {item.value !== "blank" ? <TypeIcon type="agent" className="size-6" /> : null}
                    {item.value === "branch" ? (
                      <TypeIcon type="condition" className="size-6" />
                    ) : null}
                    <TypeIcon type="end" className="size-6" />
                  </span>
                  <span className="text-[13px] font-semibold text-ink">
                    {t(`create.templates.${item.value}.title`)}
                  </span>
                  <span className="text-[12px] leading-snug text-muted">
                    {disabled ? t("create.needsAgent") : t(`create.templates.${item.value}.body`)}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function RunWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  workflowId,
  workflowName,
  graph,
  draft,
  version,
  basePath,
  beforeStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workflowId: string;
  workflowName: string;
  /** The graph that will run (for its input schema). */
  graph: Graph;
  draft: boolean;
  version: number | null;
  basePath: string;
  /** Called before starting (the editor saves the draft first); false cancels. */
  beforeStart?: () => Promise<boolean>;
}) {
  const { t } = useTranslation(["workflows", "common"]);
  const navigate = useNavigate();
  const startRun = useStartRun(workspaceId, workflowId);
  const start = graph.nodes?.find((n) => n.type === "start");
  const schema = start?.type === "start" ? (start.input_schema ?? null) : null;
  const [mode, setMode] = useState<"text" | "json">(schema ? "json" : "text");
  const [text, setText] = useState("");
  const [json, setJson] = useState(() => prettyJson(schema ? skeleton(schema) : {}));
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);

  async function submit() {
    setProblem(null);
    let input: string | Record<string, unknown> = text;
    if (mode === "json") {
      try {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        input = parsed as Record<string, unknown>;
      } catch {
        setError(t("runDialog.invalidJson"));
        return;
      }
    } else if (!text.trim()) {
      setError(t("runDialog.required"));
      return;
    }
    setError(null);
    if (beforeStart && !(await beforeStart())) return;
    try {
      const run: WorkflowRun = await startRun.mutateAsync({ input, draft, version: null });
      toast.success(t("runDialog.started"));
      onOpenChange(false);
      void navigate(`${basePath}/workflows/runs/${run.id}`);
    } catch (failure) {
      setProblem(failure);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft ? t("runDialog.titleDraft") : t("runDialog.title", { name: workflowName })}
      description={
        draft
          ? t("runDialog.descriptionDraft")
          : t("runDialog.description", { version: version ?? "" })
      }
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={startRun.isPending}>
            {t("runDialog.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <div
          role="radiogroup"
          aria-label={t("runDialog.format")}
          className="inline-flex w-fit rounded-field border border-line p-0.5"
        >
          {(["text", "json"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => {
                setMode(value);
                setError(null);
              }}
              className={cn(
                "h-8 rounded-[7px] px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                mode === value ? "bg-surface-2 text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              {t(`runDialog.${value}`)}
            </button>
          ))}
        </div>
        {mode === "text" ? (
          <Field label={t("runDialog.input")} error={error}>
            <Textarea
              rows={5}
              value={text}
              placeholder={t("runDialog.placeholder")}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        ) : (
          <Field
            label={t("runDialog.input")}
            hint={schema ? t("runDialog.schemaHint") : undefined}
            error={error}
          >
            <CodeEditor value={json} onChange={setJson} minHeight="140px" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function PublishDialog({
  open,
  onOpenChange,
  workspaceId,
  workflowId,
  nextVersion,
  beforePublish,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workflowId: string;
  nextVersion: number;
  beforePublish: () => Promise<boolean>;
  onPublished: () => void;
}) {
  const { t } = useTranslation(["workflows", "common"]);
  const publish = usePublish(workspaceId, workflowId);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<unknown>(null);
  async function submit() {
    setProblem(null);
    if (!(await beforePublish())) return;
    try {
      const version = await publish.mutateAsync(note.trim() || null);
      toast.success(t("editor.published", { version: version.number }));
      setNote("");
      onOpenChange(false);
      onPublished();
    } catch (error) {
      setProblem(error);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("editor.publishTitle", { version: nextVersion })}
      description={t("editor.publishBody")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={publish.isPending}>
            {t("editor.publish")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("editor.note")}>
          <Input
            value={note}
            maxLength={280}
            placeholder={t("editor.notePlaceholder")}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

export function RenameWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  workflowId,
  name,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workflowId: string;
  name: string;
  description: string;
}) {
  const { t } = useTranslation(["workflows", "common"]);
  const update = useUpdateWorkflow(workspaceId, workflowId);
  const [problem, setProblem] = useState<unknown>(null);
  const schema = useMemo(
    () =>
      z.object({
        name: z.string().trim().min(1, t("create.nameRequired")).max(80),
        description: z.string().trim().max(500),
      }),
    [t],
  );
  const form = useForm<CreateValues>({
    resolver: zodResolver(schema),
    defaultValues: { name, description },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      await update.mutateAsync(values);
      toast.success(t("menu.renamed"));
      onOpenChange(false);
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) =>
        fieldError.field === "name"
          ? {
              field: "name",
              message: fieldError.code === "taken" ? t("create.nameTaken") : fieldError.message,
            }
          : null,
      );
      if (!placed) setProblem(error);
    }
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("menu.renameTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="rename-workflow" loading={isSubmitting}>
            {t("common:actions.save")}
          </Button>
        </>
      }
    >
      <form
        id="rename-workflow"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5"
      >
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("create.name")} error={errors.name?.message} required>
          <Input maxLength={80} {...form.register("name")} />
        </Field>
        <Field label={t("create.descriptionLabel")}>
          <Textarea rows={2} maxLength={500} {...form.register("description")} />
        </Field>
      </form>
    </Dialog>
  );
}
