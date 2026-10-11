import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { parseJson, prettyJson } from "@/lib/json";
import { Checkbox, Select, Switch } from "@/components/ui/controls";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, PasswordInput, Textarea } from "@/components/ui/field";
import { applyFieldErrors } from "@/features/auth/errors";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import { toIdentifier } from "./identifier";
import {
  needsConfig,
  useCreateTool,
  useUpdateTool,
  type BuiltinTool,
  type Tool,
  type ToolKind,
} from "./api";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

const DEFAULT_SCHEMA = {
  http: {
    type: "object",
    properties: {
      order_id: { type: "string", description: "Identifier of the order to look up" },
    },
    required: ["order_id"],
  },
  code: {
    type: "object",
    properties: { text: { type: "string", description: "Text to analyse" } },
    required: ["text"],
  },
};

const DEFAULT_SOURCE = {
  python: 'def main(args):\n    words = args["text"].split()\n    return {"words": len(words)}\n',
  javascript:
    "function main(args) {\n  const words = args.text.split(/\\s+/).filter(Boolean);\n  return { words: words.length };\n}\n",
};

type Values = {
  display_name: string;
  name: string;
  description: string;
  input_schema: string;
  method: Method;
  url: string;
  auth_type: "none" | "bearer" | "header";
  header_name: string;
  secret: string;
  headers: string;
  max_response_kb: number;
  language: "python" | "javascript";
  source: string;
  network: boolean;
  memory_mb: number;
  allowed_hosts: string;
  allowed_methods: Method[];
  timeout_ms: number;
};

function initialValues(kind: ToolKind, tool: Tool | null): Values {
  const config = (tool?.config ?? {}) as Record<string, unknown>;
  const auth = (config.auth ?? {}) as { type?: Values["auth_type"]; header_name?: string };
  return {
    display_name: tool?.display_name ?? "",
    name: tool?.name ?? "",
    description: tool?.description ?? "",
    input_schema: prettyJson(
      tool?.input_schema ?? (kind === "code" ? DEFAULT_SCHEMA.code : DEFAULT_SCHEMA.http),
    ),
    method: (config.method as Method | undefined) ?? "GET",
    url: (config.url as string | undefined) ?? "",
    auth_type: auth.type ?? "none",
    header_name: auth.header_name ?? "",
    secret: "",
    headers: prettyJson(config.headers ?? {}),
    max_response_kb: Math.round(
      ((config.max_response_bytes as number | undefined) ?? 65_536) / 1024,
    ),
    language: (config.language as Values["language"] | undefined) ?? "python",
    source: (config.source as string | undefined) ?? DEFAULT_SOURCE.python,
    network: Boolean(config.network),
    memory_mb: (config.memory_mb as number | undefined) ?? 256,
    allowed_hosts: ((config.allowed_hosts as string[] | undefined) ?? []).join("\n"),
    allowed_methods: (config.allowed_methods as Method[] | undefined) ?? ["GET"],
    timeout_ms: tool?.timeout_ms ?? 15_000,
  };
}

type ToolFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  kind: ToolKind;
  /** Edit this tool; create a new one when null. */
  tool: Tool | null;
  /** Built-in being added or configured (its config schema decides the fields). */
  builtin?: BuiltinTool | null;
  onSaved?: (tool: Tool) => void;
};

/**
 * Create or edit an HTTP / code tool, or configure a built-in one (e.g. allowed hosts).
 * Parents give it a new `key` per opening so each opening starts from a clean form.
 */
