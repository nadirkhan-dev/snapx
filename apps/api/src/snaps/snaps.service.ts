import {
  Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger,
} from '@nestjs/common';
import { Db } from '../database/database.module';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.module';

/**
 * Snaps (spec §9, §10).
 *
 * The rule that governs everything here: **expiry is decided by the server**.
 * The client is told how many seconds to display something, but the countdown
 * that matters runs against `expires_at` in the database. A client-controlled
 * timer is not a timer — it is a suggestion, and the first person to open the
 * network tab ignores it.
 *
 * The honest limit, stated plainly because the spec asks for it (§10): none of
 * this stops a recipient photographing their screen with another device. Server
 * expiry makes the media unfetchable afterwards; it does not make it unseen.
 */

const MAX_RECIPIENTS = 32;
const REPLAY_LIMIT = 1;          // one replay per snap, the familiar convention
// After opening, media stays reachable for the display duration plus a margin
// that covers a slow connection. Without it, a 3-second snap on a poor network
// expires before the first frame paints.
const OPEN_GRACE_SEC = 10;
// An unopened snap does not live forever. This is what stops the storage bill
// growing without bound and matches the "temporary" promise.
const UNOPENED_TTL_HOURS = 24;

export type SnapStatus = 'sending' | 'sent' | 'delivered' | 'opened' | 'expired' | 'failed';

@Injectable()
export class SnapsService {
  private readonly log = new Logger('Snaps');

  constructor(
    private readonly db: Db,
    private readonly media: MediaService,
    private readonly storage: StorageService,
  ) {}

  /* ---------------------------------------------------------------- send */

