import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Integration test harness.
 *
 * These run against a live server and a real database on purpose. The bugs this
 * project actually hit — a dropped SDP offer, a cookie scoped to the wrong
 * path, a sweeper that was never scheduled — are all invisible to a unit test
 * with a mocked database.
 */
export const API = process.env.TEST_API ?? 'http://localhost:4000/api';
export const PASSWORD = 'snapx-demo-2026';

export async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${API}/auth/me`);
      if (r.status === 401) return true;      // up, and the guard works
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error(`server never came up at ${API}`);
}

export async function token(username, password = PASSWORD) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
  });
  const body = await r.json();
  if (!body.accessToken) throw new Error(`login failed for ${username}: ${body.message}`);
  return body.accessToken;
}

export async function call(tok, path, opts = {}) {
  const r = await fetch(API + path, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': opts.contentType ?? 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: r.status, body };
}

export const me = async tok => (await call(tok, '/auth/me')).body;

/** A real 1×1 PNG, so magic-byte sniffing has something genuine to identify. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

export async function upload(tok, buf = PNG, type = 'image/png') {
  const r = await fetch(`${API}/media/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': type },
    body: buf,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
