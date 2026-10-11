import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { parseJson, prettyJson } from "@/lib/json";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Checkbox, Select } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { useAgentOptions, useAgentVersions } from "@/features/agents/api";
import { modelChoices, useProviderKinds, useProviders } from "@/features/providers/api";
import {
  useImportCases,
  useSaveCase,
  useStartRun,
  type Case,
  type GraderSpec,
  type Suite,
} from "./api";
import { GradersEditor } from "./graders-editor";
import { graderProblem } from "./graders";

function inputText(value: Record<string, unknown> | null | undefined): string {
  if (!value) return "";
  if (typeof value.text === "string") return value.text;
  if ("json" in value) return prettyJson(value.json);
  return prettyJson(value);
}

/** Text when it isn't a JSON object or array; the parsed value when it is. */
function textOrJson(text: string): string | Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = parseJson(trimmed);
    if (
      parsed.ok &&
      typeof parsed.value === "object" &&
      parsed.value !== null &&
      !Array.isArray(parsed.value)
    ) {
      return parsed.value as Record<string, unknown>;
    }
  }
  return text;
}

export function CaseDialog({
  open,
  onOpenChange,
  workspaceId,
  suiteId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  suiteId: string;
  existing: Case | null;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const save = useSaveCase(workspaceId, suiteId);
  const [name, setName] = useState(existing?.name ?? "");
  const [input, setInput] = useState(inputText(existing?.input));
  const [expected, setExpected] = useState(inputText(existing?.expected));
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
  const [own, setOwn] = useState(Boolean(existing?.graders?.length));
  const [graders, setGraders] = useState<GraderSpec[]>(
    (existing?.graders as GraderSpec[] | null) ?? [],
  );
  const [errors, setErrors] = useState<{ name?: string; input?: string; graders?: string }>({});
  const [problem, setProblem] = useState<unknown>(null);

  const submit = () => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = t("caseForm.nameRequired");
    if (!input.trim()) next.input = t("caseForm.inputRequired");
    if (own && graderProblem(graders)) next.graders = t("caseForm.gradersHelp");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setProblem(null);
    save.mutate(
      {
        id: existing?.id ?? null,
        body: {
          name: name.trim(),
          input: textOrJson(input),
          expected: expected.trim() ? textOrJson(expected) : null,
          graders: own ? graders : null,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      },
      {
        onSuccess: (saved) => {
          toast.success(t("caseForm.saved", { name: saved.name }));
          onOpenChange(false);
        },
        onError: (error) => {
          if (isApiError(error) && error.fieldErrors.some((f) => f.field.startsWith("graders"))) {
            setErrors({ graders: error.fieldErrors[0]?.message });
            return;
          }
          setProblem(error);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={
        existing ? t("caseForm.editTitle", { name: existing.name }) : t("caseForm.createTitle")
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button loading={save.isPending} onClick={submit}>
            {t("caseForm.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {problem ? <FormProblemAlert error={problem} /> : null}
        <div className="grid gap-5 sm:grid-cols-[1fr_16rem]">
          <Field label={t("caseForm.name")} error={errors.name} required>
            <Input
              maxLength={200}
              placeholder={t("caseForm.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t("caseForm.tags")} description={t("caseForm.tagsHelp")}>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <Field
          label={t("caseForm.input")}
          description={t("caseForm.inputHelp")}
          error={errors.input}
          required
        >
          <Textarea
            rows={4}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono text-[13px]"
          />
        </Field>
        <Field label={t("caseForm.expected")} description={t("caseForm.expectedHelp")}>
          <Textarea
            rows={2}
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            className="font-mono text-[13px]"
          />
        </Field>
        <fieldset className="flex flex-col gap-3">
          <legend className="text-[13px] font-medium text-ink">{t("caseForm.graders")}</legend>
          <label className="inline-flex items-center gap-2 text-[13px] text-ink">
            <Checkbox checked={!own} onCheckedChange={(checked) => setOwn(checked !== true)} />
            {t("caseForm.useDefaults")}
          </label>
          {errors.graders ? <Alert tone="danger" title={errors.graders} /> : null}
          {own ? (
            <GradersEditor
              workspaceId={workspaceId}
              value={graders}
              onChange={setGraders}
              expected={expected}
            />
          ) : null}
        </fieldset>
      </div>
    </Dialog>
  );
}

export function ImportDialog({
  open,
  onOpenChange,
  workspaceId,
  suiteId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  suiteId: string;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const importCases = useImportCases(workspaceId, suiteId);
  const [text, setText] = useState(
    '[\n  { "name": "Greeting", "input": "Hello!", "expected": "Hi! How can I help?" }\n]',
  );
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const parsed = parseJson(text);
    const valid =
      parsed.ok &&
      Array.isArray(parsed.value) &&
      parsed.value.every(
        (item: unknown) =>
          typeof item === "object" && item !== null && "name" in item && "input" in item,
      );
    if (!parsed.ok || !valid) {
      setError(t("import.invalid"));
      return;
    }
    setError(null);
    importCases.mutate(
      { cases: parsed.value as never, replace },
      {
        onSuccess: (cases) => {
          toast.success(t("import.done", { count: cases.length }));
          onOpenChange(false);
        },
        onError: (problem) =>
          setError(
            isApiError(problem)
              ? (problem.fieldErrors[0]?.message ?? problem.message)
              : t("import.invalid"),
          ),
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("import.title")}
      description={t("import.description")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button loading={importCases.isPending} onClick={submit}>
            {t("import.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <Field label={t("import.title")} hideLabel error={error}>
          <CodeEditor value={text} onChange={setText} minHeight="200px" />
        </Field>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink">
          <Checkbox checked={replace} onCheckedChange={(checked) => setReplace(checked === true)} />
          {t("import.replace")}
        </label>
      </div>
    </Dialog>
  );
}

export function RunDialog({
  open,
  onOpenChange,
  workspaceId,
  basePath,
  suite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  basePath: string;
  suite: Suite;
}) {
  const { t } = useTranslation(["evaluations", "common"]);
  const navigate = useNavigate();
  const agents = useAgentOptions(workspaceId);
  const providers = useProviders(workspaceId);
  const kinds = useProviderKinds();
  const start = useStartRun(workspaceId);
  const [agentId, setAgentId] = useState(suite.agent_id ?? "");
  const versions = useAgentVersions(agentId, Boolean(agentId));
  const [version, setVersion] = useState("current");
  const [providerId, setProviderId] = useState("same");
  const [model, setModel] = useState("same");
  const [instructions, setInstructions] = useState("");
  const [label, setLabel] = useState("");
  const [problem, setProblem] = useState<unknown>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const agent = agents.data?.find((a) => a.id === agentId);

  const provider = providers.data?.find(
    (p) => p.id === (providerId === "same" ? agent?.version?.provider_id : providerId),
  );
  const models = useMemo(
    () =>
      modelChoices(
        kinds.data?.find((k) => k.kind === provider?.kind),
        provider,
      ),
    [kinds.data, provider],
  );

  const submit = () => {
    if (!agentId) {
      setAgentError(t("runForm.agentRequired"));
      return;
    }
    setAgentError(null);
    setProblem(null);
    start.mutate(
      {
        suite_id: suite.id,
        agent_id: agentId,
        agent_version: version === "current" ? null : Number(version),
        provider_id: providerId === "same" ? null : providerId,
        model: model === "same" ? null : model,
        instructions: instructions.trim() ? instructions : null,
        label: label.trim() || null,
      },
      {
        onSuccess: (run) => {
          toast.success(t("runForm.started"));
          onOpenChange(false);
          void navigate(`${basePath}/evaluations/runs/${run.id}`);
        },
        onError: (error) => {
          if (hasErrorCode(error, "suite_empty")) setProblem(new Error(t("runForm.noCases")));
          else setProblem(error);
        },
      },
    );
  };

  const current = agent?.version?.number;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("runForm.title", { suite: suite.name })}
      description={t("runForm.description")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button loading={start.isPending} onClick={submit}>
            {t("runForm.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {problem ? (
          problem instanceof Error && !isApiError(problem) ? (
            <Alert tone="danger" title={problem.message} />
          ) : (
            <FormProblemAlert error={problem} />
          )
        ) : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t("runForm.agent")} error={agentError} required>
            <Select
              value={agentId || undefined}
              onValueChange={(id) => {
                setAgentId(id);
                setVersion("current");
              }}
              options={(agents.data ?? [])
                .filter((a) => a.status === "active")
                .map((a) => ({ value: a.id, label: a.name }))}
            />
          </Field>
          <Field label={t("runForm.version")}>
            <Select
              value={version}
              onValueChange={setVersion}
              disabled={!agentId}
              options={[
                {
                  value: "current",
                  label: t("runForm.currentVersion", { number: current ?? "—" }),
                },
                ...(versions.data ?? [])
                  .filter((v) => !v.is_current)
                  .map((v) => ({
                    value: String(v.number),
                    label: t("runForm.versionOption", { number: v.number }),
                    description: v.change_note ?? undefined,
                  })),
              ]}
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-4 rounded-card border border-dashed border-line p-4">
          <legend className="px-1 text-[13px] font-medium text-ink">{t("runForm.variant")}</legend>
          <p className="-mt-2 text-[13px] text-muted">{t("runForm.variantHelp")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("runForm.provider")}>
              <Select
                value={providerId}
                onValueChange={(id) => {
                  setProviderId(id);
                  setModel("same");
                }}
                options={[
                  { value: "same", label: t("runForm.sameProvider") },
                  ...(providers.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </Field>
            <Field label={t("runForm.model")}>
              <Select
                value={model}
                onValueChange={setModel}
                options={[
                  { value: "same", label: t("runForm.sameModel") },
                  ...models.map((m) => ({ value: m.id, label: m.info?.display_name ?? m.id })),
                ]}
              />
            </Field>
          </div>
          <Field label={t("runForm.instructions")}>
            <Textarea
              rows={3}
              placeholder={t("runForm.instructionsPlaceholder")}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              className="font-mono text-[13px]"
            />
          </Field>
        </fieldset>
        <Field label={t("runForm.label")}>
          <Input
            maxLength={120}
            placeholder={t("runForm.labelPlaceholder")}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}
