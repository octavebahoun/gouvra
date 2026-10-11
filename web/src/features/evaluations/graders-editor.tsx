import { FlaskConical, Plus, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { parseJson, prettyJson } from "@/lib/json";
import { listItem } from "@/components/motion/presets";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Checkbox, Select } from "@/components/ui/controls";
import { Field, Input, Textarea } from "@/components/ui/field";
import { modelChoices, useProviderKinds, useProviders } from "@/features/providers/api";
import { usePreviewGrader, type GraderSpec, type GraderType } from "./api";
import { defaultGrader, GRADER_TYPES } from "./graders";

type GradersEditorProps = {
  workspaceId: string;
  value: GraderSpec[];
  onChange: (next: GraderSpec[]) => void;
  /** The case's expected answer, to try exact graders against. */
  expected?: string;
};

/** Edit a list of graders; deterministic ones can be tried on a sample output at once. */
export function GradersEditor({ workspaceId, value, onChange, expected }: GradersEditorProps) {
  const { t } = useTranslation("evaluations");
  const providers = useProviders(workspaceId);
  const [adding, setAdding] = useState<GraderType>("exact");
  const firstProvider = providers.data?.[0];

  const update = (index: number, next: GraderSpec) =>
    onChange(value.map((grader, i) => (i === index ? next : grader)));

  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {value.map((grader, index) => (
          <motion.div
            key={index}
            variants={listItem}
            initial="hidden"
            animate="visible"
            exit={{ opacity: 0, height: 0 }}
            className="rounded-card border border-line bg-surface-2/40 p-4"
          >
            <div className="flex items-start gap-3">
              <div className="grid flex-1 gap-4 sm:grid-cols-[14rem_6rem]">
                <Field label={t("graders.type")}>
                  <Select
                    value={grader.type}
                    onValueChange={(type) =>
                      update(
                        index,
                        defaultGrader(
                          type as GraderType,
                          firstProvider?.id ?? "",
                          firstProvider?.default_model ?? "",
                        ),
                      )
                    }
                    options={GRADER_TYPES.map((type) => ({
                      value: type,
                      label: t(`graders.types.${type}`),
                    }))}
                  />
                </Field>
                <Field label={t("graders.weight")}>
                  <Input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={grader.weight ?? 1}
                    onChange={(event) =>
                      update(index, { ...grader, weight: Number(event.target.value) || 1 })
                    }
                  />
                </Field>
              </div>
              <IconButton
                size="icon-sm"
                variant="danger-ghost"
                label={t("graders.remove", { n: index + 1 })}
                icon={<Trash2 aria-hidden />}
                onClick={() => onChange(value.filter((_, i) => i !== index))}
                className="mt-6"
              />
            </div>
            <p className="mt-2 text-[13px] text-muted">{t(`graders.typeHelp.${grader.type}`)}</p>
            <div className="mt-3">
              <GraderFields
                grader={grader}
                onChange={(next) => update(index, next)}
                workspaceId={workspaceId}
              />
            </div>
            {grader.type !== "llm_judge" ? <TryGrader grader={grader} expected={expected} /> : null}
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={t("graders.type")}
          value={adding}
          onValueChange={(type) => setAdding(type as GraderType)}
          options={GRADER_TYPES.map((type) => ({ value: type, label: t(`graders.types.${type}`) }))}
          className="w-52"
        />
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Plus aria-hidden />}
          onClick={() =>
            onChange([
              ...value,
              defaultGrader(adding, firstProvider?.id ?? "", firstProvider?.default_model ?? ""),
            ])
          }
        >
          {t("graders.add")}
        </Button>
      </div>
    </div>
  );
}

function GraderFields({
  grader,
  onChange,
  workspaceId,
}: {
  grader: GraderSpec;
  onChange: (next: GraderSpec) => void;
  workspaceId: string;
}) {
  const { t } = useTranslation("evaluations");
  const providers = useProviders(workspaceId);
  const kinds = useProviderKinds();
  const [schemaText, setSchemaText] = useState(() =>
    grader.type === "json_schema" ? prettyJson(grader.schema) : "",
  );
  const [schemaError, setSchemaError] = useState<string | null>(null);

  switch (grader.type) {
    case "contains":
      return (
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label={t("graders.values")} description={t("graders.valuesHelp")}>
            <Textarea
              rows={3}
              value={grader.values.join("\n")}
              onChange={(event) => onChange({ ...grader, values: event.target.value.split("\n") })}
            />
          </Field>
          <div className="flex flex-col gap-4">
            <Field label={t("graders.mode")}>
              <Select
                value={grader.mode ?? "all"}
                onValueChange={(mode) =>
                  onChange({ ...grader, mode: mode as "all" | "any" | "none" })
                }
                options={(["all", "any", "none"] as const).map((mode) => ({
                  value: mode,
                  label: t(`graders.modes.${mode}`),
                }))}
              />
            </Field>
            <label className="inline-flex items-center gap-2 text-[13px] text-ink">
              <Checkbox
                checked={grader.case_sensitive ?? false}
                onCheckedChange={(checked) =>
                  onChange({ ...grader, case_sensitive: checked === true })
                }
              />
              {t("graders.caseSensitive")}
            </label>
          </div>
        </div>
      );
    case "regex":
      return (
        <div className="flex flex-col gap-3">
          <Field label={t("graders.pattern")}>
            <Input
              className="font-mono"
              spellCheck={false}
              maxLength={500}
              value={grader.pattern}
              onChange={(event) => onChange({ ...grader, pattern: event.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-5 text-[13px] text-ink">
            <label className="inline-flex items-center gap-2">
              <Checkbox
                checked={grader.ignore_case ?? false}
                onCheckedChange={(checked) =>
                  onChange({ ...grader, ignore_case: checked === true })
                }
              />
              {t("graders.ignoreCase")}
            </label>
            <label className="inline-flex items-center gap-2">
              <Checkbox
                checked={grader.should_match ?? true}
                onCheckedChange={(checked) =>
                  onChange({ ...grader, should_match: checked === true })
                }
              />
              {t("graders.shouldMatch")}
            </label>
          </div>
        </div>
      );
    case "json_schema":
      return (
        <Field label={t("graders.schema")} error={schemaError}>
          <CodeEditor
            value={schemaText}
            minHeight="96px"
            onChange={(text) => {
              setSchemaText(text);
              const parsed = parseJson(text);
              if (parsed.ok && typeof parsed.value === "object" && parsed.value !== null) {
                setSchemaError(null);
                onChange({ ...grader, schema: parsed.value as Record<string, unknown> });
              } else {
                setSchemaError(parsed.ok ? null : parsed.message);
              }
            }}
          />
        </Field>
      );
    case "llm_judge": {
      const provider = providers.data?.find((p) => p.id === grader.provider_id);
      const kind = kinds.data?.find((k) => k.kind === provider?.kind);
      const models = modelChoices(kind, provider);
      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("graders.provider")}>
              <Select
                value={grader.provider_id || undefined}
                onValueChange={(id) => {
                  const next = providers.data?.find((p) => p.id === id);
                  onChange({
                    ...grader,
                    provider_id: id,
                    model: next?.default_model ?? grader.model,
                  });
                }}
                options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
            <Field label={t("graders.model")}>
              {models.length > 0 ? (
                <Select
                  value={grader.model || undefined}
                  onValueChange={(model) => onChange({ ...grader, model })}
                  options={models.map((m) => ({
                    value: m.id,
                    label: m.info?.display_name ?? m.id,
                  }))}
                />
              ) : (
                <Input
                  className="font-mono"
                  value={grader.model}
                  onChange={(event) => onChange({ ...grader, model: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("graders.judgeThreshold")}>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={grader.pass_threshold ?? 0.7}
                onChange={(event) =>
                  onChange({ ...grader, pass_threshold: Number(event.target.value) })
                }
              />
            </Field>
          </div>
          <Field label={t("graders.rubric")}>
            <Textarea
              rows={3}
              maxLength={8000}
              placeholder={t("graders.rubricPlaceholder")}
              value={grader.rubric}
              onChange={(event) => onChange({ ...grader, rubric: event.target.value })}
            />
          </Field>
        </div>
      );
    }
    default:
      return (
        <label className="inline-flex items-center gap-2 text-[13px] text-ink">
          <Checkbox
            checked={grader.case_sensitive ?? false}
            onCheckedChange={(checked) => onChange({ ...grader, case_sensitive: checked === true })}
          />
          {t("graders.caseSensitive")}
        </label>
      );
  }
}

function TryGrader({ grader, expected }: { grader: GraderSpec; expected?: string }) {
  const { t } = useTranslation("evaluations");
  const preview = usePreviewGrader();
  const [sample, setSample] = useState("");
  const result = preview.data as { passed?: boolean; score?: number; details?: string } | undefined;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-end">
      <Field label={t("graders.trySample")} className="flex-1">
        <Input value={sample} onChange={(event) => setSample(event.target.value)} />
      </Field>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<FlaskConical aria-hidden />}
        loading={preview.isPending}
        onClick={() =>
          preview.mutate({ grader, output: sample, expected: expected?.trim() ? expected : null })
        }
      >
        {t("graders.try")}
      </Button>
      <span aria-live="polite" className="min-w-40 sm:pb-2">
        {result ? (
          <Badge tone={result.passed ? "success" : "danger"} title={result.details}>
            {t("graders.tryResult", {
              verdict: result.passed ? t("graders.pass") : t("graders.fail"),
              score: (result.score ?? 0).toFixed(2),
            })}
          </Badge>
        ) : null}
      </span>
    </div>
  );
}
