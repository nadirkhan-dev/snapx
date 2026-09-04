import { createHmac } from 'node:crypto';

/**
 * Ephemeral TURN credentials.
 *
 * Static TURN credentials in a client bundle are a bandwidth account anyone can
 * take. Once extracted they work until you rotate them by hand — and you find
 * out from the bill.
 *
 * The fix is the long-standing TURN REST API convention (draft-uberti-behave-
 * turn-rest-00, which coturn, Twilio, Cloudflare and metered all implement):
 *
 *   username  = <unix-expiry-timestamp>:<user-id>
 *   password  = base64(HMAC-SHA1(shared-secret, username))
 *
 * The TURN server recomputes the same HMAC with the shared secret it already
 * has, so it needs no database and no per-user provisioning. The credential
 * stops working at the timestamp baked into its own username. The shared secret
 * never leaves the server.
 *
 * HMAC-SHA1 is not a choice — it is what the convention specifies and what
 * every TURN server verifies against. It is a MAC over a public string with a
 * secret key, not a password hash, so SHA-1's collision weaknesses do not apply.
 */

export interface TurnCredential {
  urls: string[];
  username: string;
  credential: string;
  /** Seconds until this credential stops working, for client-side refresh. */
  ttl: number;
}

/** Long enough for a call to start and run; short enough that a leak decays. */
const DEFAULT_TTL_SEC = 12 * 3600;

export function makeTurnCredential(opts: {
  urls: string[];
  secret: string;
  userId: string;
  ttlSec?: number;
}): TurnCredential {
  const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC;
  const expiry = Math.floor(Date.now() / 1000) + ttl;

  // The user id is embedded so abuse can be traced to an account, and so two
  // users never share a credential.
  const username = `${expiry}:${opts.userId}`;
  const credential = createHmac('sha1', opts.secret).update(username).digest('base64');

  return { urls: opts.urls, username, credential, ttl };
}

/**
 * Verifies a credential the way a TURN server would.
 *
 * Not used in the request path — TURN does this itself. It exists so the test
 * suite can prove the credentials we mint are actually valid and actually
 * expire, rather than asserting the shape of a string.
 */
export function verifyTurnCredential(
  username: string, credential: string, secret: string,
): { valid: boolean; reason?: string } {
  const [expiryStr, userId] = username.split(':');
  const expiry = Number(expiryStr);

  if (!expiryStr || !userId || Number.isNaN(expiry)) {
    return { valid: false, reason: 'malformed username' };
  }
  if (expiry * 1000 < Date.now()) return { valid: false, reason: 'expired' };

  const expected = createHmac('sha1', secret).update(username).digest('base64');
  if (expected !== credential) return { valid: false, reason: 'bad signature' };

  return { valid: true };
}
