import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api/http";
import { workflowKeys, type WorkflowRun, type WorkflowStep } from "./api";

type Snapshot = {
  kind: "snapshot";
  run: Partial<WorkflowRun> & { id: string; status: string };
  steps: WorkflowStep[];
};

/**
 * Follows a running workflow: each message is the whole state of the run (its head and every
 * step), merged into the cached run so every view on the page moves together. A reconnecting
 * stream starts with a fresh snapshot, so nothing is lost.
 */
export function useLiveRun(runId: string, status: string | undefined): boolean {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const running = status === "running";

  useEffect(() => {
    if (!running) return undefined;
    const stream = new EventSource(`${API_BASE}/workflow-runs/${runId}/stream`, {
      withCredentials: true,
    });
    stream.onopen = () => setLive(true);
    stream.addEventListener("snapshot", (message: MessageEvent<string>) => {
      const snapshot = JSON.parse(message.data) as Snapshot;
      queryClient.setQueryData<WorkflowRun>(workflowKeys.run(runId), (current) =>
        current ? { ...current, ...snapshot.run, steps: snapshot.steps } : current,
      );
    });
    stream.addEventListener("end", () => {
      stream.close();
      setLive(false);
      void queryClient.invalidateQueries({ queryKey: workflowKeys.run(runId) });
      void queryClient.invalidateQueries({ queryKey: ["workspaces"], refetchType: "active" });
    });
    stream.onerror = () => setLive(false);
    return () => stream.close();
  }, [runId, running, queryClient]);

  return live && running;
}
