import {
  Injectable, BadRequestException, ConflictException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { Db } from '../database/database.module';

/**
 * Friends (spec §16).
 *
 * The state machine, from the caller's point of view:
 *
 *   NONE ──send──▶ REQUESTED ──they accept──▶ FRIENDS ──remove──▶ NONE
 *     ▲               │                          │
 *     └──cancel───────┘                          │
 *   NONE ◀─they send─ PENDING ──accept───────────┘
 *
 * BLOCKED sits outside it entirely: a block severs whatever existed and makes
 * both users invisible to each other. Every method here re-checks the block
 * rather than trusting the UI to have hidden the button (spec §27).
 */

export type FriendState = 'none' | 'requested' | 'pending' | 'friends' | 'blocked' | 'self';

@Injectable()
export class FriendsService {
  constructor(private readonly db: Db) {}

  /** The relationship between two people, as one word. */
  async stateBetween(me: string, other: string): Promise<FriendState> {
    if (me === other) return 'self';

    const row = await this.db.one<{
      blocked: boolean; friends: boolean; outgoing: boolean; incoming: boolean;
    }>(`SELECT
          is_blocked_between($1,$2) AS blocked,
          are_friends($1,$2) AS friends,
          EXISTS (SELECT 1 FROM friend_requests
                   WHERE from_user_id=$1 AND to_user_id=$2 AND status='pending') AS outgoing,
          EXISTS (SELECT 1 FROM friend_requests
                   WHERE from_user_id=$2 AND to_user_id=$1 AND status='pending') AS incoming`,
      [me, other]);

    if (!row) return 'none';
    if (row.blocked) return 'blocked';
    if (row.friends) return 'friends';
    if (row.outgoing) return 'requested';
    if (row.incoming) return 'pending';
    return 'none';
  }

  private async assertReachable(me: string, other: string) {
    if (me === other) throw new BadRequestException('You cannot do that to yourself');

    const target = await this.db.one<{ id: string; who_can_contact: string }>(
      `SELECT u.id, ps.who_can_contact
         FROM users u JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE u.id = $1 AND u.deleted_at IS NULL AND u.status = 'active'`, [other]);
    // 404 rather than 403 for a blocked or missing user — a 403 confirms the
    // account exists, which is precisely what a blocked person wants to learn.
    if (!target) throw new NotFoundException('No such user');

    const blocked = await this.db.one<{ b: boolean }>(
      `SELECT is_blocked_between($1,$2) AS b`, [me, other]);
    if (blocked?.b) throw new NotFoundException('No such user');

    return target;
  }

  /* ------------------------------------------------------------ requests */

  async sendRequest(me: string, other: string) {
    const target = await this.assertReachable(me, other);

    const state = await this.stateBetween(me, other);
    if (state === 'friends') throw new ConflictException('You are already friends');
    if (state === 'requested') throw new ConflictException('You have already asked');

    /* If they already asked us, sending back is the same intent as accepting.
       Making the user go and find the incoming request instead would be
       pedantry — and would leave two pending rows pointing at each other. */
    if (state === 'pending') {
      const incoming = await this.db.one<{ id: string }>(
        `SELECT id FROM friend_requests
          WHERE from_user_id=$1 AND to_user_id=$2 AND status='pending'`, [other, me]);
      return this.accept(me, incoming!.id);
    }

    /* "Friends only" (spec §25) blocks cold requests outright. A
       friends-of-friends allowance would be a reasonable future refinement, but
       it is not implemented — so this refuses rather than pretending to run a
       mutual-connection check it does not have. */
    if (target.who_can_contact === 'friends') {
      throw new ForbiddenException('This account only accepts requests from friends');
    }

    const row = await this.db.one<{ id: string }>(
      `INSERT INTO friend_requests (from_user_id, to_user_id) VALUES ($1,$2)
       RETURNING id`, [me, other]);

    await this.notify(other, 'friend_request', 'sent you a friend request', me);
    return { id: row!.id, state: 'requested' as FriendState };
  }

  async accept(me: string, requestId: string) {
    const req = await this.db.one<{ id: string; from_user_id: string; to_user_id: string; status: string }>(
      `SELECT id, from_user_id, to_user_id, status FROM friend_requests WHERE id = $1`, [requestId]);
    if (!req) throw new NotFoundException('No such request');
    if (req.to_user_id !== me) throw new ForbiddenException('That request is not yours to accept');
    if (req.status !== 'pending') throw new ConflictException(`That request was already ${req.status}`);

    const blocked = await this.db.one<{ b: boolean }>(
      `SELECT is_blocked_between($1,$2) AS b`, [me, req.from_user_id]);
    if (blocked?.b) throw new NotFoundException('No such request');

    /* One transaction: mark the request accepted, create the friendship, and
       cancel any request pointing the other way. A half-applied acceptance
       leaves a pending row that can be accepted a second time. */
    await this.db.tx(async c => {
      await c.query(
        `UPDATE friend_requests SET status='accepted', responded_at=now() WHERE id=$1`, [requestId]);
      await c.query(
        `UPDATE friend_requests SET status='cancelled', responded_at=now()
          WHERE from_user_id=$1 AND to_user_id=$2 AND status='pending'`, [me, req.from_user_id]);
      // Canonical ordering is required by the CHECK on friendships.
      await c.query(
        `INSERT INTO friendships (user_a, user_b) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid))
         ON CONFLICT DO NOTHING`, [me, req.from_user_id]);
    });

    await this.notify(req.from_user_id, 'friend_accepted', 'accepted your friend request', me);
    return { state: 'friends' as FriendState };
  }

  async reject(me: string, requestId: string) {
    const { length } = await this.db.query(
      `UPDATE friend_requests SET status='rejected', responded_at=now()
        WHERE id=$1 AND to_user_id=$2 AND status='pending' RETURNING id`, [requestId, me]);
    if (!length) throw new NotFoundException('No such request');
    // The sender is deliberately not notified. Telling someone they were
    // rejected invites a second attempt; silence is kinder and safer.
    return { state: 'none' as FriendState };
  }

  async cancel(me: string, requestId: string) {
    const { length } = await this.db.query(
      `UPDATE friend_requests SET status='cancelled', responded_at=now()
        WHERE id=$1 AND from_user_id=$2 AND status='pending' RETURNING id`, [requestId, me]);
    if (!length) throw new NotFoundException('No such request');
    return { state: 'none' as FriendState };
  }

  async remove(me: string, other: string) {
    const { length } = await this.db.query(
      `DELETE FROM friendships
        WHERE user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid)
        RETURNING user_a`, [me, other]);
    if (!length) throw new NotFoundException('You are not friends');
    return { state: 'none' as FriendState };
  }

  /* -------------------------------------------------------------- blocks */

  /**
   * Blocking severs everything: the friendship, both pending requests, and any
   * future contact. Enforced at the database level so no endpoint can miss it.
   */
  async block(me: string, other: string) {
    if (me === other) throw new BadRequestException('You cannot block yourself');
    const exists = await this.db.one(`SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL`, [other]);
    if (!exists) throw new NotFoundException('No such user');

    await this.db.tx(async c => {
      await c.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2)
                     ON CONFLICT DO NOTHING`, [me, other]);
      await c.query(`DELETE FROM friendships
                      WHERE user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid)`,
        [me, other]);
      await c.query(`UPDATE friend_requests SET status='cancelled', responded_at=now()
                      WHERE status='pending'
                        AND ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1))`,
        [me, other]);
    });
    return { state: 'blocked' as FriendState };
  }

  async unblock(me: string, other: string) {
    await this.db.query(`DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`, [me, other]);
    // Unblocking does not restore the friendship. It was deleted, and silently
    // re-adding someone you had blocked would be a surprising outcome.
    return { state: 'none' as FriendState };
  }

  async listBlocked(me: string) {
    return this.db.query(
      `SELECT u.id, u.username, p.display_name, b.created_at
         FROM blocks b JOIN users u ON u.id = b.blocked_id
         JOIN profiles p ON p.user_id = u.id
        WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`, [me]);
  }

  /* --------------------------------------------------------------- lists */

  async listFriends(me: string) {
    return this.db.query(
      `SELECT u.id, u.username, p.display_name, p.avatar_media_id, u.last_seen_at,
              ps.show_activity
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
         JOIN profiles p ON p.user_id = u.id
         JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE ($1 IN (f.user_a, f.user_b)) AND u.deleted_at IS NULL
        ORDER BY p.display_name`, [me]);
  }

  async listRequests(me: string) {
    const incoming = await this.db.query(
      `SELECT fr.id, u.id AS user_id, u.username, p.display_name, p.avatar_media_id, fr.created_at
         FROM friend_requests fr
         JOIN users u ON u.id = fr.from_user_id
         JOIN profiles p ON p.user_id = u.id
        WHERE fr.to_user_id = $1 AND fr.status = 'pending'
          AND NOT is_blocked_between($1, fr.from_user_id)
        ORDER BY fr.created_at DESC`, [me]);

    const outgoing = await this.db.query(
      `SELECT fr.id, u.id AS user_id, u.username, p.display_name, fr.created_at
         FROM friend_requests fr
         JOIN users u ON u.id = fr.to_user_id
         JOIN profiles p ON p.user_id = u.id
        WHERE fr.from_user_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC`, [me]);

    return { incoming, outgoing };
  }

  private async notify(userId: string, kind: string, text: string, actorId: string) {
    const actor = await this.db.one<{ display_name: string }>(
      `SELECT display_name FROM profiles WHERE user_id = $1`, [actorId]);
    await this.db.query(
      `INSERT INTO notifications (user_id, kind, title, data)
       VALUES ($1,$2,$3,$4)`,
      [userId, kind, `${actor?.display_name ?? 'Someone'} ${text}`,
       JSON.stringify({ actorId })]);
  }
}
