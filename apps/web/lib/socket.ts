'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '@/lib/api';

/**
 * The realtime connection.
 *
 * One socket for the whole app, created once and shared. Opening a socket per
 * screen means N connections per user, N presence flips on every navigation,
 * and messages arriving on a socket that just unmounted.
 *
 * Reconnection is socket.io's, with one addition: the access token is
 * short-lived, so a reconnect after it expires must present a fresh one. The
 * `auth` callback is evaluated on every attempt rather than captured once.
 */

let shared: Socket | null = null;

/**
 * The socket connects to the API origin, not the web origin.
 *
 * `io('/rt')` resolves against window.location — the Next.js server — and the
 * rewrite in next.config.mjs only proxies /api/*, so the handshake 404'd and
 * every realtime feature silently did nothing. Nothing errored: socket.io just
 * retried forever while the UI looked fine.
 *
 * Cross-origin is safe here because the socket authenticates with a bearer
 * token in the handshake rather than a cookie, and the API's CORS allow-list
 * already names the web origin.
 */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

function getSocket(): Socket {
  if (shared) return shared;
  shared = io(API_ORIGIN + '/rt', {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    // Evaluated per attempt — a captured token would be stale by the time a
    // long disconnection ends, and every reconnect would then fail silently.
    auth: cb => cb({ token: getAccessToken() ?? '' }),
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });

  /* A socket that fails silently is the worst kind. socket.io retries forever
     without surfacing anything, so a wrong URL or a rejected token presents as
     "realtime features quietly do nothing" — which is exactly what happened
     when this pointed at the web origin instead of the API. */
  shared.on('connect_error', err => {
    console.warn(`[snapx] realtime connection failed: ${err.message} (${API_ORIGIN})`);
  });
  shared.on('disconnect', reason => {
    if (reason === 'io server disconnect') {
      console.warn('[snapx] realtime: server rejected the connection — token expired?');
    }
  });

  return shared;
}

export function closeSocket() {
  shared?.close();
  shared = null;
}

export function useSocket() {
  const [connected, setConnected] = useState(false);
  const socket = useRef<Socket>(null!);

  if (!socket.current) socket.current = getSocket();

  useEffect(() => {
    const s = socket.current;
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    setConnected(s.connected);
    return () => { s.off('connect', onConnect); s.off('disconnect', onDisconnect); };
  }, []);

  /** Subscribes for the lifetime of the calling component. */
  const on = useCallback(<T,>(event: string, handler: (payload: T) => void) => {
    const s = socket.current;
    s.on(event, handler as (...a: unknown[]) => void);
    // Returns void, not the Socket — an effect cleanup that returns a value is
    // a type error, and `s.off()` returns the socket for chaining.
    return () => { s.off(event, handler as (...a: unknown[]) => void); };
  }, []);

  return { socket: socket.current, connected, on };
}

/** Subscribe to one event with automatic cleanup. */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  const { on } = useSocket();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => on<T>(event, p => ref.current(p)), [event, on]);
}
