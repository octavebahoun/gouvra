import { Braces, CircleX, Link2, Trash2, TriangleAlert, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { prettyJson } from "@/lib/json";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Select, Switch } from "@/components/ui/controls";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Textarea } from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { useAgentVersions, type Agent } from "@/features/agents/api";
import type { Tool } from "@/features/tools/api";
import type { Graph, GraphEdge, GraphNode, Issue } from "./api";
import type { Selection } from "./canvas";
import {
  addEdge,
  canConnect,
  edgeId,
  edgesOf,
  findNode,
  nodesOf,
  OPERATORS,
  references,
  skeleton,
  UNARY_OPERATORS,
  updateNode,
  withoutNode,
  type Operator,
} from "./graph";
import { TYPE_META } from "./meta";

type Change = (graph: Graph, coalesce?: string) => void;

type Props = {
  graph: Graph;
  selection: Selection | null;
  issues: Issue[];
  editable: boolean;
  agents: Agent[];
  tools: Tool[];
  onChange: Change;
  onSelect: (selection: Selection | null) => void;
};

const NUMERIC = new Set<Operator>(["gt", "gte", "lt", "lte"]);
const DEFAULT_INPUT_SCHEMA = {
  type: "object",
  required: ["message"],
  properties: { message: { type: "string" } },
};

