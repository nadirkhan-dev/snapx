import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Db } from '../database/database.module';

/**
 * Reporting and moderation (spec §28, §29, §30).
 *
 * Two audiences: users file reports, admins act on them. Every admin action is
 * written to an append-only audit log — being able to edit the record of what
 * moderators did defeats the point of keeping one.
 */

const TARGETS = ['user', 'message', 'snap', 'story', 'media', 'group'] as const;
const REASONS = ['spam', 'harassment', 'bullying', 'nudity', 'violence',
  'illegal', 'impersonation', 'copyright', 'other'] as const;

@Injectable()
export class ModerationService {
  constructor(private readonly db: Db) {}

  /* ------------------------------------------------------------ reports */

  async report(reporterId: string, input: {
    targetType: string; targetId: string; reason: string; detail?: string;
  }) {
    if (!TARGETS.includes(input.targetType as typeof TARGETS[number])) {
      throw new BadRequestException('That cannot be reported');
    }
    if (!REASONS.includes(input.reason as typeof REASONS[number])) {
      throw new BadRequestException('Choose a reason');
    }
    if (input.targetType === 'user' && input.targetId === reporterId) {
      throw new BadRequestException('You cannot report yourself');
    }

    /* One open report per person per target. Without this, a frustrated user
       files the same complaint six times and the queue fills with duplicates
       of one incident. */
    const existing = await this.db.one(
      `SELECT id FROM reports
        WHERE reporter_id=$1 AND target_type=$2 AND target_id=$3 AND status IN ('open','reviewing')`,
      [reporterId, input.targetType, input.targetId]);
    if (existing) return { ok: true, alreadyReported: true };

    await this.db.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [reporterId, input.targetType, input.targetId, input.reason, input.detail?.slice(0, 1000) ?? null]);

