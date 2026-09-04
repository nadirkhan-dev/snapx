import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Db } from '../database/database.module';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.module';

/**
 * Stories (spec §14, §15).
 *
 * A story is media plus an audience rule plus a deadline. The audience check
 * runs in SQL on every read rather than being resolved once at post time —
 * unfriending someone must hide your story from them immediately, not at the
 * next expiry.
 */

const STORY_TTL_HOURS = 24;

@Injectable()
export class StoriesService {
  constructor(
    private readonly db: Db,
    private readonly media: MediaService,
    private readonly storage: StorageService,
  ) {}

  async post(authorId: string, input: {
    mediaId: string; caption?: string;
    privacy?: 'everyone' | 'friends' | 'custom'; audience?: string[];
  }) {
    const m = await this.media.authorise(authorId, input.mediaId);
    if (m.owner_id !== authorId) throw new ForbiddenException('You can only post your own media');

    const privacy = input.privacy ?? 'friends';
    if (privacy === 'custom' && !input.audience?.length) {
      throw new BadRequestException('Choose who can see this');
    }

    const expiresAt = new Date(Date.now() + STORY_TTL_HOURS * 3_600_000);

    return this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO stories (author_id, media_id, caption, privacy, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
        [authorId, input.mediaId, input.caption?.slice(0, 200) ?? null, privacy, expiresAt]);

      if (privacy === 'custom') {
        // Only friends can be named in a custom audience — otherwise "custom"
        // becomes a way to push content at someone who has not connected.
        for (const uid of input.audience!) {
          await c.query(
            `INSERT INTO story_audience (story_id, user_id)
             SELECT $1, $2 WHERE are_friends($3, $2)`, [rows[0].id, uid, authorId]);
        }
      }
      return { id: rows[0].id, expiresAt: rows[0].expires_at };
    });
  }

  /**
   * The story feed, grouped by author.
   *
   * Your own stories come first; then friends with unseen stories, then the
   * rest. "Unseen first" is the whole ordering logic people expect and it costs
   * one boolean in the sort.
   */
  async feed(viewerId: string) {
    return this.db.query(
      `WITH visible AS (
         SELECT s.id, s.author_id, s.media_id, s.caption, s.created_at, s.expires_at,
                EXISTS (SELECT 1 FROM story_views v
                         WHERE v.story_id = s.id AND v.viewer_id = $1) AS seen
           FROM stories s
          WHERE s.deleted_at IS NULL AND s.expires_at > now()
            AND NOT is_blocked_between($1, s.author_id)
            AND (s.author_id = $1
              OR (s.privacy = 'everyone')
              OR (s.privacy = 'friends' AND are_friends($1, s.author_id))
              OR (s.privacy = 'custom' AND EXISTS (
                    SELECT 1 FROM story_audience a
                     WHERE a.story_id = s.id AND a.user_id = $1)))
       )
       SELECT u.id AS author_id, u.username, p.display_name, p.avatar_media_id,
              (u.id = $1) AS is_me,
              bool_and(v.seen) AS all_seen,
              count(*)::int AS story_count,
              max(v.created_at) AS latest,
              json_agg(json_build_object(
                'id', v.id, 'mediaId', v.media_id, 'caption', v.caption,
                'createdAt', v.created_at, 'seen', v.seen
              ) ORDER BY v.created_at) AS stories
         FROM visible v
         JOIN users u ON u.id = v.author_id
         JOIN profiles p ON p.user_id = u.id
        GROUP BY u.id, u.username, p.display_name, p.avatar_media_id
        ORDER BY (u.id = $1) DESC, bool_and(v.seen), max(v.created_at) DESC`, [viewerId]);
  }

  /** Records a view and returns a signed URL valid for the story's remaining life. */
  async view(viewerId: string, storyId: string) {
    const story = await this.db.one<{
      id: string; author_id: string; media_id: string; caption: string | null; expires_at: string;
    }>(`SELECT s.id, s.author_id, s.media_id, s.caption, s.expires_at
          FROM stories s
         WHERE s.id = $1 AND s.deleted_at IS NULL AND s.expires_at > now()
           AND NOT is_blocked_between($2, s.author_id)
           AND (s.author_id = $2 OR s.privacy = 'everyone'
             OR (s.privacy = 'friends' AND are_friends($2, s.author_id))
             OR (s.privacy = 'custom' AND EXISTS (
                   SELECT 1 FROM story_audience a WHERE a.story_id = s.id AND a.user_id = $2)))`,
      [storyId, viewerId]);
    if (!story) throw new NotFoundException('That story is no longer available');

    // Your own view does not count, and does not appear in your viewer list.
    if (story.author_id !== viewerId) {
      await this.db.tx(async c => {
        const { rowCount } = await c.query(
          `INSERT INTO story_views (story_id, viewer_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`, [storyId, viewerId]);
        if (rowCount) {
          await c.query(`UPDATE stories SET view_count = view_count + 1 WHERE id = $1`, [storyId]);
        }
      });
    }

    const m = await this.media.authorise(viewerId, story.media_id);
    const ttl = Math.max(60, Math.floor((new Date(story.expires_at).getTime() - Date.now()) / 1000));
    return {
      id: story.id, caption: story.caption, mimeType: m.mime_type,
      url: await this.storage.signedUrl(m.storage_key, Math.min(ttl, 3600)),
    };
  }

  /** Only the author sees who watched (spec §15). */
  async viewers(authorId: string, storyId: string) {
    const own = await this.db.one(
      `SELECT id FROM stories WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL`,
      [storyId, authorId]);
    if (!own) throw new NotFoundException('No such story');

    return this.db.query(
      `SELECT u.id, u.username, p.display_name, v.viewed_at,
              (SELECT emoji FROM story_reactions r
                WHERE r.story_id = v.story_id AND r.user_id = v.viewer_id) AS reaction
         FROM story_views v
         JOIN users u ON u.id = v.viewer_id
         JOIN profiles p ON p.user_id = u.id
        WHERE v.story_id = $1 ORDER BY v.viewed_at DESC`, [storyId]);
  }

  async react(viewerId: string, storyId: string, emoji: string) {
    await this.view(viewerId, storyId);   // re-runs the audience check
    await this.db.query(
      `INSERT INTO story_reactions (story_id, user_id, emoji) VALUES ($1,$2,$3)
       ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
      [storyId, viewerId, emoji.slice(0, 8)]);
    return { ok: true };
  }

  async remove(authorId: string, storyId: string) {
    const { length } = await this.db.query(
      `UPDATE stories SET deleted_at = now()
        WHERE id=$1 AND author_id=$2 AND deleted_at IS NULL RETURNING id`, [storyId, authorId]);
    if (!length) throw new NotFoundException('No such story');
    return { ok: true };
  }

  /** Expiry sweep. Media purging is handled by the shared snap cleanup, which
   *  already refuses to delete anything still referenced by a story. */
  async expireOld() {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE stories SET deleted_at = now()
        WHERE deleted_at IS NULL AND expires_at <= now() RETURNING id`);
    return { expired: rows.length };
  }
}
