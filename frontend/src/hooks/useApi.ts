import { useEffect, useState, type DependencyList } from 'react';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

export interface UseApiOptions {
  /** Wait this long after the last deps change before calling (pin dragging, fast clicks). */
  debounceMs?: number;
}

/**
 * Runs an async API call when deps change; aborts the previous call.
 * Data from the previous deps is cleared right away, so the UI never shows
 * e.g. the old point's elevation as if it belonged to the new point.
 */
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList, opts: UseApiOptions = {}): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    const ac = new AbortController();
    setState({ data: null, loading: true, error: null });
    const run = () =>
      fn(ac.signal)
        .then((data) => !ac.signal.aborted && setState({ data, loading: false, error: null }))
        .catch((error: Error) => {
          if (!ac.signal.aborted && error.name !== 'AbortError') setState({ data: null, loading: false, error });
        });
    const timer = opts.debounceMs ? setTimeout(run, opts.debounceMs) : null;
    if (!timer) run();
    return () => {
      if (timer) clearTimeout(timer);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