export function ToolFormDialog({
  open,
  onOpenChange,
  workspaceId,
  kind,
  tool,
  builtin = null,
  onSaved,
}: ToolFormDialogProps) {
  const { t } = useTranslation(["tools", "common"]);
  const create = useCreateTool(workspaceId);
  const update = useUpdateTool(workspaceId);
  const [problem, setProblem] = useState<unknown>(null);
  const [nameTouched, setNameTouched] = useState(Boolean(tool));
  const custom = kind !== "builtin";
  const configurable = kind === "builtin" && needsConfig(builtin);

  const schema = useMemo(
    () =>
      z
        .object({
          display_name: z.string().trim().max(80),
          name: z.string().trim(),
          description: z.string().trim().max(1024),
          input_schema: z.string(),
          method: z.enum(METHODS),
          url: z.string().trim(),
          auth_type: z.enum(["none", "bearer", "header"]),
          header_name: z.string().trim(),
          secret: z.string(),
          headers: z.string(),
          max_response_kb: z.coerce.number().int().min(1).max(1024),
          language: z.enum(["python", "javascript"]),
          source: z.string(),
          network: z.boolean(),
          memory_mb: z.coerce.number().int().min(64).max(1024),
          allowed_hosts: z.string(),
          allowed_methods: z.array(z.enum(METHODS)),
          timeout_ms: z.coerce.number().int().min(1000).max(120_000),
        })
        .superRefine((v, ctx) => {
          const issue = (path: keyof Values, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message });
          if (custom) {
            if (!v.display_name) issue("display_name", t("form.displayNameRequired"));
            if (!/^[a-z][a-z0-9_]{1,63}$/.test(v.name)) issue("name", t("form.namePattern"));
            if (!v.description) issue("description", t("form.descriptionRequired"));
            const parsed = parseJson(v.input_schema);
            if (!parsed.ok)
              issue("input_schema", t("form.schemaInvalid", { message: parsed.message }));
            else if (
              typeof parsed.value !== "object" ||
              parsed.value === null ||
              (parsed.value as { type?: unknown }).type !== "object"
            ) {
              issue("input_schema", t("form.schemaObject"));
            }
          }
          if (kind === "http") {
            if (!/^https?:\/\/[^\s/]+/i.test(v.url)) issue("url", t("form.urlInvalid"));
            const headers = parseJson(v.headers || "{}");
            if (!headers.ok)
              issue("headers", t("form.schemaInvalid", { message: headers.message }));
            if (v.auth_type !== "none" && !v.secret && !tool?.secret_set) {
              issue("secret", t("form.secretRequired"));
            }
          }
          if (kind === "code" && !v.source.trim()) issue("source", t("form.sourceHelp"));
          if (configurable && !v.allowed_hosts.trim()) {
            issue("allowed_hosts", t("form.allowedHostsHelp"));
          }
        }),
    [custom, kind, configurable, tool, t],
  );

  const form = useForm<Values>({
    resolver: zodResolver(schema) as never,
    defaultValues: initialValues(kind, tool),
  });
  const { errors, isSubmitting } = form.formState;

  const authType = useWatch({ control: form.control, name: "auth_type" });
  const language = useWatch({ control: form.control, name: "language" });

  const buildConfig = (v: Values): Record<string, unknown> => {
    if (kind === "http") {
      const parsed = parseJson(v.headers || "{}");
      return {
        method: v.method,
        url: v.url,
        headers: parsed.ok ? parsed.value : {},
        auth: {
          type: v.auth_type,
          ...(v.auth_type === "header" ? { header_name: v.header_name } : {}),
        },
        max_response_bytes: v.max_response_kb * 1024,
      };
    }
    if (kind === "code") {
      return { language: v.language, source: v.source, network: v.network, memory_mb: v.memory_mb };
    }
    if (configurable) {
      return {
        allowed_hosts: v.allowed_hosts
          .split(/[\n,]/)
          .map((h) => h.trim())
          .filter(Boolean),
        allowed_methods: v.allowed_methods.length ? v.allowed_methods : ["GET"],
      };
    }
    return {};
  };

  const onSubmit = form.handleSubmit(async (v) => {
    setProblem(null);
    try {
      const config = buildConfig(v);
      const schemaValue = custom
        ? (JSON.parse(v.input_schema) as Record<string, unknown>)
        : undefined;
      let saved: Tool;
      if (tool) {
        saved = await update.mutateAsync({
          id: tool.id,
          body: {
            ...(custom
              ? {
                  display_name: v.display_name,
                  name: v.name,
                  description: v.description,
                  input_schema: schemaValue,
                }
              : {}),
            config,
            timeout_ms: v.timeout_ms,
            ...(v.secret ? { secret: v.secret } : {}),
          },
        });
      } else {
        saved = await create.mutateAsync({
          kind,
          ...(kind === "builtin" ? { builtin_key: builtin?.key ?? null } : {}),
          ...(custom
            ? {
                display_name: v.display_name,
                name: v.name,
                description: v.description,
                input_schema: schemaValue,
              }
            : {}),
          config,
          timeout_ms: v.timeout_ms,
          ...(v.secret ? { secret: v.secret } : {}),
        });
      }
      toast.success(t("form.saved", { name: saved.display_name }));
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      const placed = applyFieldErrors(error, form.setError, (fieldError) => {
        const field = fieldError.field.split(".")[0] ?? "";
        if (field === "name") {
          return {
            field: "name",
            message: fieldError.code === "taken" ? t("form.nameTaken") : t("form.namePattern"),
          };
        }
        if (field === "input_schema") return { field: "input_schema", message: fieldError.message };
        if (field === "config") {
          return { field: kind === "code" ? "source" : "url", message: fieldError.message };
        }
        if (field === "secret") return { field: "secret", message: fieldError.message };
        return null;
      });
      if (!placed) setProblem(error);
    }
  });

  const title = tool
    ? t("form.editTitle", { name: tool.display_name })
    : kind === "builtin"
      ? t("create.configure", { name: builtin?.display_name ?? "" })
      : t("form.createTitle", { kind: t(`kinds.${kind}`) });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={title}
      description={t(`kindDescriptions.${kind}`)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" form="tool-form" loading={isSubmitting}>
            {tool ? t("form.submitEdit") : t("form.submitCreate")}
          </Button>
        </>
      }
    >
      <form
        id="tool-form"
        noValidate
        onSubmit={(event) => void onSubmit(event)}
        className="flex flex-col gap-5"
      >
        {problem ? <FormProblemAlert error={problem} /> : null}

        {custom ? (
          <>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label={t("form.displayName")} error={errors.display_name?.message} required>
                <Input
                  maxLength={80}
                  placeholder={t("form.displayNamePlaceholder")}
                  {...form.register("display_name", {
                    onChange: (event: { target: { value: string } }) => {
                      if (!nameTouched) {
                        form.setValue("name", toIdentifier(event.target.value));
                      }
                    },
                  })}
                />
              </Field>
              <Field
                label={t("form.name")}
                description={t("form.nameHelp")}
                error={errors.name?.message}
                required
              >
                <Input
                  className="font-mono"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={64}
                  {...form.register("name", {
                    onChange: () => {
                      setNameTouched(true);
                    },
                  })}
                />
              </Field>
            </div>
            <Field
              label={t("form.description")}
              description={t("form.descriptionHelp")}
              error={errors.description?.message}
              required
            >
              <Textarea rows={3} maxLength={1024} {...form.register("description")} />
            </Field>
          </>
        ) : null}

        {kind === "http" ? (
          <>
            <div className="grid gap-5 md:grid-cols-[10rem_1fr]">
              <Field label={t("form.method")}>
                <Controller
                  control={form.control}
                  name="method"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value)}
                      options={METHODS.map((m) => ({ value: m, label: m }))}
                    />
                  )}
                />
              </Field>
              <Field
                label={t("form.url")}
                description={t("form.urlHelp")}
                error={errors.url?.message}
                required
              >
                <Input
                  className="font-mono"
                  inputMode="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="https://api.example.com/orders/{order_id}"
                  {...form.register("url")}
                />
              </Field>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label={t("form.auth")}>
                <Controller
                  control={form.control}
                  name="auth_type"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(value) => field.onChange(value)}
                      options={[
                        { value: "none", label: t("form.authNone") },
                        { value: "bearer", label: t("form.authBearer") },
                        { value: "header", label: t("form.authHeader") },
                      ]}
                    />
                  )}
                />
              </Field>
              {authType === "header" ? (
                <Field label={t("form.headerName")} error={errors.header_name?.message}>
                  <Input
                    className="font-mono"
                    placeholder="X-Api-Key"
                    {...form.register("header_name")}
                  />
                </Field>
              ) : null}
            </div>
            {authType !== "none" ? (
              <Field
                label={t("form.secret")}
                description={
                  tool?.secret_set && tool.secret_hint
                    ? t("form.secretKeep", { hint: tool.secret_hint })
                    : t("form.secretHelp")
                }
                error={errors.secret?.message}
                required={!tool?.secret_set}
              >
                <PasswordInput autoComplete="off" spellCheck={false} {...form.register("secret")} />
              </Field>
            ) : null}
            <Field
              label={t("form.headers")}
              description={t("form.headersHelp")}
              error={errors.headers?.message}
            >
              <Controller
                control={form.control}
                name="headers"
                render={({ field }) => (
                  <CodeEditor
                    value={field.value}
                    onChange={field.onChange}
                    minHeight="64px"
                    maxHeight="160px"
                  />
                )}
              />
            </Field>
          </>
        ) : null}

        {kind === "code" ? (
          <>
            <div className="grid gap-5 md:grid-cols-3">
              <Field label={t("form.language")}>
                <Controller
                  control={form.control}
                  name="language"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        const next = value as Values["language"];
                        if (form.getValues("source") === DEFAULT_SOURCE[field.value]) {
                          form.setValue("source", DEFAULT_SOURCE[next]);
                        }
                        field.onChange(next);
                      }}
                      options={[
                        { value: "python", label: "Python" },
                        { value: "javascript", label: "JavaScript" },
                      ]}
                    />
                  )}
                />
              </Field>
              <Field label={t("form.memory")} error={errors.memory_mb?.message}>
                <Input
                  type="number"
                  min={64}
                  max={1024}
                  step={64}
                  {...form.register("memory_mb")}
                />
              </Field>
              <Field label={t("form.network")} description={t("form.networkHelp")}>
                <Controller
                  control={form.control}
                  name="network"
                  render={({ field }) => (
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  )}
                />
              </Field>
            </div>
            <Field
              label={t("form.source")}
              description={t("form.sourceHelp")}
              error={errors.source?.message}
            >
              <Controller
                control={form.control}
                name="source"
                render={({ field }) => (
                  <CodeEditor
                    value={field.value}
                    onChange={field.onChange}
                    language="text"
                    minHeight="180px"
                    aria-label={`${t("form.source")} (${language})`}
                  />
                )}
              />
            </Field>
          </>
        ) : null}

        {custom ? (
          <Field
            label={t("form.inputSchema")}
            description={t("form.inputSchemaHelp")}
            error={errors.input_schema?.message}
            required
          >
            <Controller
              control={form.control}
              name="input_schema"
              render={({ field }) => (
                <CodeEditor value={field.value} onChange={field.onChange} minHeight="160px" />
              )}
            />
          </Field>
        ) : null}

        {configurable ? (
          <>
            <Field
              label={t("form.allowedHosts")}
              description={t("form.allowedHostsHelp")}
              error={errors.allowed_hosts?.message}
              required
            >
              <Textarea
                rows={3}
                className="font-mono"
                spellCheck={false}
                placeholder="api.github.com"
                {...form.register("allowed_hosts")}
              />
            </Field>
            <fieldset>
              <legend className="text-[13px] font-medium text-ink">
                {t("form.allowedMethods")}
              </legend>
              <Controller
                control={form.control}
                name="allowed_methods"
                render={({ field }) => (
                  <div className="mt-2 flex flex-wrap gap-4">
                    {METHODS.map((method) => (
                      <label
                        key={method}
                        className="inline-flex items-center gap-2 font-mono text-[13px]"
                      >
                        <Checkbox
                          checked={field.value.includes(method)}
                          onCheckedChange={(checked) =>
                            field.onChange(
                              checked
                                ? [...field.value, method]
                                : field.value.filter((m) => m !== method),
                            )
                          }
                        />
                        {method}
                      </label>
                    ))}
                  </div>
                )}
              />
            </fieldset>
          </>
        ) : null}

        <Field label={t("form.timeoutMs")} error={errors.timeout_ms?.message} className="max-w-48">
          <Input
            type="number"
            min={1000}
            max={120000}
            step={1000}
            {...form.register("timeout_ms")}
          />
        </Field>
      </form>
    </Dialog>
  );
}
