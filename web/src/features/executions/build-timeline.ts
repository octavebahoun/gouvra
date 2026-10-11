import type { ExecutionEvent } from "./api";

export type Data = Record<string, unknown>;
export const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
export const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

export type TimelineItem =
  | { kind: "lifecycle"; seq: number; event: ExecutionEvent }
  | {
      kind: "model";
      seq: number;
      step: number;
      request?: ExecutionEvent;
      response?: ExecutionEvent;
      error?: ExecutionEvent;
    }
  | { kind: "tool"; seq: number; call: ExecutionEvent; result?: ExecutionEvent }
  | { kind: "log"; seq: number; event: ExecutionEvent };

/**
 * Fold raw events into what a person reads: one card per model turn (request → streamed answer →
 * response or error) and one per tool call (arguments → result), in the order they started.
 */
export function buildTimeline(events: ExecutionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const models = new Map<number, Extract<TimelineItem, { kind: "model" }>>();
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  for (const event of events) {
    const data = event.data;
    if (event.type.startsWith("model.") && event.step !== null) {
      let item = models.get(event.step);
      if (!item) {
        item = { kind: "model", seq: event.seq, step: event.step };
        models.set(event.step, item);
        items.push(item);
      }
      if (event.type === "model.request") item.request = event;
      else if (event.type === "model.response") item.response = event;
      else item.error = event;
    } else if (event.type === "tool.call") {
      const item: TimelineItem = { kind: "tool", seq: event.seq, call: event };
      tools.set(str(data.call_id) ?? String(event.seq), item);
      items.push(item);
    } else if (event.type === "tool.result") {
      const match = tools.get(str(data.call_id) ?? "");
      if (match) match.result = event;
      else items.push({ kind: "log", seq: event.seq, event });
    } else if (event.type === "log") {
      items.push({ kind: "log", seq: event.seq, event });
    } else {
      items.push({ kind: "lifecycle", seq: event.seq, event });
    }
  }
  return items;
}
