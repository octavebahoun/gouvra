import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { asGraph, useSaveDraft, type Graph, type Workflow } from "./api";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

type State = {
  graph: Graph;
  revision: number;
  past: Graph[];
  future: Graph[];
  status: SaveStatus;
  /** The graph before an ongoing drag: a whole drag is one undo step. */
  origin: Graph | null;
  /** Consecutive edits of one field (typing) are one undo step too. */
  coalesce: { key: string; at: number } | null;
};

type Action =
  | { type: "edit"; graph: Graph; commit: boolean; coalesce?: string; at: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "saving" }
  | { type: "saved"; graph: Graph; workflow: Workflow }
  | { type: "error" }
  | { type: "conflict" }
  | { type: "reset"; workflow: Workflow };

const HISTORY = 60;
const COALESCE_MS = 1200;
export const AUTOSAVE_MS = 700;

function init(workflow: Workflow): State {
  return {
    graph: asGraph(workflow.draft),
    revision: workflow.draft_revision,
    past: [],
    future: [],
    status: "saved",
    origin: null,
    coalesce: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "edit": {
      if (state.status === "conflict") return state;
      const origin = state.origin ?? state.graph;
      if (!action.commit) return { ...state, graph: action.graph, origin, status: "dirty" };
      const merge =
        action.coalesce !== undefined &&
        state.coalesce?.key === action.coalesce &&
        action.at - state.coalesce.at < COALESCE_MS;
      return {
        ...state,
        graph: action.graph,
        past: merge ? state.past : [...state.past, origin].slice(-HISTORY),
        future: [],
        origin: null,
        coalesce: action.coalesce ? { key: action.coalesce, at: action.at } : null,
        status: "dirty",
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous || state.status === "conflict") return state;
      return {
        ...state,
        graph: previous,
        past: state.past.slice(0, -1),
        future: [state.graph, ...state.future].slice(0, HISTORY),
        origin: null,
        coalesce: null,
        status: "dirty",
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next || state.status === "conflict") return state;
      return {
        ...state,
        graph: next,
        past: [...state.past, state.graph].slice(-HISTORY),
        future: state.future.slice(1),
        origin: null,
        coalesce: null,
        status: "dirty",
      };
    }
    case "saving":
      return state.status === "conflict" ? state : { ...state, status: "saving" };
    case "saved":
      return {
        ...state,
        revision: action.workflow.draft_revision,
        // Edits made while saving are saved next.
        status: state.graph === action.graph ? "saved" : "dirty",
      };
    case "error":
      return state.status === "conflict" ? state : { ...state, status: "error" };
    case "conflict":
      return { ...state, status: "conflict" };
    case "reset":
      return init(action.workflow);
  }
}

/**
 * The editor's draft: local edits apply at once, are saved shortly after (each save names the
 * revision it started from, so a concurrent edit is detected instead of overwritten), and can be
 * undone. A pending save is flushed before a test run, a publish, or leaving the page. Each save
 * refreshes the cached workflow, whose problems and publish state the page reads.
 */
export function useDraft(workflow: Workflow) {
  const save = useSaveDraft(workflow.id);
  const [state, dispatch] = useReducer(reducer, workflow, init);
  const latest = useRef(state);
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    latest.current = state;
  }, [state]);

  const persist = useCallback((): Promise<boolean> => {
    async function attempt(): Promise<boolean> {
      window.clearTimeout(timer.current);
      if (inFlight.current) await inFlight.current;
      const current = latest.current;
      if (current.status === "conflict") return false;
      if (current.status === "saved") return true;
      const graph = current.graph;
      dispatch({ type: "saving" });
      const request = save
        .mutateAsync({ graph, revision: current.revision })
        .then((saved) => {
          dispatch({ type: "saved", graph, workflow: saved });
          latest.current = { ...latest.current, revision: saved.draft_revision };
          return true;
        })
        .catch((error: unknown) => {
          const conflict = error instanceof ApiError && error.code === "draft_conflict";
          dispatch({ type: conflict ? "conflict" : "error" });
          return false;
        });
      inFlight.current = request;
      const ok = await request;
      inFlight.current = null;
      // Edits made during the save are saved next.
      if (ok && latest.current.graph !== graph && latest.current.status !== "conflict") {
        timer.current = window.setTimeout(() => void attempt(), AUTOSAVE_MS);
      }
      return ok;
    }
    return attempt();
  }, [save]);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist(), AUTOSAVE_MS);
  }, [persist]);

  const update = useCallback(
    (graph: Graph, commit = true, coalesce?: string) => {
      dispatch({ type: "edit", graph, commit, coalesce, at: Date.now() });
      latest.current = { ...latest.current, graph, status: "dirty" };
      schedule();
    },
    [schedule],
  );

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
    schedule();
  }, [schedule]);

  const redo = useCallback(() => {
    dispatch({ type: "redo" });
    schedule();
  }, [schedule]);

  const reset = useCallback((fresh: Workflow) => {
    window.clearTimeout(timer.current);
    dispatch({ type: "reset", workflow: fresh });
  }, []);

  // Leaving the editor saves what is pending.
  useEffect(
    () => () => {
      if (latest.current.status === "dirty" || latest.current.status === "error") {
        void persist();
      }
    },
    [persist],
  );

  return {
    graph: state.graph,
    status: state.status,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    update,
    undo,
    redo,
    flush: persist,
    reset,
  };
}