    return { ok: true };
  }

  /* -------------------------------------------------------------- admin */

  private async assertAdmin(userId: string) {
    const row = await this.db.one<{ is_admin: boolean }>(
      `SELECT is_admin FROM users WHERE id = $1`, [userId]);
    // 404, not 403: an admin console that confirms its own existence to
    // non-admins is a map for anyone probing.
    if (!row?.is_admin) throw new NotFoundException('Not found');
  }

  async queue(adminId: string, status = 'open') {
    await this.assertAdmin(adminId);
    return this.db.query(
      `SELECT r.id, r.target_type, r.target_id, r.reason, r.detail, r.status, r.created_at,
              ru.username AS reporter_username,
              CASE r.target_type
                WHEN 'user' THEN (SELECT username FROM users WHERE id = r.target_id)
                ELSE NULL END AS target_username,
              (SELECT count(*)::int FROM reports r2
                WHERE r2.target_type = r.target_type AND r2.target_id = r.target_id) AS total_reports
         FROM reports r
         LEFT JOIN users ru ON ru.id = r.reporter_id
        WHERE r.status = $1
        ORDER BY total_reports DESC, r.created_at
        LIMIT 100`, [status]);
  }

  async stats(adminId: string) {
    await this.assertAdmin(adminId);
    const [row] = await this.db.query<Record<string, number>>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE deleted_at IS NULL) AS users,
         (SELECT count(*)::int FROM users WHERE last_seen_at > now() - interval '24 hours') AS active_24h,
         (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new_7d,
         (SELECT count(*)::int FROM messages WHERE deleted_at IS NULL) AS messages,
         (SELECT count(*)::int FROM snaps WHERE deleted_at IS NULL) AS snaps,
         (SELECT count(*)::int FROM stories WHERE deleted_at IS NULL AND expires_at > now()) AS live_stories,
         (SELECT count(*)::int FROM reports WHERE status = 'open') AS open_reports,
         (SELECT count(*)::int FROM users WHERE status = 'suspended') AS suspended,
         (SELECT count(*)::int FROM users WHERE status = 'banned') AS banned,
         (SELECT coalesce(sum(byte_size),0)::bigint FROM media WHERE deleted_at IS NULL) AS storage_bytes`);
    return row;
  }

  /**
   * Applies a moderation decision.
   *
   * Every branch writes to `admin_audit_logs` in the same transaction as the
   * effect, so an action can never exist without its record.
   */
  async act(adminId: string, reportId: string, action: string, note?: string) {
    await this.assertAdmin(adminId);

    const report = await this.db.one<{
      id: string; target_type: string; target_id: string; status: string;
    }>(`SELECT id, target_type, target_id, status FROM reports WHERE id = $1`, [reportId]);
    if (!report) throw new NotFoundException('No such report');
    if (!['open', 'reviewing'].includes(report.status)) {
      throw new ForbiddenException(`That report is already ${report.status}`);
    }

    const valid = ['warn', 'remove_content', 'suspend', 'ban', 'dismiss', 'escalate'];
    if (!valid.includes(action)) throw new BadRequestException('Unknown action');

    return this.db.tx(async c => {
      let before: unknown = null, after: unknown = null;

      if (action === 'ban' || action === 'suspend') {
        if (report.target_type !== 'user') {
          throw new BadRequestException('Only a user can be suspended or banned');
        }
        const prev = await c.query(`SELECT status FROM users WHERE id=$1`, [report.target_id]);
        before = prev.rows[0];
        const until = action === 'suspend'
          ? new Date(Date.now() + 7 * 86_400_000) : null;
        await c.query(
          `UPDATE users SET status=$2, suspended_until=$3 WHERE id=$1`,
          [report.target_id, action === 'ban' ? 'banned' : 'suspended', until]);
        // A banned account's sessions die immediately — leaving them valid
        // means the ban takes effect whenever their token happens to expire.
        await c.query(
          `UPDATE sessions SET revoked_at=now(), revoked_reason=$2
            WHERE user_id=$1 AND revoked_at IS NULL`, [report.target_id, action]);
        after = { status: action === 'ban' ? 'banned' : 'suspended' };
      }

      if (action === 'remove_content') {
        const table = { message: 'messages', story: 'stories', snap: 'snaps', media: 'media' }[
          report.target_type as 'message' | 'story' | 'snap' | 'media'];
        if (!table) throw new BadRequestException('That target has no content to remove');
        await c.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [report.target_id]);
        after = { removed: true };
      }

      const resolved = action === 'escalate' ? 'escalated'
        : action === 'dismiss' ? 'dismissed' : 'actioned';
      await c.query(
        `UPDATE reports SET status=$2, resolved_at=now() WHERE id=$1`, [reportId, resolved]);

      await c.query(
        `INSERT INTO moderation_actions (report_id, admin_id, action, target_type, target_id, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [reportId, adminId, action, report.target_type, report.target_id, note ?? null]);

      await c.query(
        `INSERT INTO admin_audit_logs (admin_id, action, entity, entity_id, before, after)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [adminId, `moderation:${action}`, report.target_type, report.target_id,
         before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);

      return { ok: true, status: resolved };
    });
  }

  async auditLog(adminId: string) {
    await this.assertAdmin(adminId);
    return this.db.query(
      `SELECT l.id, l.action, l.entity, l.entity_id, l.before, l.after, l.created_at,
              u.username AS admin_username
         FROM admin_audit_logs l LEFT JOIN users u ON u.id = l.admin_id
        ORDER BY l.created_at DESC LIMIT 200`);
  }

  async listUsers(adminId: string, q?: string) {
    await this.assertAdmin(adminId);
    return this.db.query(
      `SELECT u.id, u.username, u.email, u.status, u.created_at, u.last_seen_at,
              p.display_name, p.friend_count,
              (SELECT count(*)::int FROM reports r
                WHERE r.target_type='user' AND r.target_id = u.id) AS reports_against
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND ($1::text IS NULL OR u.username ILIKE '%'||$1||'%' OR p.display_name ILIKE '%'||$1||'%')
        ORDER BY reports_against DESC, u.created_at DESC LIMIT 100`, [q ?? null]);
  }
}
