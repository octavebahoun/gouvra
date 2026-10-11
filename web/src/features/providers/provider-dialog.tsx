import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLink } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/feedback";
import { Field, Input, PasswordInput } from "@/components/ui/field";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import {
  modelChoices,
  useCreateProvider,
  useProviderKinds,
  useTestProvider,
  useUpdateProvider,
  type ModelInfo,
  type Provider,
  type ProviderKind,
  type ProviderKindId,
} from "./api";
import { ProviderMark } from "./provider-visual";
import { useDiagnosis } from "@/features/executions/diagnosis";

const KIND_ORDER: ProviderKindId[] = ["deepseek", "anthropic", "openai_compatible", "test"];

type Values = {
  kind: ProviderKindId;
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
};

function useSchema(kinds: ProviderKind[], editing: Provider | null) {
  const { t } = useTranslation("providers");
  return useMemo(
    () =>
      z
        .object({
          kind: z.enum(["deepseek", "anthropic", "openai_compatible", "test"]),
          name: z.string().trim().min(1, t("dialog.nameRequired")).max(80, t("dialog.nameTooLong")),
          base_url: z.string().trim(),
          api_key: z.string().trim(),
          default_model: z.string().trim(),
        })
        .superRefine((values, ctx) => {
          const kind = kinds.find((k) => k.kind === values.kind);
          if (kind?.requires_base_url && !values.base_url) {
            ctx.addIssue({
              code: "custom",
              path: ["base_url"],
              message: t("dialog.baseUrlRequired"),
            });
          }
          if (values.base_url && !/^https?:\/\/[^\s/]+/i.test(values.base_url)) {
            ctx.addIssue({
              code: "custom",
              path: ["base_url"],
              message: t("dialog.baseUrlInvalid"),
            });
          }
          const keyKnown = editing?.secret_set ?? false;
          if (kind?.requires_api_key && !values.api_key && !keyKnown) {
            ctx.addIssue({
              code: "custom",
              path: ["api_key"],
              message: t("dialog.apiKeyRequired"),
            });
          }
        }),
    [kinds, editing, t],
  );
}

type ProviderDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Edit this provider; create a new one when null. */
  provider: Provider | null;
  /** Kind preselected when creating (e.g. "test" from the empty state). */
  initialKind?: ProviderKindId;
};

/**
 * Screen O — add or edit a provider. Creating tests the connection straight away.
 * The parent gives it a new `key` for each opening, so every opening starts from a clean form.
 */
