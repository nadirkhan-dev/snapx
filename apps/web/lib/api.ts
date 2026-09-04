/**
 * API client.
 *
 * One place that knows about tokens, refresh and error shape, so no component
 * can forget any of them.
 *
 * The access token lives in memory only — not localStorage. An XSS bug can read
 * localStorage, and a token sitting there survives the tab that leaked it. The
 * refresh token is an httpOnly cookie the browser holds and JavaScript cannot
 * touch, so a reload silently re-authenticates without ever exposing a
 * long-lived credential.
 */

export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

let accessToken: string | null = null;
export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;

// A single in-flight refresh, shared. Five parallel 401s must not fire five
// refreshes — that races, and four of them rotate a token another already used,
// which the server correctly treats as theft.
let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!r.ok) return false;
      const data = await r.json();
      if (!data.accessToken) return false;
      setAccessToken(data.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so concurrent callers all observe this result.
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

interface Options { method?: string; body?: unknown; retry?: boolean }

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  const res = await fetch('/api' + path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  // One retry after a successful refresh, then give up — otherwise a revoked
  // session loops forever.
  if (res.status === 401 && opts.retry !== false) {
    if (await refresh()) return api<T>(path, { ...opts, retry: false });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      (data as { message?: string }).message ?? `Request failed (${res.status})`,
      res.status,
      (data as { fields?: Record<string, string> }).fields,
    );
  }
  return data as T;
}

export interface User {
  id: string; username: string; email: string | null; phone: string | null;
  displayName: string; isAdmin: boolean;
}
