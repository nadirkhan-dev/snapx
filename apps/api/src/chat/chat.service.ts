import {
  Injectable, BadRequestException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { Db } from '../database/database.module';
import { MediaService } from '../media/media.service';

/**
 * Chat (spec §11).
 *
 * Design notes worth knowing:
 *
 * **Read state is one row per member, not one per message per user.** A
 * `last_read_at` timestamp on `conversation_members` answers "how many unread"
 * with a single comparison, where a read-receipt table would need a row for
 * every message every person has seen — millions of rows to express something a
 * timestamp already implies.
 *
 * **Messages carry a client nonce.** A retry after a dropped connection would
 * otherwise duplicate the message, and on a flaky mobile network that is not an
 * edge case, it is Tuesday. The unique index on (sender_id, client_nonce) makes
 * the second insert a no-op the server can detect and answer idempotently.
 */

const PAGE_SIZE = 40;

export interface SendInput {
  conversationId?: string;
  toUserId?: string;                 // start-or-reuse a direct conversation
  type: 'text' | 'image' | 'video' | 'voice' | 'snap';
  body?: string;
  mediaId?: string;
  replyToId?: string;
  clientNonce?: string;
}

@Injectable()
export class ChatService {
  constructor(private readonly db: Db, private readonly media: MediaService) {}

  /* ------------------------------------------------------- conversations */

  /**
   * Finds or creates the direct conversation between two people.
   *
   * "Find or create" rather than "create": two people must never end up with
   * two parallel threads, which is what happens when both tap each other's
   * profile at the same moment.
   */
  async directWith(me: string, other: string): Promise<string> {
    if (me === other) throw new BadRequestException('You cannot message yourself');

    const blocked = await this.db.one<{ b: boolean }>(
      `SELECT is_blocked_between($1,$2) AS b`, [me, other]);
    if (blocked?.b) throw new NotFoundException('No such user');

    const friends = await this.db.one<{ f: boolean }>(`SELECT are_friends($1,$2) AS f`, [me, other]);
    const privacy = await this.db.one<{ who_can_contact: string }>(
      `SELECT who_can_contact FROM privacy_settings WHERE user_id = $1`, [other]);
    if (!friends?.f && privacy?.who_can_contact === 'friends') {
      throw new ForbiddenException('You can only message friends');
    }

    const existing = await this.db.one<{ id: string }>(
      `SELECT c.id FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
        WHERE c.type = 'direct' AND c.deleted_at IS NULL
        LIMIT 1`, [me, other]);
    if (existing) return existing.id;

    return this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO conversations (type, created_by) VALUES ('direct',$1) RETURNING id`, [me]);
      const id = rows[0].id;
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`,
        [id, me, other]);
      return id;
    });
  }

  async createGroup(me: string, title: string, memberIds: string[]) {
    const members = [...new Set(memberIds)].filter(id => id !== me);
    if (!members.length) throw new BadRequestException('Add at least one other person');

    // Only friends can be added, and only ones who have not blocked you.
    const allowed = await this.db.query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.id = ANY($2::uuid[]) AND u.deleted_at IS NULL
          AND are_friends($1, u.id) AND NOT is_blocked_between($1, u.id)`, [me, members]);
    if (!allowed.length) throw new ForbiddenException('You can only add friends to a group');

    return this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO conversations (type, title, created_by) VALUES ('group',$1,$2) RETURNING id`,
        [title.trim().slice(0, 60) || 'New group', me]);
      const id = rows[0].id;
      await c.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'owner')`,
        [id, me]);
      for (const m of allowed) {
        await c.query(
          `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)`, [id, m.id]);
      }
      return { id, members: allowed.length + 1 };
    });
  }

  /** The conversation list: last message, unread count, and who the other person is. */
  async listConversations(me: string) {
    return this.db.query(
      `SELECT c.id, c.type, c.title, c.last_message_at, c.disappear_after_sec,
              (SELECT count(*)::int FROM messages m
                WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                  AND m.sender_id <> $1
                  AND (cm.last_read_at IS NULL OR m.created_at > cm.last_read_at)) AS unread,
              (SELECT json_build_object('type', m.type, 'body', m.body,
                                        'senderId', m.sender_id, 'createdAt', m.created_at)
                 FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT json_agg(json_build_object(
                        'id', u.id, 'username', u.username,
                        'displayName', p.display_name, 'avatarMediaId', p.avatar_media_id))
                 FROM conversation_members om
                 JOIN users u ON u.id = om.user_id
                 JOIN profiles p ON p.user_id = u.id
                WHERE om.conversation_id = c.id AND om.user_id <> $1 AND om.left_at IS NULL
              ) AS others
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1
        WHERE cm.left_at IS NULL AND c.deleted_at IS NULL
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 60`, [me]);
  }

  private async assertMember(me: string, conversationId: string) {
    const row = await this.db.one<{ disappear_after_sec: number | null }>(
      `SELECT c.disappear_after_sec
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL AND c.deleted_at IS NULL`,
      [conversationId, me]);
    if (!row) throw new NotFoundException('No such conversation');
    return row;
  }

  /* ----------------------------------------------------------- messages */

  async listMessages(me: string, conversationId: string, before?: string) {
    await this.assertMember(me, conversationId);
    const rows = await this.db.query(
      `SELECT m.id, m.type, m.body, m.media_id, m.snap_id, m.reply_to_id,
              m.sender_id, m.created_at, m.edited_at, m.expires_at,
              u.username, p.display_name,
              (SELECT json_agg(json_build_object('emoji', r.emoji, 'userId', r.user_id))
                 FROM message_reactions r WHERE r.message_id = m.id) AS reactions
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         LEFT JOIN profiles p ON p.user_id = m.sender_id
        WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
          -- A disappearing message is gone for everyone the moment it lapses,
          -- filtered here so no client can render an expired one.
          AND (m.expires_at IS NULL OR m.expires_at > now())
          AND ($2::timestamptz IS NULL OR m.created_at < $2)
        ORDER BY m.created_at DESC
        LIMIT $3`, [conversationId, before ?? null, PAGE_SIZE]);
    // Newest-first for pagination, oldest-first for rendering.
    return rows.reverse();
  }

  async send(me: string, input: SendInput) {
    const conversationId = input.conversationId
      ?? (input.toUserId ? await this.directWith(me, input.toUserId) : null);
    if (!conversationId) throw new BadRequestException('Choose a conversation');

    const conv = await this.assertMember(me, conversationId);

    if (input.type === 'text') {
      if (!input.body?.trim()) throw new BadRequestException('Type something first');
      if (input.body.length > 4000) throw new BadRequestException('That message is too long');
    } else if (input.mediaId) {
      // The sender must own the media they are attaching.
      const m = await this.media.authorise(me, input.mediaId);
      if (m.owner_id !== me) throw new ForbiddenException('You can only send your own media');
    }

    /* Idempotent on the client nonce. A retry after a timeout returns the
       original message rather than posting a second copy. */
    if (input.clientNonce) {
      const dup = await this.db.one<{ id: string }>(
        `SELECT id FROM messages WHERE sender_id = $1 AND client_nonce = $2`,
        [me, input.clientNonce]);
      if (dup) return this.byId(me, dup.id);
    }

    const expiresAt = conv.disappear_after_sec
      ? new Date(Date.now() + conv.disappear_after_sec * 1000) : null;

    const row = await this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, type, body, media_id,
                               reply_to_id, client_nonce, expires_at, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id`,
        [conversationId, me, input.type, input.body ?? null, input.mediaId ?? null,
         input.replyToId ?? null, input.clientNonce ?? null, expiresAt]);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`,
        [conversationId]);
      return rows[0];
    });

    return this.byId(me, row.id);
  }

  async byId(me: string, messageId: string) {
    const row = await this.db.one(
      `SELECT m.id, m.conversation_id, m.type, m.body, m.media_id, m.snap_id,
              m.reply_to_id, m.sender_id, m.created_at, m.expires_at,
              u.username, p.display_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.sender_id
         LEFT JOIN profiles p ON p.user_id = m.sender_id
        WHERE m.id = $1`, [messageId]);
    if (!row) throw new NotFoundException('No such message');
    return row;
  }

  /** Marks everything up to now as read for this member. */
  async markRead(me: string, conversationId: string) {
    await this.assertMember(me, conversationId);
    await this.db.query(
      `UPDATE conversation_members SET last_read_at = now()
        WHERE conversation_id = $1 AND user_id = $2`, [conversationId, me]);
    return { ok: true };
  }

  /** Soft delete, and only your own message. */
  async deleteMessage(me: string, messageId: string) {
    const { length } = await this.db.query(
      `UPDATE messages SET deleted_at = now(), body = NULL
        WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL RETURNING id`, [messageId, me]);
    if (!length) throw new NotFoundException('No such message');
    return { ok: true };
  }

  async react(me: string, messageId: string, emoji: string | null) {
    const msg = await this.db.one<{ conversation_id: string }>(
      `SELECT conversation_id FROM messages WHERE id = $1 AND deleted_at IS NULL`, [messageId]);
    if (!msg) throw new NotFoundException('No such message');
    await this.assertMember(me, msg.conversation_id);

    if (emoji === null) {
      await this.db.query(
        `DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2`, [messageId, me]);
    } else {
      // One reaction per person, replaced rather than accumulated.
      await this.db.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)
         ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
        [messageId, me, emoji.slice(0, 8)]);
    }
    return { ok: true, conversationId: msg.conversation_id };
  }

  /** Disappearing messages for a conversation (spec §11). */
  async setDisappearing(me: string, conversationId: string, seconds: number | null) {
    await this.assertMember(me, conversationId);
    if (seconds !== null && (seconds < 5 || seconds > 604_800)) {
      throw new BadRequestException('Choose between 5 seconds and 7 days');
    }
    await this.db.query(
      `UPDATE conversations SET disappear_after_sec = $2 WHERE id = $1`,
      [conversationId, seconds]);
    // A system message, so nobody discovers the setting changed by noticing
    // their messages vanishing.
    await this.db.query(
      `INSERT INTO messages (conversation_id, sender_id, type, body)
       VALUES ($1,$2,'system',$3)`,
      [conversationId, me, seconds
        ? `Disappearing messages set to ${seconds}s`
        : 'Disappearing messages turned off']);
    return { ok: true };
  }

  /* ------------------------------------------------- group membership */

  /** The caller's role, or null if they are not a member. */
  private async roleIn(conversationId: string, userId: string): Promise<string | null> {
    const row = await this.db.one<{ role: string }>(
      `SELECT role FROM conversation_members
        WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL`, [conversationId, userId]);
    return row?.role ?? null;
  }

  async groupDetail(me: string, conversationId: string) {
    const role = await this.roleIn(conversationId, me);
    if (!role) throw new NotFoundException('No such conversation');

    const conv = await this.db.one(
      `SELECT id, type, title, disappear_after_sec, created_at
         FROM conversations WHERE id=$1 AND deleted_at IS NULL`, [conversationId]);
    if (!conv) throw new NotFoundException('No such conversation');

    const members = await this.db.query(
      `SELECT u.id, u.username, p.display_name, cm.role, cm.joined_at,
              cm.muted_until IS NOT NULL AND cm.muted_until > now() AS muted
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         JOIN profiles p ON p.user_id = cm.user_id
        WHERE cm.conversation_id=$1 AND cm.left_at IS NULL
        ORDER BY array_position(ARRAY['owner','admin','member'], cm.role), p.display_name`,
      [conversationId]);

    return { ...conv, myRole: role, members };
  }

  /** Owners and admins may add; anyone added must be a friend of the adder. */
  async addMembers(me: string, conversationId: string, userIds: string[]) {
    const role = await this.roleIn(conversationId, me);
    if (!role) throw new NotFoundException('No such conversation');
    if (!['owner', 'admin'].includes(role)) {
      throw new ForbiddenException('Only an owner or admin can add people');
    }

    const allowed = await this.db.query<{ id: string }>(
      `SELECT u.id FROM users u
        WHERE u.id = ANY($2::uuid[]) AND u.deleted_at IS NULL AND u.status='active'
          AND are_friends($1, u.id) AND NOT is_blocked_between($1, u.id)`, [me, userIds]);
    if (!allowed.length) throw new ForbiddenException('You can only add friends');

    let added = 0;
    for (const a of allowed) {
      /* Re-joining someone who left clears left_at rather than inserting a
         duplicate — the primary key is (conversation_id, user_id), so a plain
         insert would fail and the person could never be re-added. */
      const { length } = await this.db.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2)
         ON CONFLICT (conversation_id, user_id)
           DO UPDATE SET left_at = NULL, joined_at = now()
         RETURNING user_id`, [conversationId, a.id]);
      if (length) added++;
    }

    await this.db.query(
      `INSERT INTO messages (conversation_id, sender_id, type, body)
       VALUES ($1,$2,'system',
         (SELECT display_name FROM profiles WHERE user_id=$2) || ' added ' || $3 || ' to the group')`,
      [conversationId, me, `${added} ${added === 1 ? 'person' : 'people'}`]);

    return { added };
  }

  /**
   * Removes someone. An owner cannot be removed by an admin, and nobody can
   * remove themselves this way — that is `leave`, which reads differently in
   * the system message and is what people actually mean.
   */
  async removeMember(me: string, conversationId: string, userId: string) {
    if (me === userId) throw new BadRequestException('Use leave instead');

    const myRole = await this.roleIn(conversationId, me);
    if (!myRole) throw new NotFoundException('No such conversation');
    if (!['owner', 'admin'].includes(myRole)) {
      throw new ForbiddenException('Only an owner or admin can remove people');
    }

    const theirRole = await this.roleIn(conversationId, userId);
    if (!theirRole) throw new NotFoundException('They are not in this group');
    if (theirRole === 'owner') throw new ForbiddenException('The owner cannot be removed');
    if (theirRole === 'admin' && myRole !== 'owner') {
      throw new ForbiddenException('Only the owner can remove an admin');
    }

    await this.db.tx(async c => {
      await c.query(
        `UPDATE conversation_members SET left_at=now()
          WHERE conversation_id=$1 AND user_id=$2`, [conversationId, userId]);
      await c.query(
        `INSERT INTO messages (conversation_id, sender_id, type, body)
         VALUES ($1,$2,'system',
           (SELECT display_name FROM profiles WHERE user_id=$3) || ' was removed')`,
        [conversationId, me, userId]);
    });
    return { ok: true };
  }

  /**
   * Leaves a group. If the owner leaves, ownership passes to the longest-
   * standing remaining member — a group with no owner can never be administered
   * again, and silently orphaning it is worse than picking a successor.
   */
  async leave(me: string, conversationId: string) {
    const role = await this.roleIn(conversationId, me);
    if (!role) throw new NotFoundException('No such conversation');

    return this.db.tx(async c => {
      await c.query(
        `UPDATE conversation_members SET left_at=now()
          WHERE conversation_id=$1 AND user_id=$2`, [conversationId, me]);

      let newOwner: string | null = null;
      if (role === 'owner') {
        const { rows } = await c.query(
          `SELECT user_id FROM conversation_members
            WHERE conversation_id=$1 AND left_at IS NULL
            ORDER BY array_position(ARRAY['admin','member'], role), joined_at
            LIMIT 1`, [conversationId]);
        if (rows[0]) {
          newOwner = rows[0].user_id;
          await c.query(
            `UPDATE conversation_members SET role='owner'
              WHERE conversation_id=$1 AND user_id=$2`, [conversationId, newOwner]);
        } else {
          // Last person out: retire the conversation rather than leaving an
          // empty group nobody can see or delete.
          await c.query(`UPDATE conversations SET deleted_at=now() WHERE id=$1`, [conversationId]);
        }
      }

      await c.query(
        `INSERT INTO messages (conversation_id, sender_id, type, body)
         VALUES ($1,$2,'system',
           (SELECT display_name FROM profiles WHERE user_id=$2) || ' left the group')`,
        [conversationId, me]);

      return { ok: true, newOwner };
    });
  }

  /** Mutes notifications for this member only. NULL clears it. */
  async mute(me: string, conversationId: string, until: string | null) {
    const role = await this.roleIn(conversationId, me);
    if (!role) throw new NotFoundException('No such conversation');
    await this.db.query(
      `UPDATE conversation_members SET muted_until=$3
        WHERE conversation_id=$1 AND user_id=$2`, [conversationId, me, until]);
    return { ok: true, mutedUntil: until };
  }

  /** Owner-only. Promoting an admin is how a group survives its founder. */
  async setRole(me: string, conversationId: string, userId: string, role: 'admin' | 'member') {
    const myRole = await this.roleIn(conversationId, me);
    if (myRole !== 'owner') throw new ForbiddenException('Only the owner can change roles');
    if (me === userId) throw new BadRequestException('You cannot change your own role');

    const { length } = await this.db.query(
      `UPDATE conversation_members SET role=$3
        WHERE conversation_id=$1 AND user_id=$2 AND left_at IS NULL AND role <> 'owner'
        RETURNING user_id`, [conversationId, userId, role]);
    if (!length) throw new NotFoundException('They are not in this group');
    return { ok: true, role };
  }

  async renameGroup(me: string, conversationId: string, title: string) {
    const role = await this.roleIn(conversationId, me);
    if (!role) throw new NotFoundException('No such conversation');
    if (!['owner', 'admin'].includes(role)) {
      throw new ForbiddenException('Only an owner or admin can rename the group');
    }
    const clean = title.trim().slice(0, 60);
    if (!clean) throw new BadRequestException('Give the group a name');
    await this.db.query(`UPDATE conversations SET title=$2 WHERE id=$1`, [conversationId, clean]);
    await this.db.query(
      `INSERT INTO messages (conversation_id, sender_id, type, body)
       VALUES ($1,$2,'system',
         (SELECT display_name FROM profiles WHERE user_id=$2) || ' renamed the group to "' || $3 || '"')`,
      [conversationId, me, clean]);
    return { ok: true, title: clean };
  }

  /** Everyone in a conversation except the actor — the WebSocket fan-out list. */
  async memberIds(conversationId: string, except?: string): Promise<string[]> {
    const rows = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM conversation_members
        WHERE conversation_id = $1 AND left_at IS NULL
          AND ($2::uuid IS NULL OR user_id <> $2)`, [conversationId, except ?? null]);
    return rows.map(r => r.user_id);
  }
}
