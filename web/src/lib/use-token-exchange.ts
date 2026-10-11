import { useCallback, useEffect, useState } from "react";

export type ExchangeState<T> =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success"; data: T }
  | { status: "error"; error: unknown };

/** One request per token and attempt, even when effects run twice (React Strict Mode). */
const inflight = new Map<string, Promise<unknown>>();

/**
 * Exchange a one-time token (e-mail verification, address change…) as soon as the page opens.
 * Tokens are single-use: the call is deduplicated and never retried automatically; `retry()` is
 * meant for network failures only.
 */
export function useTokenExchange<T>(
  key: string,
  token: string | null,
  exchange: (token: string) => Promise<T>,
): { state: ExchangeState<T>; retry: () => void } {
  const [state, setState] = useState<ExchangeState<T>>(
    token ? { status: "pending" } : { status: "idle" },
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const id = `${key}:${token}:${attempt}`;
    let promise = inflight.get(id) as Promise<T> | undefined;
    if (!promise) {
      promise = exchange(token);
      inflight.set(id, promise);
    }
    promise.then(
      (data) => {
        if (active) setState({ status: "success", data });
      },
      (error: unknown) => {
        if (active) setState({ status: "error", error });
      },
    );
    return () => {
      active = false;
    };
  }, [key, token, attempt, exchange]);

  const retry = useCallback(() => {
    setState({ status: "pending" });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
