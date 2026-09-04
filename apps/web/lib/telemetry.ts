'use client';

/**
 * Analytics and error reporting (spec §47, §48).
 *
 * A transport-agnostic seam, not a vendor integration. Events are buffered and
 * flushed in batches; with no `NEXT_PUBLIC_ANALYTICS_URL` configured they are
 * dropped, so development produces no traffic and no console noise.
 *
 * Spec §47 says track product events "while respecting privacy". The rule
 * enforced here: **event properties may never contain message bodies, media,
 * usernames or emails.** Only ids and counts. A telemetry pipeline that
 * accidentally ships chat content is a breach, not a bug.
 */

export type AnalyticsEvent =
  | 'signup_completed' | 'permission_granted' | 'permission_denied'
  | 'friend_added' | 'snap_created' | 'snap_sent' | 'snap_opened'
  | 'message_sent' | 'message_read' | 'voice_message_sent'
  | 'story_posted' | 'story_viewed'
  | 'call_started' | 'call_completed' | 'call_failed';

type Props = Record<string, string | number | boolean | undefined>;

const ENDPOINT = process.env.NEXT_PUBLIC_ANALYTICS_URL;
const queue: { event: string; props: Props; at: string }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

// Keys that must never leave the device, whatever a caller passes.
const FORBIDDEN = /body|text|message|content|email|phone|username|token|password/i;

function scrub(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (FORBIDDEN.test(k)) continue;
    if (typeof v === 'string' && v.length > 64) continue;   // never a payload
    out[k] = v;
  }
  return out;
}

export function track(event: AnalyticsEvent, props: Props = {}) {
  if (!ENDPOINT) return;
  queue.push({ event, props: scrub(props), at: new Date().toISOString() });
  if (queue.length >= 20) return flush();
  timer ??= setTimeout(flush, 10_000);
}

export function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!ENDPOINT || queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  // sendBeacon survives page unload, which is exactly when the last events of a
  // session are generated.
  const payload = JSON.stringify({ events: batch });
  if (navigator.sendBeacon?.(ENDPOINT, new Blob([payload], { type: 'application/json' }))) return;
  void fetch(ENDPOINT, { method: 'POST', body: payload, keepalive: true,
    headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

/**
 * Error reporting. Wire Sentry or similar here; until then errors reach the
 * console rather than being swallowed, which is the correct default.
 */
export function reportError(err: unknown, context: Props = {}) {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[snapx]', message, scrub(context));
  if (!ENDPOINT) return;
  void fetch(ENDPOINT.replace(/\/events$/, '/errors'), {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      stack: err instanceof Error ? err.stack?.slice(0, 2000) : undefined,
      context: scrub(context),
      at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

/** Installs global handlers so nothing fails silently. */
export function installErrorReporting() {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', e => reportError(e.error ?? e.message, { kind: 'uncaught' }));
  window.addEventListener('unhandledrejection', e =>
    reportError(e.reason, { kind: 'unhandled_rejection' }));
  window.addEventListener('pagehide', flush);
}
