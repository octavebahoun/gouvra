import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type WorkflowSummary = Schemas["WorkflowSummary"];
export type Workflow = Schemas["WorkflowOut"];
export type WorkflowVersion = Schemas["WorkflowVersionOut"];
export type Issue = Schemas["WorkflowIssueOut"];
export type WorkflowRun = Schemas["WorkflowRunOut"];
export type WorkflowRunSummary = Schemas["WorkflowRunSummaryOut"];
export type WorkflowStep = Schemas["WorkflowStepOut"];
export type Graph = Schemas["Graph"];
export type GraphNode = Graph["nodes"] extends (infer N)[] | undefined ? N : never;
export type GraphEdge = Schemas["Edge"];
export type NodeType = GraphNode["type"];
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export const workflowKeys = {
  list: (workspaceId: string) => ["workspaces", workspaceId, "workflows"] as const,
  runs: (workspaceId: string, workflowId: string | null) =>
    ["workspaces", workspaceId, "workflow-runs", workflowId ?? "all"] as const,
  detail: (workflowId: string) => ["workflows", workflowId] as const,
  versions: (workflowId: string) => ["workflows", workflowId, "versions"] as const,
  run: (runId: string) => ["workflow-runs", runId] as const,
};

export function asGraph(value: unknown): Graph {
  const graph = (value ?? {}) as Partial<Graph>;
  return { nodes: graph.nodes ?? [], edges: graph.edges ?? [], settings: graph.settings };
}

export function isRunning(status: string | undefined): boolean {
  return status === "running";
}

export function useWorkflows(workspaceId: string, includeArchived = false) {
  return useQuery({
    queryKey: [...workflowKeys.list(workspaceId), includeArchived],
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/workflows", {
          params: {
            path: { workspace_id: workspaceId },
            query: { include_archived: includeArchived },
          },
        }),
      ),
  });
}

export function useWorkflow(workflowId: string) {
  return useQuery({
    queryKey: workflowKeys.detail(workflowId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workflows/{workflow_id}", {
          params: { path: { workflow_id: workflowId } },
        }),
      ),
    // The editor owns the draft once loaded: never overwrite it behind the user's back.
    refetchOnWindowFocus: false,
  });
}

export function useVersions(workflowId: string, enabled = true) {
  return useQuery({
    queryKey: workflowKeys.versions(workflowId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workflows/{workflow_id}/versions", {
          params: { path: { workflow_id: workflowId } },
        }),
      ),
    enabled,
  });
}

export function useWorkflowRuns(workspaceId: string, workflowId: string | null = null, limit = 20) {
  return useQuery({
    queryKey: [...workflowKeys.runs(workspaceId, workflowId), limit],
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/workflow-runs", {
          params: {
            path: { workspace_id: workspaceId },
            query: { workflow_id: workflowId, limit },
          },
        }),
      ),
    select: (page) => page.data,
    // Runs in progress move on their own: keep the list fresh while one is running.
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => isRunning(run.status)) ? 2000 : false,
  });
}

export function useWorkflowRun(runId: string) {
  return useQuery({
    queryKey: workflowKeys.run(runId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/workflow-runs/{run_id}", { params: { path: { run_id: runId } } })),
  });
}

function useInvalidateWorkflows(workspaceId: string) {
  const queryClient = useQueryClient();
  return (workflowId?: string) => {
    void queryClient.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    if (workflowId) {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.versions(workflowId) });
    }
  };
}

export function useCreateWorkflow(workspaceId: string) {
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["WorkflowCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/workflows", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: () => invalidate(),
  });
}

/** Saves the draft; the caller handles conflicts (409) and keeps the editor's state. */
export function useSaveDraft(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["WorkflowDraftIn"]) =>
      unwrap(
        client.PUT("/api/v1/workflows/{workflow_id}/draft", {
          params: { path: { workflow_id: workflowId } },
          body,
        }),
      ),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflowId), workflow);
    },
  });
}

export function useUpdateWorkflow(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["WorkflowUpdateIn"]) =>
      unwrap(
        client.PATCH("/api/v1/workflows/{workflow_id}", {
          params: { path: { workflow_id: workflowId } },
          body,
        }),
      ),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflowId), workflow);
      invalidate();
    },
  });
}

export function usePublish(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: (note: string | null) =>
      unwrap(
        client.POST("/api/v1/workflows/{workflow_id}/publish", {
          params: { path: { workflow_id: workflowId } },
          body: { note },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
      invalidate(workflowId);
    },
  });
}

export function useRestoreVersion(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: (number: number) =>
      unwrap(
        client.POST("/api/v1/workflows/{workflow_id}/versions/{number}/restore", {
          params: { path: { workflow_id: workflowId, number } },
        }),
      ),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflowId), workflow);
      invalidate(workflowId);
    },
  });
}

export function useArchiveWorkflow(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: (archived: boolean) =>
      unwrap(
        archived
          ? client.POST("/api/v1/workflows/{workflow_id}/archive", {
              params: { path: { workflow_id: workflowId } },
            })
          : client.POST("/api/v1/workflows/{workflow_id}/restore", {
              params: { path: { workflow_id: workflowId } },
            }),
      ),
    onSuccess: (workflow) => {
      queryClient.setQueryData(workflowKeys.detail(workflowId), workflow);
      invalidate();
    },
  });
}

export function useDeleteWorkflow(workspaceId: string, workflowId: string) {
  const invalidate = useInvalidateWorkflows(workspaceId);
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.DELETE("/api/v1/workflows/{workflow_id}", {
          params: { path: { workflow_id: workflowId } },
        }),
      ),
    onSuccess: () => invalidate(),
  });
}

export function useStartRun(workspaceId: string, workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["WorkflowRunCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workflows/{workflow_id}/runs", {
          params: { path: { workflow_id: workflowId } },
          body,
        }),
      ),
    onSuccess: (run) => {
      queryClient.setQueryData(workflowKeys.run(run.id), run);
      void queryClient.invalidateQueries({
        queryKey: ["workspaces", workspaceId, "workflow-runs"],
      });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function useCancelRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.POST("/api/v1/workflow-runs/{run_id}/cancel", {
          params: { path: { run_id: runId } },
        }),
      ),
    onSuccess: (run) => queryClient.setQueryData(workflowKeys.run(runId), run),
  });
}