/** Properties of the selected step or link, or the workflow's settings and problems. */
export function Inspector(props: Props) {
  const { graph, selection } = props;
  const node = selection?.kind === "node" ? findNode(graph, selection.id) : undefined;
  const edge =
    selection?.kind === "edge" ? edgesOf(graph).find((e) => e.id === selection.id) : undefined;
  if (node) return <NodeInspector key={node.id} {...props} node={node} />;
  if (edge) return <EdgeInspector key={edge.id} {...props} edge={edge} />;
  return <WorkflowInspector {...props} />;
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line px-4 py-4 first:border-t-0">
      <h3 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function IssueList({
  issues,
  graph,
  onSelect,
}: {
  issues: Issue[];
  graph: Graph;
  onSelect?: (selection: Selection) => void;
}) {
  const { t } = useTranslation("workflows");
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-2">
      {issues.map((issue, index) => {
        const Icon = issue.severity === "error" ? CircleX : TriangleAlert;
        const target = issue.node_id
          ? findNode(graph, issue.node_id)?.label
          : issue.edge_id
            ? t("inspector.linkTitle")
            : null;
        return (
          <li
            key={`${issue.code}-${issue.node_id ?? issue.edge_id ?? index}`}
            className="flex gap-2 text-[13px] leading-snug"
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 size-4 shrink-0",
                issue.severity === "error" ? "text-danger-text" : "text-warning-text",
              )}
            />
            <span className="min-w-0">
              <span className="sr-only">
                {t(issue.severity === "error" ? "editor.error" : "editor.warning")}:{" "}
              </span>
              {target && onSelect ? (
                <button
                  type="button"
                  className="mr-1 font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                  onClick={() =>
                    onSelect(
                      issue.node_id
                        ? { kind: "node", id: issue.node_id }
                        : { kind: "edge", id: issue.edge_id ?? "" },
                    )
                  }
                >
                  {target}
                </button>
              ) : null}
              <span className="text-muted">{issue.message}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function WorkflowInspector({ graph, issues, editable, onChange, onSelect }: Props) {
  const { t } = useTranslation("workflows");
  const timeout = graph.settings?.timeout_s ?? 900;
  const [raw, setRaw] = useState(String(timeout));
  const valid = /^\d+$/.test(raw) && Number(raw) >= 10 && Number(raw) <= 3600;
  return (
    <div>
      <Section title={t("inspector.workflow")}>
        <Field
          label={t("inspector.timeout")}
          hint={t("inspector.timeoutHelp")}
          error={valid ? null : t("inspector.timeoutError")}
        >
          <Input
            inputMode="numeric"
            value={raw}
            disabled={!editable}
            onChange={(event) => {
              setRaw(event.target.value);
              const value = Number(event.target.value);
              if (/^\d+$/.test(event.target.value) && value >= 10 && value <= 3600) {
                onChange(
                  { ...graph, settings: { ...graph.settings, timeout_s: value } },
                  "timeout",
                );
              }
            }}
          />
        </Field>
      </Section>
      <Section title={t("inspector.problems")}>
        {issues.length ? (
          <IssueList issues={issues} graph={graph} onSelect={onSelect} />
        ) : (
          <p className="text-[13px] text-success-text">{t("editor.noProblems")}</p>
        )}
      </Section>
      <Section title={t("inspector.howTo")}>
        <p className="text-[13px] leading-relaxed text-muted">{t("editor.selectHint")}</p>
        {editable ? (
          <p className="text-[12px] leading-relaxed text-muted">{t("editor.shortcuts")}</p>
        ) : null}
      </Section>
    </div>
  );
}

/** A template with a menu that inserts references to the input and earlier steps. */
function TemplateField({
  label,
  hint,
  value,
  onChange,
  graph,
  nodeId,
  rows = 3,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  graph: Graph;
  nodeId: string;
  rows?: number;
  disabled?: boolean;
}) {
  const { t } = useTranslation("workflows");
  const area = useRef<HTMLTextAreaElement>(null);
  const available = references(graph, nodeId);
  const start = nodesOf(graph).find((n) => n.type === "start");
  const fields =
    start?.type === "start" && start.input_schema
      ? Object.keys(skeleton(start.input_schema)).map((name) => `input.${name}`)
      : [];

  function insert(path: string) {
    const token = `{{${path}}}`;
    const element = area.current;
    const from = element?.selectionStart ?? value.length;
    const to = element?.selectionEnd ?? value.length;
    onChange(value.slice(0, from) + token + value.slice(to));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(from + token.length, from + token.length);
    });
  }

  return (
    <Field
      label={label}
      hint={hint}
      labelAside={
        disabled ? undefined : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="tertiary"
                leftIcon={<Braces aria-hidden />}
                className="h-7"
              >
                {t("inspector.insert")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-72 min-w-56 overflow-y-auto">
              <DropdownMenuLabel>{t("inspector.insertLabel")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => insert("input")}>
                {t("inspector.referenceInput")}
              </DropdownMenuItem>
              {fields.map((path) => (
                <DropdownMenuItem key={path} onSelect={() => insert(path)}>
                  <code className="text-[12px]">{path}</code>
                </DropdownMenuItem>
              ))}
              {available
                .filter((r) => r.nodeId)
                .map((reference) => {
                  const step = findNode(graph, reference.nodeId ?? "")?.label ?? reference.nodeId;
                  return (
                    <DropdownMenuItem key={reference.path} onSelect={() => insert(reference.path)}>
                      {t(
                        reference.field === "json"
                          ? "inspector.referenceJson"
                          : "inspector.referenceOutput",
                        { step },
                      )}
                    </DropdownMenuItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      <Textarea
        ref={area}
        rows={rows}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-[12.5px] leading-relaxed"
      />
    </Field>
  );
}

/** JSON edited as text; the graph only changes when the text is valid JSON of the right kind. */
function JsonField({
  label,
  hint,
  initial,
  onValid,
  disabled,
  action,
}: {
  label: string;
  hint?: ReactNode;
  initial: unknown;
  onValid: (value: Record<string, unknown>) => void;
  disabled?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation("workflows");
  const [text, setText] = useState(() => prettyJson(initial ?? {}));
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error} labelAside={action}>
      <CodeEditor
        value={text}
        readOnly={disabled}
        minHeight="96px"
        maxHeight="260px"
        onChange={(next) => {
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              setError(t("inspector.jsonObject"));
              return;
            }
            setError(null);
            onValid(parsed as Record<string, unknown>);
          } catch {
            setError(t("inspector.jsonInvalid"));
          }
        }}
      />
    </Field>
  );
}

function NodeInspector({
  graph,
  node,
  issues,
  editable,
  agents,
  tools,
  onChange,
  onSelect,
}: Props & { node: GraphNode }) {
  const { t } = useTranslation("workflows");
  const { Icon, accent } = TYPE_META[node.type];
  const own = issues.filter((i) => i.node_id === node.id);
  const patch = (values: Partial<GraphNode>, field: string) =>
    onChange(updateNode(graph, node.id, values), `${node.id}:${field}`);
  const reference = node.type === "start" ? "input" : `steps.${node.id}.output`;

  return (
    <div>
      <div className="flex items-center gap-2.5 px-4 pt-4">
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${accent} 15%, transparent)`, color: accent }}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 id="inspector-title" className="truncate text-[15px] font-semibold text-ink">
            {node.label}
          </h2>
          <p className="text-[12px] text-muted">{t(`typeHelp.${node.type}`)}</p>
        </div>
      </div>
      <Section title={t("inspector.step")}>
        <Field label={t("inspector.label")}>
          <Input
            value={node.label}
            maxLength={80}
            disabled={!editable}
            onChange={(event) => patch({ label: event.target.value }, "label")}
          />
        </Field>
        <div className="flex items-center justify-between gap-2 rounded-field bg-surface-2 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[12px] text-muted">{t("inspector.reference")}</p>
            <code className="block truncate text-[12.5px] text-ink">{`{{${reference}}}`}</code>
          </div>
          <CopyButton value={`{{${reference}}}`} label={t("inspector.copyReference")} />
        </div>
        <StepFields
          graph={graph}
          node={node}
          editable={editable}
          agents={agents}
          tools={tools}
          patch={patch}
        />
      </Section>
      {node.type !== "end" ? (
        <Section title={t("inspector.links")}>
          <Links graph={graph} node={node} editable={editable} onChange={onChange} />
        </Section>
      ) : null}
      {own.length ? (
        <Section title={t("inspector.problems")}>
          <IssueList issues={own} graph={graph} />
        </Section>
      ) : null}
      {editable ? (
        <div className="border-t border-line px-4 py-4">
          {node.type === "start" ? (
            <p className="text-[12px] text-muted">{t("inspector.startLocked")}</p>
          ) : (
            <Button
              variant="danger-ghost"
              leftIcon={<Trash2 aria-hidden />}
              onClick={() => {
                onSelect(null);
                onChange(withoutNode(graph, node.id));
              }}
            >
              {t("inspector.deleteStep")}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StepFields({
  graph,
  node,
  editable,
  agents,
  tools,
  patch,
}: {
  graph: Graph;
  node: GraphNode;
  editable: boolean;
  agents: Agent[];
  tools: Tool[];
  patch: (values: Partial<GraphNode>, field: string) => void;
}) {
  const { t } = useTranslation("workflows");
  const onError = (value: "fail" | "continue" | undefined) => (
    <Field label={t("inspector.onError")}>
      <Select
        value={value ?? "fail"}
        disabled={!editable}
        onValueChange={(next) => patch({ on_error: next as "fail" | "continue" }, "on_error")}
        options={[
          { value: "fail", label: t("inspector.onErrorFail") },
          { value: "continue", label: t("inspector.onErrorContinue") },
        ]}
      />
    </Field>
  );

  switch (node.type) {
    case "start":
      return (
        <>
          <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
            {t("inspector.validateInput")}
            <Switch
              checked={Boolean(node.input_schema)}
              disabled={!editable}
              onCheckedChange={(checked) =>
                patch({ input_schema: checked ? DEFAULT_INPUT_SCHEMA : null }, "schema")
              }
            />
          </label>
          {node.input_schema ? (
            <JsonField
              label={t("inspector.inputSchema")}
              hint={t("inspector.inputSchemaHelp")}
              initial={node.input_schema}
              disabled={!editable}
              onValid={(value) => patch({ input_schema: value }, "schema")}
            />
          ) : null}
        </>
      );
    case "agent":
      return (
        <>
          <Field label={t("inspector.agent")}>
            <Select
              value={node.agent_id}
              disabled={!editable}
              onValueChange={(value) => patch({ agent_id: value, version: null }, "agent")}
              options={agents.map((agent) => ({
                value: agent.id,
                label:
                  agent.status === "archived"
                    ? `${agent.name} (${t("inspector.archived")})`
                    : agent.name,
                disabled: agent.status === "archived" && agent.id !== node.agent_id,
              }))}
            />
          </Field>
          <AgentVersionField
            agentId={node.agent_id}
            version={node.version ?? null}
            disabled={!editable}
            onChange={(version) => patch({ version }, "version")}
          />
          <TemplateField
            label={t("inspector.input")}
            hint={t("inspector.inputHelp")}
            value={node.input ?? "{{input}}"}
            graph={graph}
            nodeId={node.id}
            disabled={!editable}
            onChange={(input) => patch({ input }, "input")}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("inspector.retries")} hint={t("inspector.retriesHelp")}>
              <Select
                value={String(node.retries ?? 0)}
                disabled={!editable}
                onValueChange={(value) => patch({ retries: Number(value) }, "retries")}
                options={[0, 1, 2, 3].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </Field>
            {onError(node.on_error)}
          </div>
        </>
      );
    case "tool": {
      const tool = tools.find((candidate) => candidate.id === node.tool_id);
      return (
        <>
          <Field label={t("inspector.tool")}>
            <Select
              value={node.tool_id}
              disabled={!editable}
              onValueChange={(value) => patch({ tool_id: value }, "tool")}
              options={tools.map((candidate) => ({
                value: candidate.id,
                label:
                  candidate.status === "active"
                    ? candidate.display_name
                    : `${candidate.display_name} (${t("inspector.disabled")})`,
              }))}
            />
          </Field>
          <JsonField
            key={node.tool_id}
            label={t("inspector.arguments")}
            hint={t("inspector.argumentsHelp", { example: "{{steps.lookup.json.id}}" })}
            initial={node.arguments ?? {}}
            disabled={!editable}
            onValid={(value) => patch({ arguments: value }, "arguments")}
            action={
              editable && tool ? (
                <Button
                  size="sm"
                  variant="tertiary"
                  className="h-7"
                  onClick={() =>
                    patch(
                      { arguments: { ...skeleton(tool.input_schema), ...(node.arguments ?? {}) } },
                      "arguments-fill",
                    )
                  }
                >
                  {t("inspector.fillArguments")}
                </Button>
              ) : undefined
            }
          />
          {onError(node.on_error)}
        </>
      );
    }
    case "condition": {
      const operator: Operator = node.operator ?? "contains";
      return (
        <>
          <TemplateField
            label={t("inspector.value")}
            value={node.value}
            rows={2}
            graph={graph}
            nodeId={node.id}
            disabled={!editable}
            onChange={(value) => patch({ value }, "value")}
          />
          <Field label={t("inspector.operator")}>
            <Select
              value={operator}
              disabled={!editable}
              onValueChange={(value) => patch({ operator: value as Operator }, "operator")}
              options={OPERATORS.map((op) => ({ value: op, label: t(`operators.${op}`) }))}
            />
          </Field>
          {UNARY_OPERATORS.has(operator) ? null : (
            <TemplateField
              label={t(operator === "matches" ? "inspector.pattern" : "inspector.operand")}
              value={node.operand ?? ""}
              rows={1}
              graph={graph}
              nodeId={node.id}
              disabled={!editable}
              onChange={(operand) => patch({ operand }, "operand")}
            />
          )}
          {NUMERIC.has(operator) ? null : (
            <label className="flex items-center justify-between gap-3 text-[13px] text-ink">
              {t("inspector.caseSensitive")}
              <Switch
                checked={Boolean(node.case_sensitive)}
                disabled={!editable}
                onCheckedChange={(checked) => patch({ case_sensitive: checked }, "case")}
              />
            </label>
          )}
          <p className="text-[12px] leading-relaxed text-muted">{t("inspector.branchesHelp")}</p>
        </>
      );
    }
    case "transform":
      return (
        <>
          <TemplateField
            label={t("inspector.template")}
            value={node.template}
            rows={5}
            graph={graph}
            nodeId={node.id}
            disabled={!editable}
            onChange={(template) => patch({ template }, "template")}
          />
          <Field label={t("inspector.output")}>
            <Select
              value={node.output ?? "text"}
              disabled={!editable}
              onValueChange={(value) => patch({ output: value as "text" | "json" }, "output")}
              options={[
                { value: "text", label: t("inspector.outputText") },
                { value: "json", label: t("inspector.outputJson") },
              ]}
            />
          </Field>
        </>
      );
    case "end":
      return (
        <TemplateField
          label={t("inspector.endOutput")}
          hint={t("inspector.endOutputHelp")}
          value={node.output ?? ""}
          rows={3}
          graph={graph}
          nodeId={node.id}
          disabled={!editable}
          onChange={(output) => patch({ output }, "output")}
        />
      );
  }
}

function AgentVersionField({
  agentId,
  version,
  disabled,
  onChange,
}: {
  agentId: string;
  version: number | null;
  disabled: boolean;
  onChange: (version: number | null) => void;
}) {
  const { t } = useTranslation("workflows");
  const versions = useAgentVersions(agentId);
  const list = versions.data ?? [];
  const latest = list.reduce((max, v) => Math.max(max, v.number), 0);
  return (
    <Field label={t("inspector.version")} hint={t("inspector.versionHelp")}>
      <Select
        value={version ? String(version) : "current"}
        disabled={disabled}
        onValueChange={(value) => onChange(value === "current" ? null : Number(value))}
        options={[
          {
            value: "current",
            label: latest
              ? t("inspector.currentVersion", { version: latest })
              : t("inspector.current"),
          },
          ...list.map((v) => ({ value: String(v.number), label: `v${v.number}` })),
        ]}
      />
    </Field>
  );
}

function Links({
  graph,
  node,
  editable,
  onChange,
}: {
  graph: Graph;
  node: GraphNode;
  editable: boolean;
  onChange: Change;
}) {
  const { t } = useTranslation("workflows");
  const outgoing = edgesOf(graph).filter((e) => e.source === node.id);
  const isCondition = node.type === "condition";
  const missing = isCondition && outgoing.some((e) => e.branch === "true") ? "false" : "true";
  const [branch, setBranch] = useState<"true" | "false">(missing);
  const linkable = nodesOf(graph).filter((candidate) =>
    canConnect(graph, node.id, candidate.id, isCondition ? branch : null),
  );
  return (
    <div className="space-y-3">
      {outgoing.length ? (
        <ul className="space-y-1.5">
          {outgoing.map((edge) => {
            const target = findNode(graph, edge.target)?.label ?? edge.target;
            return (
              <li
                key={edge.id}
                className="flex items-center gap-2 rounded-field border border-line px-2.5 py-1.5 text-[13px]"
              >
                <Link2 aria-hidden className="size-3.5 shrink-0 text-muted" />
                {edge.branch ? (
                  <Badge tone={edge.branch === "true" ? "success" : "neutral"}>
                    {t(edge.branch === "true" ? "inspector.branchTrue" : "inspector.branchFalse")}
                  </Badge>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-ink">{target}</span>
                {editable ? (
                  <IconButton
                    size="icon-sm"
                    label={t("inspector.removeLink", { step: target })}
                    icon={<X aria-hidden />}
                    onClick={() =>
                      onChange({ ...graph, edges: edgesOf(graph).filter((e) => e.id !== edge.id) })
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">{t("inspector.noLinks")}</p>
      )}
      {editable && linkable.length ? (
        <div className={cn("grid gap-2", isCondition && "grid-cols-[7rem_minmax(0,1fr)]")}>
          {isCondition ? (
            <Select
              aria-label={t("inspector.branch")}
              value={branch}
              onValueChange={(value) => setBranch(value as "true" | "false")}
              options={[
                { value: "true", label: t("inspector.branchTrue") },
                { value: "false", label: t("inspector.branchFalse") },
              ]}
            />
          ) : null}
          <Select
            aria-label={t("inspector.addLink")}
            placeholder={t("inspector.addLink")}
            value=""
            onValueChange={(target) =>
              onChange(addEdge(graph, node.id, target, isCondition ? branch : null))
            }
            options={linkable.map((candidate) => ({ value: candidate.id, label: candidate.label }))}
          />
        </div>
      ) : null}
    </div>
  );
}

function EdgeInspector({
  graph,
  edge,
  issues,
  editable,
  onChange,
  onSelect,
}: Props & { edge: GraphEdge }) {
  const { t } = useTranslation("workflows");
  const source = findNode(graph, edge.source);
  const target = findNode(graph, edge.target);
  const own = issues.filter((i) => i.edge_id === edge.id);
  return (
    <div>
      <div className="px-4 pt-4">
        <h2 id="inspector-title" className="text-[15px] font-semibold text-ink">
          {t("inspector.linkTitle")}
        </h2>
        <p className="text-[13px] text-muted">
          {t("inspector.linkFrom", {
            source: source?.label ?? edge.source,
            target: target?.label ?? edge.target,
          })}
        </p>
      </div>
      {source?.type === "condition" ? (
        <Section title={t("inspector.branch")}>
          <Select
            aria-label={t("inspector.branch")}
            value={edge.branch ?? "true"}
            disabled={!editable}
            onValueChange={(value) => {
              const branch = value as "true" | "false";
              const id = edgeId(edge.source, edge.target, branch);
              if (edgesOf(graph).some((e) => e.id === id)) return;
              onChange({
                ...graph,
                edges: edgesOf(graph).map((e) => (e.id === edge.id ? { ...e, id, branch } : e)),
              });
              onSelect({ kind: "edge", id });
            }}
            options={[
              { value: "true", label: t("inspector.branchTrue") },
              { value: "false", label: t("inspector.branchFalse") },
            ]}
          />
        </Section>
      ) : null}
      {own.length ? (
        <Section title={t("inspector.problems")}>
          <IssueList issues={own} graph={graph} />
        </Section>
      ) : null}
      {editable ? (
        <div className="border-t border-line px-4 py-4">
          <Button
            variant="danger-ghost"
            leftIcon={<Trash2 aria-hidden />}
            onClick={() => {
              onSelect(null);
              onChange({ ...graph, edges: edgesOf(graph).filter((e) => e.id !== edge.id) });
            }}
          >
            {t("inspector.deleteLink")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
