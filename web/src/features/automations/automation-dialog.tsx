import { Bot, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { cn } from "@/lib/cn";
import { prettyJson } from "@/lib/json";
import { useFormatters } from "@/lib/format";
import { isApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select, Switch } from "@/components/ui/controls";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useAgentOptions } from "@/features/agents/api";
import { useWorkflows } from "@/features/workflows/api";
import {
  useCreateAutomation,
  useCronPreview,
  useUpdateAutomation,
  type Automation,
  type AutomationCreated,
} from "./api";
import { browserTimeZone, CRON_PRESETS, describeCron, timeZones } from "./cron";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: Automation["kind"];
  workspaceId: string;
  basePath: string;
  /** Editing an existing automation (its kind cannot change). */
  automation?: Automation;
};

function initialText(value: Automation["input"]): {
  mode: "text" | "json";
  text: string;
  json: string;
} {
  if (value && "json" in value) return { mode: "json", text: "", json: prettyJson(value.json) };
  const text = value && typeof value.text === "string" ? value.text : "";
  return { mode: "text", text, json: "{}" };
}

/** Create or edit a schedule or a webhook: what it starts, when, and with which input. */
export function AutomationDialog({
  open,
  onOpenChange,
  kind,
  workspaceId,
  basePath,
  automation,
}: Props) {
  const { t, i18n } = useTranslation(["automations", "common"]);
  const navigate = useNavigate();
  const { dateTime } = useFormatters();
  const agents = useAgentOptions(workspaceId);
  const workflows = useWorkflows(workspaceId);
  const create = useCreateAutomation(workspaceId);
  const update = useUpdateAutomation(workspaceId, automation?.id ?? "");
  const [name, setName] = useState(automation?.name ?? "");
  const [description, setDescription] = useState(automation?.description ?? "");
  const [targetType, setTargetType] = useState<"agent" | "workflow">(
    automation?.target_type ?? "agent",
  );
  const [agentId, setAgentId] = useState(automation?.agent_id ?? "");
  const [workflowId, setWorkflowId] = useState(automation?.workflow_id ?? "");
  const [cron, setCron] = useState(automation?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(automation?.timezone ?? browserTimeZone());
  const [overlapSkip, setOverlapSkip] = useState(
    (automation?.overlap ?? (kind === "schedule" ? "skip" : "allow")) === "skip",
  );
  const initial = initialText(automation?.input ?? null);
  const [inputMode, setInputMode] = useState<"text" | "json">(initial.mode);
  const [inputText, setInputText] = useState(initial.text);
  const [inputJson, setInputJson] = useState(initial.json);
  const [template, setTemplate] = useState(automation?.input_template ?? "");
  const [signature, setSignature] = useState<"gouvra" | "github">(
    automation?.signature_format ?? "gouvra",
  );
  const [problem, setProblem] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<AutomationCreated | null>(null);
  const preview = useCronPreview(cron, timezone, kind === "schedule");
  const zones = useMemo(() => timeZones(), []);
  const words = describeCron(cron, i18n.language);

  const agentOptions = (agents.data ?? [])
    .filter((a) => a.status === "active" || a.id === agentId)
    .map((a) => ({ value: a.id, label: a.name }));
  const workflowOptions = (workflows.data ?? [])
    .filter((w) => w.current_version !== null || w.id === workflowId)
    .map((w) => ({ value: w.id, label: `${w.name} · v${w.current_version ?? "—"}` }));

  async function submit() {
    setProblem(null);
    setFieldError({});
    let input: string | Record<string, unknown> | undefined;
    if (kind === "schedule") {
      if (inputMode === "json") {
        try {
          const parsed: unknown = JSON.parse(inputJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          input = parsed as Record<string, unknown>;
        } catch {
          setFieldError({ input: t("form.invalidJson") });
          return;
        }
      } else {
        input = inputText;
      }
    }
    const body = {
      name,
      description,
      target_type: targetType,
      agent_id: targetType === "agent" ? agentId || null : null,
      workflow_id: targetType === "workflow" ? workflowId || null : null,
      ...(kind === "schedule"
        ? { cron, timezone, input, overlap: overlapSkip ? ("skip" as const) : ("allow" as const) }
        : {
            input_template: template.trim() ? template : null,
            signature_format: signature,
            overlap: overlapSkip ? ("skip" as const) : ("allow" as const),
          }),
    };
    try {
      if (automation) {
        await update.mutateAsync(body);
        toast.success(t("form.saved"));
        onOpenChange(false);
      } else {
        const result = await create.mutateAsync({ ...body, kind });
        toast.success(t("form.created", { name: result.name }));
        if (result.secret) {
          setCreated(result);
        } else {
          onOpenChange(false);
          void navigate(`${basePath}/automations/${result.id}`);
        }
      }
    } catch (error) {
      if (isApiError(error) && error.fieldErrors.length) {
        setFieldError(
          Object.fromEntries(
            error.fieldErrors.map((e) => [e.field.split(".")[0] ?? e.field, e.message]),
          ),
        );
      } else {
        setProblem(error);
      }
    }
  }

  if (created) {
    return (
      <SecretDialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          if (!next) void navigate(`${basePath}/automations/${created.id}`);
        }}
        secret={created.secret ?? ""}
        url={created.hook_url ?? ""}
      />
    );
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        automation
          ? t("form.editTitle", { name: automation.name })
          : t(kind === "schedule" ? "form.newSchedule" : "form.newWebhook")
      }
      description={t(kind === "schedule" ? "form.scheduleIntro" : "form.webhookIntro")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button onClick={() => void submit()} loading={pending}>
            {automation ? t("common:actions.save") : t("form.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <Field label={t("form.name")} error={fieldError.name} required>
          <Input
            value={name}
            maxLength={80}
            placeholder={t(
              kind === "schedule" ? "form.namePlaceholderSchedule" : "form.namePlaceholderWebhook",
            )}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t("form.description")}>
          <Textarea
            rows={2}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>

        <fieldset className="space-y-3">
          <legend className="mb-2 text-[13px] font-medium text-ink">{t("form.starts")}</legend>
          <div role="radiogroup" aria-label={t("form.starts")} className="grid grid-cols-2 gap-2">
            {(["agent", "workflow"] as const).map((type) => {
              const Icon = type === "agent" ? Bot : Workflow;
              return (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={targetType === type}
                  onClick={() => setTargetType(type)}
                  className={cn(
                    "flex items-center gap-2 rounded-field border px-3 py-2.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                    targetType === type
                      ? "border-brand bg-brand-soft/40 text-ink"
                      : "border-line text-muted hover:text-ink",
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  {t(`target.${type}`)}
                </button>
              );
            })}
          </div>
          {targetType === "agent" ? (
            <Field label={t("target.agent")} hideLabel error={fieldError.agent_id}>
              <Select
                value={agentId || undefined}
                onValueChange={setAgentId}
                placeholder={t("form.chooseAgent")}
                options={agentOptions}
              />
            </Field>
          ) : (
            <Field
              label={t("target.workflow")}
              hideLabel
              error={fieldError.workflow_id}
              hint={t("form.publishedOnly")}
            >
              <Select
                value={workflowId || undefined}
                onValueChange={setWorkflowId}
                placeholder={t("form.chooseWorkflow")}
                options={workflowOptions}
              />
            </Field>
          )}
        </fieldset>

        {kind === "schedule" ? (
          <>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink">{t("form.when")}</legend>
              <div className="mb-3 flex flex-wrap gap-2">
                {CRON_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    aria-pressed={cron === preset.cron}
                    onClick={() => setCron(preset.cron)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                      cron === preset.cron
                        ? "border-brand bg-brand-soft text-brand-text"
                        : "border-line text-muted hover:text-ink",
                    )}
                  >
                    {t(`presets.${preset.key}`)}
                  </button>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Field
                  label={t("form.cron")}
                  hint={t("form.cronHelp")}
                  error={
                    fieldError.cron ??
                    (preview.data && !preview.data.valid ? preview.data.message : null)
                  }
                >
                  <Input
                    value={cron}
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => setCron(event.target.value)}
                  />
                </Field>
                <Field label={t("form.timezone")} error={fieldError.timezone}>
                  <Select
                    value={timezone}
                    onValueChange={setTimezone}
                    options={zones.map((zone) => ({ value: zone, label: zone }))}
                  />
                </Field>
              </div>
              {preview.data?.valid ? (
                <div className="mt-3 rounded-field bg-surface-2 px-3 py-2.5 text-[13px]">
                  {words ? <p className="font-medium text-ink">{words}</p> : null}
                  <p className="mt-1 text-muted">
                    {t("form.nextRuns")}{" "}
                    {preview.data.upcoming
                      .slice(0, 3)
                      .map((when) => dateTime(when))
                      .join(" · ")}
                  </p>
                </div>
              ) : null}
            </fieldset>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-ink">{t("form.input")}</span>
                <div
                  role="radiogroup"
                  aria-label={t("form.inputFormat")}
                  className="inline-flex rounded-field border border-line p-0.5"
                >
                  {(["text", "json"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={inputMode === mode}
                      onClick={() => setInputMode(mode)}
                      className={cn(
                        "h-7 rounded-[7px] px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus",
                        inputMode === mode
                          ? "bg-surface-2 text-ink shadow-sm"
                          : "text-muted hover:text-ink",
                      )}
                    >
                      {t(`form.${mode}`)}
                    </button>
                  ))}
                </div>
              </div>
              {inputMode === "text" ? (
                <Field label={t("form.input")} hideLabel error={fieldError.input}>
                  <Textarea
                    rows={3}
                    value={inputText}
                    placeholder={t("form.inputPlaceholder")}
                    onChange={(event) => setInputText(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label={t("form.input")} hideLabel error={fieldError.input}>
                  <CodeEditor value={inputJson} onChange={setInputJson} minHeight="96px" />
                </Field>
              )}
            </div>
          </>
        ) : (
          <>
            <Field label={t("form.signature")} hint={t(`form.signatureHelp.${signature}`)}>
              <Select
                value={signature}
                onValueChange={(value) => setSignature(value as "gouvra" | "github")}
                options={[
                  { value: "gouvra", label: t("signature.gouvra") },
                  { value: "github", label: t("signature.github") },
                ]}
              />
            </Field>
            <Field
              label={t("form.template")}
              hint={t("form.templateHelp", { example: "{{input.ticket.title}}" })}
              error={fieldError.input_template}
            >
              <Textarea
                rows={3}
                value={template}
                spellCheck={false}
                className="font-mono text-[12.5px]"
                placeholder={t("form.templatePlaceholder")}
                onChange={(event) => setTemplate(event.target.value)}
              />
            </Field>
          </>
        )}
        <div className="flex items-start justify-between gap-4 text-[13px] text-ink">
          <span>
            <span id="overlap-label" className="block font-medium">
              {t("form.overlap")}
            </span>
            <span id="overlap-help" className="block text-muted">
              {t(kind === "schedule" ? "form.overlapScheduleHelp" : "form.overlapWebhookHelp")}
            </span>
          </span>
          <Switch
            checked={overlapSkip}
            onCheckedChange={setOverlapSkip}
            aria-labelledby="overlap-label"
            aria-describedby="overlap-help"
          />
        </div>
      </div>
    </Dialog>
  );
}

/** A webhook's signing secret, shown once with its address. */
export function SecretDialog({
  open,
  onOpenChange,
  secret,
  url,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: string;
  url: string;
}) {
  const { t } = useTranslation(["automations", "common"]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dismissible={false}
      title={t("secret.title")}
      description={t("secret.description")}
      footer={
        <Button onClick={() => onOpenChange(false)} data-autofocus>
          {t("secret.done")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Alert tone="warning" title={t("secret.once")} />
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">{t("secret.secret")}</p>
          <div className="flex items-center gap-2 rounded-field border border-line bg-surface-2 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{secret}</code>
            <CopyButton value={secret} label={t("secret.copySecret")} />
          </div>
        </div>
        {url ? (
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink">{t("secret.url")}</p>
            <div className="flex items-center gap-2 rounded-field border border-line bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{url}</code>
              <CopyButton value={url} label={t("secret.copyUrl")} />
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
