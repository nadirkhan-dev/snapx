import {
  Injectable, UnauthorizedException, ConflictException,
  BadRequestException, ForbiddenException, Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Db } from '../database/database.module';
import { loadConfig } from '../config/config';

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }
export interface AuthUser {
  id: string; username: string; email: string | null; phone: string | null;
  displayName: string; isAdmin: boolean;
}

const cfg = loadConfig();
const REFRESH_MS = cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000;

/**
 * Argon2id parameters.
 *
 * argon2 rather than bcrypt: bcrypt silently truncates at 72 bytes and has no
 * memory hardness, so it is far cheaper to attack on a GPU. These settings cost
 * roughly 60–100ms per hash on a modest server, which is the right trade —
 * login is not a hot path, and every millisecond here is a millisecond an
 * attacker pays per guess.
 */
const ARGON = {
  type: argon2.argon2id,
  memoryCost: 19_456,   // 19 MiB — OWASP's current floor
  timeCost: 2,
  parallelism: 1,
} as const;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class AuthService {
  private readonly log = new Logger('Auth');

  constructor(private readonly db: Db, private readonly jwt: JwtService) {}

  /* ------------------------------------------------------------ signup */

  async register(input: {
    username: string; email?: string; phone?: string; password: string;
    displayName: string; dateOfBirth: string;
  }, ctx: { ip?: string; userAgent?: string }) {
    const username = input.username.toLowerCase().trim();

    // Age gate. Checked server-side because a client can send any date.
    const age = yearsSince(input.dateOfBirth);
    if (Number.isNaN(age)) throw new BadRequestException('Enter a valid date of birth');
    if (age < 13) throw new ForbiddenException('You must be at least 13 to use SNAPX');

    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM users
        WHERE username = $1 OR (email IS NOT NULL AND email = $2) OR (phone IS NOT NULL AND phone = $3)`,
      [username, input.email ?? null, input.phone ?? null]);
    if (existing) {
      // Deliberately vague about *which* field collided. Signup is otherwise a
      // free oracle for "does this email have an account here", which matters
      // more on a social app than a generic service.
      throw new ConflictException('That username, email or phone is already taken');
    }

    const passwordHash = await argon2.hash(input.password, ARGON);

    // Account creation touches five tables. A partial account — a user with no
    // profile, or no privacy defaults — is worse to repair than to prevent.
    const user = await this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO users (username, email, phone, password_hash, date_of_birth)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, username, email, phone, is_admin`,
        [username, input.email ?? null, input.phone ?? null, passwordHash, input.dateOfBirth]);
      const u = rows[0];

      await c.query(`INSERT INTO profiles (user_id, display_name) VALUES ($1,$2)`,
        [u.id, input.displayName.trim()]);
      // Privacy-conscious defaults, created eagerly so no code path has to cope
      // with their absence (spec §25).
      await c.query(`INSERT INTO privacy_settings (user_id) VALUES ($1)`, [u.id]);
      await c.query(`INSERT INTO notification_settings (user_id) VALUES ($1)`, [u.id]);
      return u;
    });

    const device = await this.registerDevice(user.id, ctx);
    const tokens = await this.issueTokens(user.id, device.id, ctx.ip);

    return {
      user: await this.publicUser(user.id),
      ...tokens,
    };
  }

  /* ------------------------------------------------------------- login */

  async login(identifier: string, password: string, ctx: { ip?: string; userAgent?: string }) {
    const id = identifier.toLowerCase().trim();

    const row = await this.db.one<{
      id: string; password_hash: string; status: string; suspended_until: string | null;
    }>(`SELECT id, password_hash, status, suspended_until FROM users
         WHERE (username = $1 OR email = $1 OR phone = $2) AND deleted_at IS NULL`,
      [id, identifier.trim()]);

    /* A verification always runs, even with no matching user, so response time
       cannot be used to enumerate accounts. The dummy hash is a real argon2
       digest of a random value, so it costs the same as a genuine check. */
    const ok = await argon2.verify(row?.password_hash ?? DUMMY_HASH, password).catch(() => false);

    if (!row || !ok) throw new UnauthorizedException('Those details do not match an account');

    if (row.status === 'banned') throw new ForbiddenException('This account has been banned');
    if (row.status === 'suspended' && row.suspended_until && new Date(row.suspended_until) > new Date()) {
      throw new ForbiddenException(`This account is suspended until ${row.suspended_until}`);
    }

    await this.db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [row.id]);

    const device = await this.registerDevice(row.id, ctx);
    const tokens = await this.issueTokens(row.id, device.id, ctx.ip);
    return { user: await this.publicUser(row.id), ...tokens };
  }

  /* ----------------------------------------------------------- refresh */

  /**
   * Rotates a refresh token.
   *
   * Every refresh mints a new token and marks the old one as rotated. If a
   * token that was *already* rotated is presented again, it was replayed —
   * either the user's copy or an attacker's, and we cannot tell which. The
   * entire family is revoked, forcing a fresh login. That is the standard
   * response to refresh-token theft and it is why `family_id` exists.
   */
  async refresh(token: string, ctx: { ip?: string }): Promise<TokenPair & { user: AuthUser }> {
    const hash = sha256(token);
    const row = await this.db.one<{
      id: string; user_id: string; device_id: string | null; family_id: string;
      rotated_to: string | null; revoked_at: string | null; expires_at: string;
    }>(`SELECT id, user_id, device_id, family_id, rotated_to, revoked_at, expires_at
          FROM sessions WHERE refresh_token_hash = $1`, [hash]);

    if (!row) throw new UnauthorizedException('Session not found. Sign in again.');

    if (row.rotated_to || row.revoked_at) {
      this.log.warn(`refresh token replay on family ${row.family_id} — revoking family`);
      await this.db.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'token_reuse'
          WHERE family_id = $1 AND revoked_at IS NULL`, [row.family_id]);
      throw new UnauthorizedException('That session is no longer valid. Sign in again.');
    }

    if (new Date(row.expires_at) < new Date()) {
      throw new UnauthorizedException('Session expired. Sign in again.');
    }

    const next = await this.issueTokens(row.user_id, row.device_id, ctx.ip, row.family_id);
    await this.db.query(
      `UPDATE sessions SET rotated_to = (SELECT id FROM sessions WHERE refresh_token_hash = $2)
        WHERE id = $1`, [row.id, sha256(next.refreshToken)]);

    return { ...next, user: (await this.publicUser(row.user_id))! };
  }

  /* ------------------------------------------------------------ logout */

  async logout(refreshToken: string) {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout'
        WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [sha256(refreshToken)]);
    return { ok: true };
  }

  /** "Log out everywhere" (spec §5) — every session on every device. */
  async logoutAll(userId: string) {
    const rows = await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout_all'
        WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [userId]);
    return { ok: true, revoked: rows.length };
  }

  /* ----------------------------------------------------------- helpers */

  private async registerDevice(userId: string, ctx: { ip?: string; userAgent?: string }) {
    const name = describeAgent(ctx.userAgent);
    // One device row per user-agent string, reused across logins so a returning
    // browser does not accumulate entries in "connected devices".
    const found = await this.db.one<{ id: string }>(
      `SELECT id FROM devices WHERE user_id = $1 AND user_agent = $2 AND revoked_at IS NULL`,
      [userId, ctx.userAgent ?? '']);

    if (found) {
      await this.db.query(
        `UPDATE devices SET last_active_at = now(), last_ip = $2 WHERE id = $1`,
        [found.id, ctx.ip ?? null]);
      return found;
    }

    const created = await this.db.one<{ id: string }>(
      `INSERT INTO devices (user_id, platform, name, user_agent, last_ip)
       VALUES ($1,'web',$2,$3,$4) RETURNING id`,
      [userId, name, ctx.userAgent ?? '', ctx.ip ?? null]);
    return created!;
  }

  private async issueTokens(
    userId: string, deviceId: string | null, ip?: string, familyId?: string,
  ): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, typ: 'access' },
      { secret: cfg.JWT_ACCESS_SECRET, expiresIn: cfg.ACCESS_TOKEN_TTL },
    );

    /* The refresh token is opaque random bytes, not a JWT. It is looked up in
       the database on every use anyway, so signing it would add no security and
       would let a holder read its own expiry and user id. */
    const refreshToken = randomBytes(48).toString('base64url');

    await this.db.query(
      `INSERT INTO sessions (user_id, device_id, refresh_token_hash, family_id, expires_at, created_ip)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, deviceId, sha256(refreshToken), familyId ?? randomUUID(),
       new Date(Date.now() + REFRESH_MS), ip ?? null]);

    return { accessToken, refreshToken, expiresIn: ttlSeconds(cfg.ACCESS_TOKEN_TTL) };
  }

  async publicUser(userId: string): Promise<AuthUser> {
    const row = await this.db.one<AuthUser & { display_name: string; is_admin: boolean }>(
      `SELECT u.id, u.username, u.email, u.phone, u.is_admin, p.display_name
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`, [userId]);
    if (!row) throw new UnauthorizedException('Account not found');
    return {
      id: row.id, username: row.username, email: row.email, phone: row.phone,
      displayName: row.display_name, isAdmin: row.is_admin,
    };
  }

  /** Used by the guard on every authenticated request. */
  async verifyAccess(token: string): Promise<{ sub: string }> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; typ: string }>(
        token, { secret: cfg.JWT_ACCESS_SECRET });
      // A refresh token must never be accepted where an access token is meant.
      if (payload.typ !== 'access') throw new Error('wrong token type');
      return payload;
    } catch {
      throw new UnauthorizedException('Your session has expired');
    }
  }

  async listDevices(userId: string) {
    return this.db.query(
      `SELECT d.id, d.name, d.platform, d.last_active_at, d.created_at,
              (SELECT count(*)::int FROM sessions s
                WHERE s.device_id = d.id AND s.revoked_at IS NULL) AS active_sessions
         FROM devices d WHERE d.user_id = $1 AND d.revoked_at IS NULL
        ORDER BY d.last_active_at DESC`, [userId]);
  }

  async revokeDevice(userId: string, deviceId: string) {
    const owned = await this.db.one(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
    if (!owned) throw new UnauthorizedException('No such device');
    await this.db.tx(async c => {
      await c.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'device_revoked'
                      WHERE device_id = $1 AND revoked_at IS NULL`, [deviceId]);
      await c.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [deviceId]);
    });
    return { ok: true };
  }
}

/* A real argon2id digest, so a failed lookup costs the same as a real verify. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c25hcHhkdW1teXNhbHQ$MYyk5Yb3rDoBAY4Cy3EYCWvW0KYFxHmDVDR6Bqvhb8w';

function yearsSince(dob: string): number {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return NaN;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

function ttlSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 900;
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']);
}

/** Human-readable device name for the "connected devices" screen. */
function describeAgent(ua?: string): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium/.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`;
}
