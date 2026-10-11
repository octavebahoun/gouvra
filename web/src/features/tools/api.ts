import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client, unwrap, type Schemas } from "@/lib/api/client";

export type Tool = Schemas["ToolOut"];
export type BuiltinTool = Schemas["BuiltinToolOut"];
export type ToolKind = Schemas["ToolCreateIn"]["kind"];
export type ToolTestResult = Schemas["ToolTestOut"];
export type ToolCall = Schemas["ToolCallOut"];

export const toolKeys = {
  builtins: ["tools", "builtins"] as const,
  list: (workspaceId: string) => ["workspaces", workspaceId, "tools"] as const,
  detail: (toolId: string) => ["tools", toolId] as const,
  calls: (toolId: string) => ["tools", toolId, "calls"] as const,
};

export function useBuiltinTools() {
  return useQuery({
    queryKey: toolKeys.builtins,
    queryFn: () => unwrap(client.GET("/api/v1/tools/builtins")),
    staleTime: Infinity,
  });
}

export function useTools(workspaceId: string) {
  return useQuery({
    queryKey: toolKeys.list(workspaceId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/workspaces/{workspace_id}/tools", {
          params: { path: { workspace_id: workspaceId } },
        }),
      ),
  });
}

export function useTool(toolId: string) {
  return useQuery({
    queryKey: toolKeys.detail(toolId),
    queryFn: () =>
      unwrap(client.GET("/api/v1/tools/{tool_id}", { params: { path: { tool_id: toolId } } })),
  });
}

export function useToolCalls(toolId: string) {
  return useQuery({
    queryKey: toolKeys.calls(toolId),
    queryFn: () =>
      unwrap(
        client.GET("/api/v1/tools/{tool_id}/calls", {
          params: { path: { tool_id: toolId }, query: { limit: 50 } },
        }),
      ),
  });
}

function useStore(workspaceId: string) {
  const queryClient = useQueryClient();
  return (tool: Tool) => {
    queryClient.setQueryData(toolKeys.detail(tool.id), tool);
    queryClient.setQueryData<Tool[]>(toolKeys.list(workspaceId), (list) => {
      if (!list) return list;
      const others = list.filter((t) => t.id !== tool.id);
      return [...others, tool].sort((a, b) => a.name.localeCompare(b.name));
    });
  };
}

export function useCreateTool(workspaceId: string) {
  const store = useStore(workspaceId);
  return useMutation({
    mutationFn: (body: Schemas["ToolCreateIn"]) =>
      unwrap(
        client.POST("/api/v1/workspaces/{workspace_id}/tools", {
          params: { path: { workspace_id: workspaceId } },
          body,
        }),
      ),
    onSuccess: store,
  });
}

export function useUpdateTool(workspaceId: string) {
  const store = useStore(workspaceId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Schemas["ToolUpdateIn"] }) =>
      unwrap(client.PATCH("/api/v1/tools/{tool_id}", { params: { path: { tool_id: id } }, body })),
    onSuccess: store,
  });
}

export function useArchiveTool(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(client.DELETE("/api/v1/tools/{tool_id}", { params: { path: { tool_id: id } } })),
    onSuccess: (_, id) => {
      queryClient.setQueryData<Tool[]>(toolKeys.list(workspaceId), (list) =>
        list ? list.filter((t) => t.id !== id) : list,
      );
      void queryClient.invalidateQueries({ queryKey: toolKeys.detail(id) });
    },
  });
}

export function useTestTool(toolId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: Record<string, unknown>) =>
      unwrap(
        client.POST("/api/v1/tools/{tool_id}/test", {
          params: { path: { tool_id: toolId } },
          body: { arguments: args },
        }),
      ),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: toolKeys.calls(toolId) }),
  });
}

type JsonSchema = {
  type?: string | string[];
  description?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  minimum?: number;
};

/** A plausible example value for a JSON Schema: a starting point for the test console. */
export function exampleFor(schema: JsonSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "object": {
      const result: Record<string, unknown> = {};
      const required = new Set(schema.required ?? Object.keys(schema.properties ?? {}));
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        if (required.has(key)) result[key] = exampleFor(value, depth + 1);
      }
      return result;
    }
    case "array":
      return [exampleFor(schema.items, depth + 1)];
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "string": {
      // Descriptions often carry an example ("e.g. Europe/Paris"): the best starting point.
      const hint = /e\.g\.\s*(.+?)\s*$/i.exec(schema.description ?? "");
      if (hint?.[1]) return hint[1];
      if (/iso date/i.test(schema.description ?? "")) return new Date().toISOString().slice(0, 10);
      if (schema.format === "uri") return "https://example.com";
      return "";
    }
    case undefined:
      return {};
    default:
      return null;
  }
}

/** Built-ins that need settings before they can be added (e.g. the hosts an HTTP tool may call). */
export function needsConfig(builtin: BuiltinTool | null | undefined): boolean {
  const properties = (
    builtin?.config_schema as { properties?: Record<string, unknown> } | undefined
  )?.properties;
  return properties !== undefined && Object.keys(properties).length > 0;
}
