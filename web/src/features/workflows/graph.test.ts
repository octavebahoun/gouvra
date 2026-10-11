import { describe, expect, it } from "vitest";
import type { Graph } from "./api";
import {
  ancestors,
  buildStep,
  canConnect,
  depths,
  references,
  skeleton,
  slug,
  templateGraph,
  tidy,
  uniqueId,
  withoutNode,
} from "./graph";

const chain: Graph = {
  nodes: [
    { id: "start", type: "start", label: "Input" },
    { id: "ask", type: "agent", label: "Ask", agent_id: "a1", input: "{{input}}" },
    { id: "check", type: "condition", label: "Check", value: "{{steps.ask.output}}" },
    { id: "end", type: "end", label: "Output" },
  ],
  edges: [
    { id: "start-ask", source: "start", target: "ask" },
    { id: "ask-check", source: "ask", target: "check" },
    { id: "check-end-true", source: "check", target: "end", branch: "true" },
  ],
};

const LABELS = {
  input: "Input",
  output: "Output",
  answer: "Answer",
  check: "Urgent?",
  escalate: "urgent",
  escalation: "Escalate",
};

describe("workflow graph helpers", () => {
  it("makes template-safe, unique step ids", () => {
    expect(slug("Résumé du ticket")).toBe("resume_du_ticket");
    expect(slug("42 answers")).toBe("step_42_answers");
    expect(slug("!!!")).toBe("step");
    expect(uniqueId(chain, "Ask")).toBe("ask_2");
    expect(uniqueId(chain, "Reply")).toBe("reply");
  });

  it("only allows links that keep the graph valid", () => {
    expect(canConnect(chain, "check", "end", "false")).toBe(true);
    expect(canConnect(chain, "check", "end", "true")).toBe(false); // already linked
    expect(canConnect(chain, "check", "end", null)).toBe(false); // a condition needs a branch
    expect(canConnect(chain, "ask", "end", "true")).toBe(false); // only conditions have branches
    expect(canConnect(chain, "end", "ask", null)).toBe(false); // an output ends its path
    expect(canConnect(chain, "ask", "start", null)).toBe(false); // nothing leads into the input
    expect(canConnect(chain, "check", "ask", "false")).toBe(false); // would close a loop
    expect(canConnect(chain, "ask", "ask", null)).toBe(false);
  });

  it("lists what a step may reference: the input and the steps before it", () => {
    expect(ancestors(chain, "end")).toEqual(new Set(["check", "ask", "start"]));
    expect(references(chain, "check").map((r) => r.path)).toEqual([
      "input",
      "steps.ask.output",
      "steps.ask.json",
    ]);
    expect(references(chain, "ask").map((r) => r.path)).toEqual(["input"]);
  });

  it("lays steps out in layers, branches side by side", () => {
    const laid = tidy(templateGraph("branch", LABELS, "agent-1"));
    const depth = depths(laid);
    expect(depth.get("input")).toBe(0);
    expect(depth.get("output")).toBe(4); // after the escalation branch
    const y = Object.fromEntries((laid.nodes ?? []).map((n) => [n.id, n.position?.y]));
    expect(y.answer).toBeGreaterThan(y.input ?? 0);
    const x = Object.fromEntries((laid.nodes ?? []).map((n) => [n.id, n.position?.x ?? 0]));
    expect(x.escalation).not.toBe(x.check);
  });

  it("adds a step under the selected one and links it", () => {
    const built = buildStep(chain, "transform", { label: "Shape" }, "ask");
    expect(built?.id).toBe("shape");
    const node = built?.graph.nodes?.find((n) => n.id === "shape");
    expect(node).toMatchObject({ type: "transform", template: "{{steps.ask.output}}" });
    expect(built?.graph.edges).toContainEqual({ id: "ask-shape", source: "ask", target: "shape" });
    const fromCondition = buildStep(chain, "end", { label: "No answer" }, "check");
    expect(fromCondition?.graph.edges).toContainEqual({
      id: "check-no_answer-false",
      source: "check",
      target: "no_answer",
      branch: "false",
    });
    expect(buildStep(chain, "agent", { label: "Agent" }, null)).toBeNull(); // no agent chosen
  });

  it("removes a step with its links, and builds JSON skeletons", () => {
    const without = withoutNode(chain, "ask");
    expect(without.edges?.map((e) => e.id)).toEqual(["check-end-true"]);
    expect(
      skeleton({
        type: "object",
        properties: { text: { type: "string" }, n: { type: "integer" }, tags: { type: "array" } },
      }),
    ).toEqual({ text: "", n: 0, tags: [] });
    expect(skeleton(null)).toEqual({});
  });

  it("offers templates that start valid", () => {
    expect(templateGraph("blank", LABELS).nodes?.map((n) => n.type)).toEqual(["start", "end"]);
    expect(templateGraph("agent", LABELS, "a").edges).toHaveLength(2);
    expect(templateGraph("agent", LABELS).nodes).toHaveLength(2); // no agent: blank
  });
});
