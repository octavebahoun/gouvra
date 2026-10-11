import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef } from "react";
import { API_BASE } from "@/lib/api/http";
import {
  executionKeys,
  fetchAllEvents,
  isTerminalStatus,
  type ExecutionEvent,
  type ExecutionStatus,
} from "./api";

/** Text being written right now, per model turn (step), from token deltas. */
export type StepStream = { text: string; reasoning: string; tools: string[] };

export type LiveTrace = {
  events: ExecutionEvent[];
  streams: Record<number, StepStream>;
  /** Connected to the live feed (false for finished executions: their trace is complete). */
  live: boolean;
  loading: boolean;
  error: boolean;
};

type Action =
  | { type: "reset" }
  | { type: "events"; events: ExecutionEvent[] }
  | { type: "delta"; step: number; stream: string; text: string }
  | { type: "live"; live: boolean }
  | { type: "loaded" }
  | { type: "error" };

const EMPTY: LiveTrace = { events: [], streams: {}, live: false, loading: true, error: false };

function reducer(state: LiveTrace, action: Action): LiveTrace {
  switch (action.type) {
    case "reset":
      return EMPTY;
    case "events": {
      const known = new Set(state.events.map((e) => e.seq));
      const fresh = action.events.filter((e) => !known.has(e.seq));
      if (fresh.length === 0) return state;
      const events = [...state.events, ...fresh].sort((a, b) => a.seq - b.seq);
      // A model answer is recorded once complete: its live draft is no longer needed.
      const settled = new Set(
        fresh
          .filter((e) => e.type === "model.response" || e.type === "model.error")
          .map((e) => e.step),
      );
      const streams = Object.fromEntries(
        Object.entries(state.streams).filter(([step]) => !settled.has(Number(step))),
      );
      return { ...state, events, streams };
    }
    case "delta": {
      const current = state.streams[action.step] ?? { text: "", reasoning: "", tools: [] };
      const next: StepStream =
        action.stream === "reasoning"
          ? { ...current, reasoning: current.reasoning + action.text }
          : action.stream === "tool_call"
            ? { ...current, tools: [...current.tools, action.text] }
            : { ...current, text: current.text + action.text };
      return { ...state, streams: { ...state.streams, [action.step]: next } };
    }
    case "live":
      return { ...state, live: action.live };
    case "loaded":
      return { ...state, loading: false };
    case "error":
      return { ...state, loading: false, error: true };
  }
}

const COUNTER_EVENTS = new Set([
  "execution.started",
  "model.response",
  "model.error",
  "tool.result",
  "execution.cancel_requested",
]);

/**
 * The trace of one execution. Finished executions load their recorded events once; running ones
 * subscribe to the server-sent stream (replay + live events + token deltas) and keep the
 * execution's counters fresh. Reconnection resumes from the last event (Last-Event-ID).
 */
export function useLiveTrace(executionId: string, status: ExecutionStatus | undefined): LiveTrace {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const queryClient = useQueryClient();
  const lastRefresh = useRef(0);
  const terminal = status ? isTerminalStatus(status) : false;
  const known = status !== undefined;

  useEffect(() => {
    dispatch({ type: "reset" });
  }, [executionId]);

  useEffect(() => {
    if (!known) return undefined;
    let cancelled = false;
    let refreshTimer: number | undefined;

    const refreshExecution = () => {
      const wait = Math.max(0, 500 - (Date.now() - lastRefresh.current));
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        lastRefresh.current = Date.now();
        void queryClient.invalidateQueries({ queryKey: executionKeys.detail(executionId) });
      }, wait);
    };

    if (terminal) {
      fetchAllEvents(executionId)
        .then((events) => {
          if (cancelled) return;
          dispatch({ type: "events", events });
          dispatch({ type: "loaded" });
        })
        .catch(() => {
          if (!cancelled) dispatch({ type: "error" });
        });
      return () => {
        cancelled = true;
      };
    }

    const stream = new EventSource(`${API_BASE}/executions/${executionId}/stream`, {
      withCredentials: true,
    });
    stream.onopen = () => {
      dispatch({ type: "live", live: true });
      dispatch({ type: "loaded" });
    };
    stream.addEventListener("event", (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ExecutionEvent;
      dispatch({ type: "events", events: [event] });
      if (COUNTER_EVENTS.has(event.type) || event.type.startsWith("execution.")) refreshExecution();
    });
    stream.addEventListener("delta", (message: MessageEvent<string>) => {
      const delta = JSON.parse(message.data) as { step: number; stream: string; text: string };
      dispatch({ type: "delta", step: delta.step, stream: delta.stream, text: delta.text });
    });
    stream.addEventListener("end", () => {
      stream.close();
      dispatch({ type: "live", live: false });
      lastRefresh.current = 0;
      refreshExecution();
      void queryClient.invalidateQueries({ queryKey: ["workspaces"], refetchType: "active" });
    });
    stream.onerror = () => {
      // EventSource reconnects on its own (and resumes from Last-Event-ID); reflect the gap.
      dispatch({ type: "live", live: false });
    };

    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      stream.close();
    };
  }, [executionId, known, terminal, queryClient]);

  return state;
}

export type WorkspaceStatusMessage = {
  kind: "execution.status";
  execution_id: string;
  agent_id: string | null;
  status: ExecutionStatus;
  at: string;
};

/**
 * Workspace live feed: execution state changes refresh the lists and the overview (batched),
 * and are handed to `onStatus` for row-level animation.
 */
export function useWorkspaceLive(
  workspaceId: string,
  onStatus?: (message: WorkspaceStatusMessage) => void,
): void {
  const queryClient = useQueryClient();
  const callback = useRef(onStatus);
  useEffect(() => {
    callback.current = onStatus;
  });

  useEffect(() => {
    let timer: number | undefined;
    const source = new EventSource(`${API_BASE}/workspaces/${workspaceId}/stream`, {
      withCredentials: true,
    });
    source.addEventListener("execution.status", (message: MessageEvent<string>) => {
      const body = JSON.parse(message.data) as WorkspaceStatusMessage;
      callback.current?.(body);
      queryClient.setQueryData(
        executionKeys.detail(body.execution_id),
        (current: { status: ExecutionStatus } | undefined) =>
          current ? { ...current, status: body.status } : current,
      );
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "executions"] });
        void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "overview"] });
      }, 400);
    });
    return () => {
      window.clearTimeout(timer);
      source.close();
    };
  }, [workspaceId, queryClient]);
}
