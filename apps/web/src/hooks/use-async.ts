import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/api.ts";

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and whenever `deps` change; `reload` refetches. Stale responses are dropped. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's list; `tick` reloads.
  useEffect(() => {
    const id = ++latest.current;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (id !== latest.current) return;
        setData(value);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id !== latest.current) return;
        setError(e instanceof ApiError ? e : new ApiError(0, "error", String(e)));
      })
      .finally(() => {
        if (id === latest.current) setLoading(false);
      });
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
