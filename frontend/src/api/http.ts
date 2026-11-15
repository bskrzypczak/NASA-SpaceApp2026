import type { ApiErrorBody } from './types';

/**
 * HTTP transport for the HORIZON backend.
 *
 * Why this exists (the "lost requests" bug):
 * - fetch() has no timeout, so a request the backend never answered left the UI on "…" forever.
 * - The same GET was sent several times at once (StrictMode double effects, Explore → Site for the
 *   same point, SiteMap + quick terrain), and every copy queued on the backend behind slow DEM downloads.
 * - A dropped connection or a 502/504 from NASA servers was final; one retry usually succeeds.
 *
 * So: every request has a timeout, identical GETs share one network call, successful GETs are kept
 * for a few minutes, and idempotent GETs retry once on network errors and 502/503/504.
 */

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public field?: string,
    /** Seconds the backend asked us to wait before retrying (upstream errors). */
    public retryAfterS?: number,
  ) {
    super(message);
  }
}

export const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** Default timeouts. Long ones cover the first run on a new site (38 MB DEM window + Horizons). */
export const TIMEOUT = {
  short: 45_000,
  terrain: 150_000,
  horizon: 300_000,
  simulation: 300_000,
  heavy: 420_000,
} as const;

const GET_CACHE_TTL_MS = 5 * 60_000;
const GET_CACHE_MAX = 120;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries after the first attempt. GETs default to 1, POSTs to 0. */
  retries?: number;
}

interface GetOptions<T> extends RequestOptions {
  /** Keep the response in the short-lived cache only if this returns true (e.g. not a partial answer). */
  cacheIf?: (data: T) => boolean;
}

export async function readError(res: Response): Promise<ApiError> {
  let body: (ApiErrorBody & { error: { retryAfterS?: number } }) | null = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return new ApiError(body?.error.code ?? `HTTP_${res.status}`, body?.error.message ?? res.statusText, res.status, body?.error.field, body?.error.retryAfterS);
}

const abortError = () => new DOMException('Aborted', 'AbortError');

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(abortError())), { once: true });
  });
}

/** One network attempt with its own timeout. */
async function attempt<T>(url: URL, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    if (!res.ok) throw await readError(res);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (timedOut) {
      throw new ApiError('CLIENT_TIMEOUT', `No answer from the backend after ${Math.round(timeoutMs / 1000)} s. NASA data services may be slow — try again.`, 0);
    }
    if (signal?.aborted || (e as Error).name === 'AbortError') throw abortError();
    throw new ApiError('NETWORK', `Cannot reach the backend at ${BASE || 'this origin'}. Is it running?`, 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function isRetryable(e: unknown) {
  return e instanceof ApiError && (e.code === 'NETWORK' || (e.status !== undefined && RETRYABLE_STATUS.has(e.status)));
}

async function withRetry<T>(run: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (e) {
      if (i >= retries || !isRetryable(e) || signal?.aborted) throw e;
      const waitS = Math.min(5, Math.max(1, (e as ApiError).retryAfterS ?? 2));
      await sleep(waitS * 1000, signal);
    }
  }
}

/* ---------- GET: cache + shared in-flight requests ---------- */

const cache = new Map<string, { at: number; data: unknown }>();

interface Shared {
  promise: Promise<unknown>;
  ac: AbortController;
  users: number;
}
const inFlight = new Map<string, Shared>();

function remember(key: string, data: unknown) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), data });
  while (cache.size > GET_CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Forget cached GETs (e.g. after the backend restarted). */
export function clearApiCache() {
  cache.clear();
}

export function buildUrl(path: string, params: Record<string, string | number> = {}) {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url;
}

export async function get<T>(path: string, params: Record<string, string | number> = {}, opts: GetOptions<T> = {}): Promise<T> {
  const url = buildUrl(path, params);
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < GET_CACHE_TTL_MS) return hit.data as T;

  // Join an identical request that is already on the wire.
  let shared = inFlight.get(key);
  if (!shared) {
    const ac = new AbortController();
    const timeoutMs = opts.timeoutMs ?? TIMEOUT.short;
    const promise = withRetry(() => attempt<T>(url, {}, timeoutMs, ac.signal), opts.retries ?? 1, ac.signal)
      .then((data) => {
        if (!opts.cacheIf || opts.cacheIf(data)) remember(key, data);
        return data;
      })
      .finally(() => {
        if (inFlight.get(key) === entry) inFlight.delete(key);
      });
    const entry: Shared = { promise, ac, users: 0 };
    shared = entry;
    inFlight.set(key, entry);
  }

  const s = shared;
  s.users++;
  const { signal } = opts;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const leave = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      s.users--;
    };
    const onAbort = () => {
      leave();
      reject(abortError());
      // Cancel the network call only when nobody is waiting for it — checked on the next tick,
      // because React StrictMode (and fast re-renders) abort and re-subscribe in the same tick.
      // Before this fix the re-subscriber joined an already-aborted request and waited forever.
      setTimeout(() => {
        if (s.users > 0) return;
        if (inFlight.get(key) === s) inFlight.delete(key);
        s.ac.abort();
      }, 0);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    s.promise.then(
      (data) => {
        if (settled) return;
        leave();
        resolve(data as T);
      },
      (err) => {
        if (settled) return;
        leave();
        reject(err);
      },
    );
  });
}

export async function post<T>(path: string, payload: unknown, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path);
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  return withRetry(() => attempt<T>(url, init, opts.timeoutMs ?? TIMEOUT.simulation, opts.signal), opts.retries ?? 0, opts.signal);
}