export function ProviderDialog({
  open,
  onOpenChange,
  workspaceId,
  provider,
  initialKind = "deepseek",
}: ProviderDialogProps) {
  const { t } = useTranslation(["providers", "common"]);
  const kinds = useProviderKinds();
  const create = useCreateProvider(workspaceId);
  const update = useUpdateProvider(workspaceId);
  const test = useTestProvider(workspaceId);
  const diagnose = useDiagnosis();
  const compact = new Intl.NumberFormat(undefined, { notation: "compact" });
  const modelDescription = (info: ModelInfo | null): string | undefined => {
    if (!info) return undefined;
    const parts: string[] = [];
    if (info.context_window) {
      parts.push(t("dialog.context", { tokens: compact.format(info.context_window) }));
    }
    if (info.supports_tools) parts.push(t("dialog.tools"));
    if (info.reasoning !== "none") parts.push(t("dialog.reasoning"));
    if (info.pricing) {
      const { standard, currency } = info.pricing;
      parts.push(
        t("dialog.price", {
          input: `${standard.input} ${currency}`,
          output: `${standard.output} ${currency}`,
        }),
      );
    }
    return parts.join(" · ");
  };
  // After a failed test the dialog stays open on the saved provider so the key can be fixed.
  const [saved, setSaved] = useState<Provider | null>(provider);
  const [problem, setProblem] = useState<unknown>(null);
  const [testFailure, setTestFailure] = useState<{ code: string; message: string } | null>(null);
  const editing = saved ?? provider;
  const kindList = useMemo(
    () =>
      [...(kinds.data ?? [])].sort(
        (a, b) =>
          KIND_ORDER.indexOf(a.kind as ProviderKindId) -
          KIND_ORDER.indexOf(b.kind as ProviderKindId),
      ),
    [kinds.data],
  );
  const schema = useSchema(kindList, editing);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: (provider?.kind as ProviderKindId | undefined) ?? initialKind,
      name: provider?.name ?? "",
      base_url: provider?.base_url ?? "",
      api_key: "",
      default_model: provider?.default_model ?? "",
    },
  });
  const { errors, isSubmitting } = form.formState;

  const kindId = useWatch({ control: form.control, name: "kind" });
  const kind = kindList.find((k) => k.kind === kindId);
  const choices = modelChoices(kind, editing ?? undefined);
  const freeModel = kindId === "openai_compatible" && choices.length === 0;

  // A fresh name follows the chosen kind until the user types their own.
  useEffect(() => {
    if (editing || !kind) return;
    const current = form.getValues("name");
    if (!current || kindList.some((k) => k.label === current)) {
      form.setValue("name", kind.label, { shouldValidate: false });
    }
    if (!form.getValues("default_model")) {
      const recommended = kind.models.find((m) => m.recommended) ?? kind.models[0];
      if (recommended) form.setValue("default_model", recommended.id);
    }
  }, [kind, kindList, editing, form]);

  const finish = async (target: Provider, shouldTest: boolean) => {
    if (!shouldTest) {
      toast.success(t("dialog.saved", { name: target.name }));
      onOpenChange(false);
      return;
    }
    const result = await test.mutateAsync(target.id).catch((error: unknown) => {
      setProblem(error);
      return null;
    });
    if (!result) return;
    if (result.ok) {
      toast.success(t("test.ok", { name: target.name }), {
        description: t("test.okDetail", { count: result.models.length, ms: result.latency_ms }),
      });
      onOpenChange(false);
    } else {
      setTestFailure(result.error ?? { code: "provider_invalid_response", message: "" });
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setProblem(null);
    setTestFailure(null);
    try {
      if (!editing) {
        const created = await create.mutateAsync({
          kind: values.kind,
          name: values.name,
          base_url: values.base_url || null,
          api_key: values.api_key || null,
          default_model: values.default_model || null,
        });
        setSaved(created);
        form.setValue("api_key", "");
        await finish(created, true);
        return;
      }
      const body: Record<string, string | null> = {};
      if (values.name !== editing.name) body.name = values.name;
      if ((values.base_url || null) !== editing.base_url) body.base_url = values.base_url || null;
      if (values.api_key) body.api_key = values.api_key;
      if ((values.default_model || null) !== editing.default_model) {
        body.default_model = values.default_model || null;
      }
      const updated = await update.mutateAsync({ id: editing.id, body });
      setSaved(updated);
      form.setValue("api_key", "");
      await finish(updated, "api_key" in body || "base_url" in body || updated.status !== "ok");
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        if (fieldError.field === "name") {
          return {
            field: "name",
            message: fieldError.code === "taken" ? t("dialog.nameTaken") : t("dialog.nameTooLong"),
          };
        }
        if (fieldError.field === "base_url") {
          return { field: "base_url", message: t("dialog.baseUrlInvalid") };
        }
        if (fieldError.field === "api_key") {
          return { field: "api_key", message: fieldError.message };
        }
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  const failure = testFailure ? diagnose(testFailure.code) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? t("dialog.editTitle", { name: editing.name }) : t("dialog.createTitle")}
      description={editing ? t("dialog.editDescription") : t("dialog.createDescription")}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="provider-form" loading={isSubmitting || test.isPending}>
            {editing ? t("dialog.submitEdit") : t("dialog.submitCreate")}
          </Button>
        </>
      }
    >
      <form
        id="provider-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5"
      >
        {problem ? <FormProblemAlert error={problem} /> : null}
        {failure && testFailure ? (
          <Alert tone="danger" title={t("dialog.testFailedTitle")}>
            <p className="font-medium">{failure.title}</p>
            <p>{failure.explanation}</p>
            <p className="mt-1">{failure.action}</p>
            {testFailure.message ? (
              <p className="mt-2 font-mono text-xs opacity-80">{testFailure.message}</p>
            ) : null}
          </Alert>
        ) : null}

        {!editing ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-medium text-ink">
              {t("dialog.kindLegend")}
            </legend>
            <Controller
              control={form.control}
              name="kind"
              render={({ field }) => (
                <RadioGroup.Root
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                  className="grid gap-2 sm:grid-cols-2"
                  aria-label={t("dialog.kindLegend")}
                >
                  {kindList.map((option) => (
                    <RadioGroup.Item
                      key={option.kind}
                      value={option.kind}
                      className={cn(
                        "group flex items-start gap-3 rounded-card border border-line bg-surface p-3 text-left transition-[border-color,box-shadow,background-color]",
                        "hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                        "data-[state=checked]:border-brand data-[state=checked]:bg-brand-soft/40 data-[state=checked]:shadow-glow",
                      )}
                    >
                      <ProviderMark kind={option.kind} className="size-9" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                          {option.label}
                          {option.kind === "test" ? (
                            <Badge tone="success" className="h-5 px-2 text-[11px]">
                              {t("offlineTag")}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                          {t(`kinds.${option.kind as ProviderKindId}`)}
                        </span>
                      </span>
                    </RadioGroup.Item>
                  ))}
                </RadioGroup.Root>
              )}
            />
          </fieldset>
        ) : null}

        <Field label={t("dialog.name")} error={errors.name?.message} required>
          <Input
            maxLength={80}
            placeholder={t("dialog.namePlaceholder")}
            {...form.register("name")}
          />
        </Field>

        {kind?.requires_base_url || kindId === "openai_compatible" ? (
          <Field
            label={t("dialog.baseUrl")}
            description={t("dialog.baseUrlHelp")}
            error={errors.base_url?.message}
            required={kind?.requires_base_url}
            hint={
              kind && kind.presets.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{t("dialog.presets")}</span>
                  {kind.presets.map((preset) => (
                    <Button
                      key={preset.base_url}
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        form.setValue("base_url", preset.base_url, {
                          shouldDirty: true,
                          shouldValidate: true,
                        })
                      }
                    >
                      {preset.label}
                    </Button>
                  ))}
                </span>
              ) : undefined
            }
          >
            <Input
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={kind?.default_base_url ?? "https://api.example.com/v1"}
              className="font-mono"
              {...form.register("base_url")}
            />
          </Field>
        ) : null}

        {kind?.requires_api_key ? (
          <Field
            label={t("dialog.apiKey")}
            description={
              editing?.secret_set && editing.secret_hint
                ? t("dialog.apiKeyKeep", { hint: editing.secret_hint })
                : t("dialog.apiKeyHelp")
            }
            error={errors.api_key?.message}
            required={!editing?.secret_set}
            labelAside={
              kind.docs_url ? (
                <a
                  href={kind.docs_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-[13px] text-brand-text hover:underline"
                >
                  {t("dialog.apiKeyDocs")}
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              ) : undefined
            }
          >
            <PasswordInput autoComplete="off" spellCheck={false} {...form.register("api_key")} />
          </Field>
        ) : null}

        {freeModel ? (
          <Field
            label={t("dialog.customModel")}
            description={t("dialog.customModelHelp")}
            error={errors.default_model?.message}
          >
            <Input
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
              {...form.register("default_model")}
            />
          </Field>
        ) : (
          <Field
            label={t("dialog.defaultModel")}
            description={t("dialog.defaultModelHelp")}
            error={errors.default_model?.message}
          >
            <Controller
              control={form.control}
              name="default_model"
              render={({ field }) => (
                <Select
                  value={field.value || undefined}
                  onValueChange={field.onChange}
                  placeholder={t("dialog.modelPlaceholder")}
                  options={choices.map((choice) => ({
                    value: choice.id,
                    label: (
                      <span className="inline-flex items-center gap-2">
                        {choice.info?.display_name ?? choice.id}
                        {choice.info?.recommended ? (
                          <Badge tone="brand" className="h-5 px-2 text-[11px]">
                            {t("dialog.recommended")}
                          </Badge>
                        ) : null}
                      </span>
                    ),
                    description: modelDescription(choice.info),
                  }))}
                />
              )}
            />
          </Field>
        )}
      </form>
    </Dialog>
  );
}