  async send(senderId: string, input: {
    mediaId: string; recipientIds: string[]; durationSec?: number;
  }) {
    const recipients = [...new Set(input.recipientIds)].filter(id => id !== senderId);
    if (!recipients.length) throw new BadRequestException('Choose at least one person');
    if (recipients.length > MAX_RECIPIENTS) {
      throw new BadRequestException(`You can send to at most ${MAX_RECIPIENTS} people at once`);
    }

    // The sender must own the media. Without this, anyone could send a snap of
    // any media id they could guess.
    const media = await this.media.authorise(senderId, input.mediaId);
    if (media.owner_id !== senderId) {
      throw new ForbiddenException('You can only send media you captured');
    }

    /* Recipients must be friends and not blocked. Checked in one query rather
       than a loop: a per-recipient round trip is both slower and easier to get
       subtly wrong when one of them fails. */
    const allowed = await this.db.query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.id = ANY($2::uuid[])
          AND u.deleted_at IS NULL AND u.status = 'active'
          AND are_friends($1, u.id)
          AND NOT is_blocked_between($1, u.id)`, [senderId, recipients]);

    if (!allowed.length) {
      throw new ForbiddenException('You can only send snaps to friends');
    }

    const duration = Math.min(60, Math.max(1, input.durationSec ?? 5));
    const type = media.mime_type.startsWith('video') ? 'video' : 'photo';
    const unopenedExpiry = new Date(Date.now() + UNOPENED_TTL_HOURS * 3_600_000);

    const snapId = await this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO snaps (sender_id, media_id, type, duration_sec)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [senderId, input.mediaId, type, duration]);
      const id = rows[0].id;

      for (const r of allowed) {
        await c.query(
          `INSERT INTO snap_recipients (snap_id, recipient_id, status, delivered_at, expires_at)
           VALUES ($1,$2,'delivered',now(),$3)`, [id, r.id, unopenedExpiry]);
        await c.query(
          `INSERT INTO notifications (user_id, kind, title, data)
           VALUES ($1,'snap_new',
             (SELECT display_name FROM profiles WHERE user_id=$2) || ' sent you a snap',
             $3)`,
          [r.id, senderId, JSON.stringify({ snapId: id, senderId })]);
      }
      return id;
    });

    const skipped = recipients.length - allowed.length;
    return {
      id: snapId,
      sentTo: allowed.length,
      // Surfaced rather than silently swallowed: if someone unfriended you,
      // you should know your snap did not reach them.
      skipped: skipped > 0 ? skipped : undefined,
      expiresAt: unopenedExpiry,
    };
  }

  /* ------------------------------------------------------------- inbox */

  async inbox(userId: string) {
    /* Unopened snaps first — that is the queue people actually work through.
       Opened-but-unexpired ones remain visible so a replay is still possible. */
    return this.db.query(
      `SELECT sr.id, s.id AS snap_id, s.type, s.duration_sec,
              sr.status, sr.delivered_at, sr.opened_at, sr.expires_at, sr.replay_count,
              u.id AS sender_id, u.username, p.display_name, p.avatar_media_id
         FROM snap_recipients sr
         JOIN snaps s ON s.id = sr.snap_id
         JOIN users u ON u.id = s.sender_id
         JOIN profiles p ON p.user_id = u.id
        WHERE sr.recipient_id = $1
          AND sr.status <> 'expired'
          AND s.deleted_at IS NULL
          AND (sr.expires_at IS NULL OR sr.expires_at > now())
          AND NOT is_blocked_between($1, s.sender_id)
        ORDER BY (sr.status = 'opened'), sr.delivered_at DESC
        LIMIT 100`, [userId]);
  }

  /** What the sender sees: who has opened what. */
  async sent(userId: string) {
    return this.db.query(
      `SELECT s.id, s.type, s.created_at,
              count(sr.id)::int AS recipients,
              count(sr.opened_at)::int AS opened
         FROM snaps s
         LEFT JOIN snap_recipients sr ON sr.snap_id = s.id
        WHERE s.sender_id = $1 AND s.deleted_at IS NULL
        GROUP BY s.id ORDER BY s.created_at DESC LIMIT 50`, [userId]);
  }

  /* -------------------------------------------------------------- open */

  /**
   * Opens a snap and starts its clock.
   *
   * The first open is what sets `expires_at`; re-opening within the window is a
   * replay, capped at REPLAY_LIMIT. The signed media URL is deliberately issued
   * for only as long as the snap has left to live, so the URL dies with it —
   * handing out a 15-minute URL for a 3-second snap would make the expiry
   * decorative.
   */
  async open(userId: string, recipientRowId: string) {
    const row = await this.db.one<{
      id: string; snap_id: string; media_id: string; sender_id: string;
      duration_sec: number; status: SnapStatus; opened_at: string | null;
      expires_at: string | null; replay_count: number;
    }>(`SELECT sr.id, sr.snap_id, s.media_id, s.sender_id, s.duration_sec,
               sr.status, sr.opened_at, sr.expires_at, sr.replay_count
          FROM snap_recipients sr JOIN snaps s ON s.id = sr.snap_id
         WHERE sr.id = $1 AND sr.recipient_id = $2 AND s.deleted_at IS NULL`,
      [recipientRowId, userId]);

    if (!row) throw new NotFoundException('That snap is no longer available');

    const blocked = await this.db.one<{ b: boolean }>(
      `SELECT is_blocked_between($1,$2) AS b`, [userId, row.sender_id]);
    if (blocked?.b) throw new NotFoundException('That snap is no longer available');

    const now = Date.now();
    const expired = row.status === 'expired'
      || (row.expires_at !== null && new Date(row.expires_at).getTime() <= now);
    if (expired) {
      await this.db.query(`UPDATE snap_recipients SET status='expired' WHERE id=$1`, [row.id]);
      throw new NotFoundException('That snap has expired');
    }

    const isReplay = row.opened_at !== null;
    if (isReplay && row.replay_count >= REPLAY_LIMIT) {
      throw new ForbiddenException('You have already replayed this snap');
    }

    const windowSec = row.duration_sec + OPEN_GRACE_SEC;
    const expiresAt = new Date(now + windowSec * 1000);

    await this.db.query(
      `UPDATE snap_recipients
          SET status='opened',
              opened_at = COALESCE(opened_at, now()),
              expires_at = $2,
              replay_count = replay_count + $3
        WHERE id = $1`,
      [row.id, expiresAt, isReplay ? 1 : 0]);

    // Tell the sender it was opened — that feedback is half the point.
    if (!isReplay) {
      await this.db.query(
        `INSERT INTO notifications (user_id, kind, title, data)
         VALUES ($1,'snap_opened',
           (SELECT display_name FROM profiles WHERE user_id=$2) || ' opened your snap',
           $3)`,
        [row.sender_id, userId, JSON.stringify({ snapId: row.snap_id })]);
    }

    const media = await this.media.authorise(userId, row.media_id);
    return {
      id: row.id,
      snapId: row.snap_id,
      durationSec: row.duration_sec,
      isReplay,
      replaysLeft: REPLAY_LIMIT - (row.replay_count + (isReplay ? 1 : 0)),
      expiresAt,
      mimeType: media.mime_type,
      url: await this.storage.signedUrl(media.storage_key, windowSec),
    };
  }

  /* ----------------------------------------------------------- cleanup */

  /**
   * Expires everything past its window and removes media nobody can reach.
   *
   * Run on a schedule. Deliberately idempotent and batched: a cleanup job that
   * cannot be safely re-run is a cleanup job nobody dares run.
   */
  async runCleanup(): Promise<{ expired: number; purged: number }> {
    const expired = await this.db.query<{ id: string }>(
      `UPDATE snap_recipients SET status='expired'
        WHERE status <> 'expired' AND expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id`);

    /* Media is purged only when every recipient has expired AND it is not
       referenced anywhere else — a story, a message, or the sender's Memories.
       Deleting bytes still reachable through another feature is the failure
       that turns a cleanup job into an incident. */
    const orphans = await this.db.query<{ id: string; storage_key: string }>(
      `SELECT m.id, m.storage_key
         FROM media m
        WHERE m.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM snaps s WHERE s.media_id = m.id)
          AND NOT EXISTS (
            SELECT 1 FROM snaps s JOIN snap_recipients sr ON sr.snap_id = s.id
             WHERE s.media_id = m.id AND sr.status <> 'expired')
          AND NOT EXISTS (SELECT 1 FROM stories st
                           WHERE st.media_id = m.id AND st.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM messages msg
                           WHERE msg.media_id = m.id AND msg.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM memories mem
                           WHERE mem.media_id = m.id AND mem.deleted_at IS NULL)
        LIMIT 500`);

    let purged = 0;
    for (const o of orphans) {
      try {
        await this.storage.remove(o.storage_key);
        await this.db.query(
          `UPDATE media SET deleted_at = now(), status = 'removed' WHERE id = $1`, [o.id]);
        purged++;
      } catch (err) {
        // A storage failure must not abort the batch; the row stays and the
        // next run retries it.
        this.log.warn(`could not purge ${o.id}: ${(err as Error).message}`);
      }
    }

    if (expired.length || purged) {
      this.log.log(`cleanup: expired ${expired.length}, purged ${purged} media`);
    }
    return { expired: expired.length, purged };
  }
}
