import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isApiError, isNetworkError } from "@/lib/api/errors";

/** Retry only what can succeed on retry: network errors and 5xx — never 4xx. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) return error.status >= 500 && failureCount < 2;
  if (isNetworkError(error)) return failureCount < 3;
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache(),
    mutationCache: new MutationCache(),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}
