import { useEffect, useState, type DependencyList } from 'react';

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
}

/** Runs an async API call when deps change; aborts the previous call. */
export function useApi<T>(fn: (signal: AbortSignal) => Promise<T>, deps: DependencyList): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fn(ac.signal)
      .then((data) => !ac.signal.aborted && setState({ data, loading: false, error: null }))
      .catch((error: Error) => {
        if (!ac.signal.aborted && error.name !== 'AbortError') setState({ data: null, loading: false, error });
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
