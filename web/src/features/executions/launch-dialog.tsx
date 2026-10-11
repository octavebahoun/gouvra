import { Gauge, Hourglass, Play, Repeat, Wrench } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { hasErrorCode, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { useModEnter } from "@/lib/use-shortcut";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { parseJson } from "@/lib/json";
import { Dialog } from "@/components/ui/dialog";
import { Alert, Kbd } from "@/components/ui/feedback";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormProblemAlert } from "@/features/auth/components/form-alerts";
import type { Agent } from "@/features/agents/api";
import { useLaunchExecution } from "./api";

const MAX_INPUT_BYTES = 262_144;

function newKey(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function Limit({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink [&_svg]:size-3.5 [&_svg]:text-muted">
      {icon}
      {children}
    </li>
  );
}

/** Screen K — start an execution with an input; the user lands on its live trace. */
export function LaunchDialog({
  open,
  onOpenChange,
  agent,
  workspaceId,
  basePath,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: Agent;
  workspaceId: string;
  basePath: string;
}) {
  const { t } = useTranslation(["executions", "agents", "common"]);
  const navigate = useNavigate();
  const launch = useLaunchExecution(workspaceId);
  const [mode, setMode] = useState<"text" | "json">("text");
  const [text, setText] = useState("");
  const [json, setJson] = useState('{\n  "question": ""\n}');
  const [timeout, setTimeoutValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const idempotencyKey = useRef(newKey());
  const limits = agent.version?.limits;
  const defaultTimeout = limits?.timeout_s ?? 120;

  const issues = useMemo(
    () =>
      agent.readiness_issues
        .filter((issue) => issue !== "provider_error" && issue !== "tool_unavailable")
        .map((issue) => t(`agents:issues.${issue as "no_version"}`, issue)),
    [agent.readiness_issues, t],
  );

  const submit = () => {
    setProblem(null);
    let input: string | Record<string, unknown>;
    if (mode === "text") {
      if (!text.trim()) {
        setInputError(t("launch.inputRequired"));
        return;
      }
      input = text;
    } else {
      const parsed = parseJson(json);
      if (!parsed.ok) {
        setInputError(t("launch.jsonInvalid", { message: parsed.message }));
        return;
      }
      if (
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        Array.isArray(parsed.value)
      ) {
        setInputError(t("launch.jsonObject"));
        return;
      }
      input = parsed.value as Record<string, unknown>;
    }
    const size = new TextEncoder().encode(
      typeof input === "string" ? input : JSON.stringify(input),
    ).length;
    if (size > MAX_INPUT_BYTES) {
      setInputError(t("launch.inputTooLarge", { max: "256 KB" }));
      return;
    }
    setInputError(null);
    const seconds = timeout.trim() ? Number(timeout) : null;
    launch.mutate(
      {
        agentId: agent.id,
        idempotencyKey: idempotencyKey.current,
        body: { input, timeout_s: seconds && Number.isFinite(seconds) ? seconds : null },
      },
      {
        onSuccess: (execution) => {
          toast.success(t("launch.started"));
          onOpenChange(false);
          setText("");
          void navigate(`${basePath}/executions/${execution.id}`);
        },
        onError: (error) => {
          if (isApiError(error) && error.isRateLimited) {
            setProblem(null);
            setInputError(t("launch.rateLimited", { seconds: error.retryAfterSeconds ?? 30 }));
            return;
          }
          if (
            hasErrorCode(error, "validation_failed") &&
            error.fieldErrors.some((f) => f.field.startsWith("input"))
          ) {
            setInputError(error.fieldErrors[0]?.message ?? t("launch.inputRequired"));
            return;
          }
          setProblem(error);
        },
      },
    );
  };

  useModEnter(open, submit);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t("launch.title", { agent: agent.name })}
      description={t("launch.description")}
      footer={
        <>
          <span className="mr-auto hidden items-center gap-1 text-xs text-muted sm:inline-flex">
            <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            leftIcon={<Play aria-hidden />}
            loading={launch.isPending}
            disabled={!agent.ready}
            onClick={submit}
          >
            {launch.isPending ? t("launch.submitting") : t("launch.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {!agent.ready ? (
          <Alert tone="warning" title={t("launch.notReady", { issues: issues.join(", ") })} />
        ) : null}
        {problem ? <FormProblemAlert error={problem} /> : null}

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span id="launch-mode" className="text-[13px] font-medium text-ink">
              {t("launch.mode")}
            </span>
            <RadioGroup.Root
              value={mode}
              onValueChange={(value) => {
                setMode(value as "text" | "json");
                setInputError(null);
              }}
              aria-labelledby="launch-mode"
              className="inline-flex rounded-field border border-line bg-surface-2 p-0.5"
            >
              {(["text", "json"] as const).map((value) => (
                <RadioGroup.Item
                  key={value}
                  value={value}
                  className={cn(
                    "h-7 rounded-[5px] px-3 text-[13px] font-medium text-muted transition-colors max-md:h-9",
                    "hover:text-ink data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-sm",
                  )}
                >
                  {value === "text" ? t("launch.modeText") : t("launch.modeJson")}
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </div>
          <Field label={t("launch.input")} error={inputError} hideLabel>
            {mode === "text" ? (
              <Textarea
                rows={6}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={t("launch.inputPlaceholder")}
                data-autofocus
              />
            ) : (
              <CodeEditor value={json} onChange={setJson} minHeight="150px" />
            )}
          </Field>
        </div>

        <Field
          label={t("launch.timeout")}
          description={t("launch.timeoutHelp", { seconds: defaultTimeout })}
          className="max-w-56"
        >
          <Input
            type="number"
            inputMode="numeric"
            min={5}
            max={900}
            placeholder={String(defaultTimeout)}
            value={timeout}
            onChange={(event) => setTimeoutValue(event.target.value)}
          />
        </Field>

        {limits ? (
          <div className="rounded-card bg-surface-2/60 px-4 py-3">
            <p className="text-[13px] font-medium text-ink">{t("launch.limitsTitle")}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              <Limit icon={<Repeat aria-hidden />}>
                {t("launch.limitSteps", { count: limits.max_steps })}
              </Limit>
              <Limit icon={<Wrench aria-hidden />}>
                {t("launch.limitTools", { count: limits.max_tool_calls })}
              </Limit>
              <Limit icon={<Hourglass aria-hidden />}>
                {t("launch.limitTime", { seconds: timeout.trim() || defaultTimeout })}
              </Limit>
              {limits.max_cost_usd ? (
                <Limit icon={<Gauge aria-hidden />}>
                  {t("launch.limitCost", { amount: `$${limits.max_cost_usd}` })}
                </Limit>
              ) : null}
            </ul>
            <p className="mt-2 text-xs text-muted">{t("launch.costNote")}</p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
