import { Controller, Get, Query, Param, NotFoundException } from '@nestjs/common';
import { Db } from '../database/database.module';
import { CurrentUser } from '../common/current-user.decorator';

/**
 * User lookup and search (spec §23).
 *
 * Two rules shape every query here:
 *   1. Blocked users are invisible in both directions — enforced in SQL, not
 *      filtered in the client (spec §27).
 *   2. A user who has turned off username discoverability is excluded from
 *      search but still reachable by direct profile link, which is what that
 *      setting actually means.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly db: Db) {}

  @Get('search')
  async search(@CurrentUser() me: string, @Query('q') q?: string) {
    const term = (q ?? '').trim();
    // Two characters minimum: a single letter matches most of the table and
    // the result is noise rather than an answer.
    if (term.length < 2) return { results: [] };

    const results = await this.db.query(
      `SELECT u.id, u.username, p.display_name, p.avatar_media_id,
              are_friends($1, u.id) AS is_friend,
              EXISTS (SELECT 1 FROM friend_requests fr
                       WHERE fr.status = 'pending'
                         AND ((fr.from_user_id = $1 AND fr.to_user_id = u.id)
                           OR (fr.from_user_id = u.id AND fr.to_user_id = $1))) AS request_pending
         FROM users u
         JOIN profiles p ON p.user_id = u.id
         JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE u.deleted_at IS NULL
          AND u.status = 'active'
          AND u.id <> $1
          AND ps.discoverable_by_username
          AND NOT is_blocked_between($1, u.id)
          AND (u.username ILIKE $2 OR p.display_name ILIKE $2)
        ORDER BY (u.username = $3) DESC, length(u.username), u.username
        LIMIT 20`,
      [me, `%${term.replace(/[%_]/g, m => '\\' + m)}%`, term.toLowerCase()]);

    return { results };
  }

  /**
   * Content search across stories and messages (spec §23).
   *
   * Separate from user search because the visibility rules are entirely
   * different: a user is discoverable by setting, whereas a story is visible by
   * audience and a message only to conversation members. Merging them into one
   * endpoint would mean one query trying to express both, which is how a leak
   * gets written.
   */
  @Get('search/content')
  async searchContent(@CurrentUser() me: string, @Query('q') q?: string) {
    const term = (q ?? '').trim();
    if (term.length < 2) return { stories: [], messages: [] };
    const like = `%${term.replace(/[%_]/g, m => '\\' + m)}%`;

    const stories = await this.db.query(
      `SELECT s.id, s.caption, s.created_at, u.username, p.display_name
         FROM stories s
         JOIN users u ON u.id = s.author_id
         JOIN profiles p ON p.user_id = s.author_id
        WHERE s.deleted_at IS NULL AND s.expires_at > now()
          AND s.caption ILIKE $2
          AND NOT is_blocked_between($1, s.author_id)
          AND (s.author_id = $1
            OR s.privacy = 'everyone'
            OR (s.privacy = 'friends' AND are_friends($1, s.author_id))
            OR (s.privacy = 'custom' AND EXISTS (
                  SELECT 1 FROM story_audience a WHERE a.story_id = s.id AND a.user_id = $1)))
        ORDER BY s.created_at DESC LIMIT 20`, [me, like]);

    const messages = await this.db.query(
      `SELECT m.id, m.conversation_id, m.body, m.created_at,
              p.display_name AS sender_name, c.type AS conversation_type, c.title
         FROM messages m
         JOIN conversation_members cm
           ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN profiles p ON p.user_id = m.sender_id
        WHERE m.deleted_at IS NULL AND m.type = 'text' AND m.body ILIKE $2
          -- A disappearing message that has lapsed must not resurface here.
          AND (m.expires_at IS NULL OR m.expires_at > now())
        ORDER BY m.created_at DESC LIMIT 30`, [me, like]);

    return { stories, messages };
  }

  @Get(':username')
  async byUsername(@CurrentUser() me: string, @Param('username') username: string) {
    const user = await this.db.one(
      `SELECT u.id, u.username, u.created_at,
              p.display_name, p.bio, p.avatar_media_id, p.friend_count,
              are_friends($1, u.id) AS is_friend
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.username = $2 AND u.deleted_at IS NULL AND u.status = 'active'
          AND NOT is_blocked_between($1, u.id)`,
      [me, username.toLowerCase()]);

    // 404 rather than 403 for a blocked user: confirming the account exists
    // tells a blocked person exactly what they wanted to know.
    if (!user) throw new NotFoundException('No such user');
    return user;
  }
}
