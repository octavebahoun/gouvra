import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Suite = Schemas["SuiteOut"];
export type Case = Schemas["CaseOut"];
export type Run = Schemas["RunOut"];
export type RunDetail = Schemas["RunDetailOut"];
export type Result = Schemas["ResultOut"];
export type Comparison = Schemas["ComparisonOut"];
export type GraderSpec = NonNullable<Schemas["SuiteCreateIn"]["default_graders"]>[number];
export type GraderType = NonNullable<GraderSpec["type"]>;

export const evaluationKeys = {
  suites: (workspaceId: string) => ["workspaces", workspaceId, "evaluations", "suites"] as const,
  runs: (workspaceId: string, suiteId: string | null) =>
    ["workspaces", workspaceId, "evaluations", "runs", suiteId ?? "all"] as const,
  suite: (suiteId: string) => ["evaluations", "suites", suiteId] as const,
  cases: (suiteId: string) => ["evaluations", "suites", suiteId, "cases"] as const,
  run: (runId: string) => ["evaluations", "runs", runId] as const,
  compare: (base: string, candidate: string) =>
    ["evaluations", "compare", base, candidate] as const,
};

export function useSuites(workspaceId: string) {
  return useQuery({
    queryKey: evaluationKeys.suites(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/evaluations/suites", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
  });
}

export function useRuns(workspaceId: string, suiteId: string | null = null, limit = 25) {
  return useQuery({
    queryKey: [...evaluationKeys.runs(workspaceId, suiteId), limit],
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/evaluations/runs", {
          params: { path: { workspace_id: workspaceId }, query: { suite_id: suiteId, limit } },
        }),
      ),
    select: (page) => page.data,
    // Runs in progress move on their own: keep the list fresh while one is running.
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => run.status === "running") ? 2500 : false,
  });
}

export function useSuite(suiteId: string) {
  return useQuery({
    queryKey: evaluationKeys.suite(suiteId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/evaluations/suites/{suite_id}", {
          params: { path: { suite_id: suiteId } },
        }),
      ),
  });
}

export function useCases(suiteId: string) {
  return useQuery({
    queryKey: evaluationKeys.cases(suiteId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/evaluations/suites/{suite_id}/cases", {
          params: { path: { suite_id: suiteId } },
        }),
      ),
  });
}

export function useRun(runId: string) {
  return useQuery({
    queryKey: evaluationKeys.run(runId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/evaluations/runs/{run_id}", { params: { path: { run_id: runId } } }),
      ),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
  });
}

export function useComparison(base: string | null, candidate: string | null) {
  return useQuery({
    queryKey: evaluationKeys.compare(base ?? "", candidate ?? ""),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/evaluations/compare", {
          params: { query: { base: base ?? "", candidate: candidate ?? "" } },
        }),
      ),
    enabled: Boolean(base && candidate && base !== candidate),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data &&
      (query.state.data.base.status === "running" ||
        query.state.data.candidate.status === "running")
        ? 2000
        : false,
  });
}

function useInvalidateSuite(workspaceId: string) {
  const queryClient = useQueryClient();
  return (suiteId?: string) => {
    void queryClient.invalidateQueries({ queryKey: evaluationKeys.suites(workspaceId) });
    if (suiteId) {
      void queryClient.invalidateQueries({ queryKey: evaluationKeys.suite(suiteId) });
      void queryClient.invalidateQueries({ queryKey: evaluationKeys.cases(suiteId) });
    }
  };
}

export function useCreateSuite(workspaceId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["SuiteCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/evaluations/suites", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: (suite) => invalidate(suite.id),
  });
}

export function useUpdateSuite(workspaceId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["SuiteUpdateIn"] }) =>
      unwrap(
        client.PATCH("/api/v1/evaluations/suites/{suite_id}", {
          params: { path: { suite_id: id } },
          body,
        }),
      ),
    onSuccess: (suite) => invalidate(suite.id),
  });
}

export function useArchiveSuite(workspaceId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.DELETE("/api/v1/evaluations/suites/{suite_id}", {
          params: { path: { suite_id: id } },
        }),
      ),
    onSuccess: (_, id) => invalidate(id),
  });
}

export function useSaveCase(workspaceId: string, suiteId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Schemas["CaseIn"] }) =>
      id
        ? unwrap(
            client.PATCH("/api/v1/evaluations/cases/{case_id}", {
              params: { path: { case_id: id } },
              body,
            }),
          )
        : unwrap(
            client.POST("/api/v1/evaluations/suites/{suite_id}/cases", {
              params: { path: { suite_id: suiteId } },
              body,
            }),
          ),
    onSuccess: () => invalidate(suiteId),
  });
}

export function useDeleteCase(workspaceId: string, suiteId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.DELETE("/api/v1/evaluations/cases/{case_id}", { params: { path: { case_id: id } } }),
      ),
    onSuccess: () => invalidate(suiteId),
  });
}

export function useImportCases(workspaceId: string, suiteId: string) {
  const invalidate = useInvalidateSuite(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["CaseImportIn"]) =>
      unwrap(
        client.POST("/api/v1/evaluations/suites/{suite_id}/cases/import", {
          params: { path: { suite_id: suiteId } },
          body,
        }),
      ),
    onSuccess: () => invalidate(suiteId),
  });
}

export function useStartRun(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Schemas["RunCreateIn"]) =>
      unwrap(client.POST("/api/v1/evaluations/runs", { body })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "evaluations"] });
    },
  });
}

export function useCancelRun(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        client.POST("/api/v1/evaluations/runs/{run_id}/cancel", {
          params: { path: { run_id: id } },
        }),
      ),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: evaluationKeys.run(run.id) });
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "evaluations"] });
    },
  });
}

export function usePreviewGrader() {
  return useMutation({
    mutationFn: (body: Schemas["GraderPreviewIn"]) =>
      unwrap(client.POST("/api/v1/evaluations/graders/preview", { body })),
  });
}

export const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${Math.round(value * 100)}%`;
