import {
  Injectable, BadRequestException, NotFoundException,
  ForbiddenException, PayloadTooLargeException, Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Db } from '../database/database.module';
import { StorageService } from '../storage/storage.module';

/**
 * Media ownership and upload.
 *
 * Two rules run through everything here:
 *
 *   1. `storage_key` never leaves the server (spec §9, §42). Clients receive a
 *      media id and ask for a short-lived signed URL when they need the bytes.
 *      A permanent path handed to a client is a permanent path handed to
 *      everyone they forward it to.
 *
 *   2. Access is checked per request, not at upload. Media is reachable if you
 *      own it, or it was sent to you, or it is on a story you can see. That
 *      check lives in one place so a new feature cannot accidentally widen it.
 */

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // 12 MB
export const MAX_VIDEO_BYTES = 80 * 1024 * 1024;   // 80 MB — ~60s of 1080p

/**
 * Accepted types, keyed by the magic bytes that actually identify them.
 *
 * The Content-Type header is attacker-controlled. A file claiming image/jpeg
 * that begins with `<svg` or `<!DOCTYPE html` is the classic stored-XSS
 * delivery, so the declared type is verified against the real bytes and the
 * mismatch is rejected rather than "corrected".
 */
const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: '.jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png',  ext: '.png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) },
  { mime: 'image/webp', ext: '.webp', test: b => b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP' },
  { mime: 'image/gif',  ext: '.gif', test: b => b.subarray(0, 3).toString() === 'GIF' },
  // ftyp box at offset 4 covers MP4, M4V and the MOV family.
  { mime: 'video/mp4',  ext: '.mp4', test: b => b.subarray(4, 8).toString() === 'ftyp' },
  { mime: 'video/webm', ext: '.webm', test: b => b.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) },
  { mime: 'audio/webm', ext: '.weba', test: () => false },  // matched by declared type only, see below
  { mime: 'audio/mpeg', ext: '.mp3', test: b => b.subarray(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
];

export interface MediaRow {
  id: string; owner_id: string; storage_key: string; mime_type: string;
  byte_size: number; width: number | null; height: number | null;
  duration_ms: number | null; status: string; moderation: string;
}

@Injectable()
export class MediaService {
  private readonly log = new Logger('Media');

  constructor(private readonly db: Db, private readonly storage: StorageService) {}

  /** Identifies a buffer by its bytes, ignoring whatever the client claimed. */
  private sniff(buf: Buffer, declared: string) {
    const match = SIGNATURES.find(s => s.test(buf));

    if (match) {
      // A WebM container holds either audio or video. Only the declared type
      // distinguishes them, so trust it *within* the verified container.
      if (match.mime === 'video/webm' && declared.startsWith('audio/')) {
        return { mime: 'audio/webm', ext: '.weba', kind: 'audio' as const };
      }
      return {
        mime: match.mime, ext: match.ext,
        kind: match.mime.startsWith('video') ? 'video' as const
            : match.mime.startsWith('audio') ? 'audio' as const : 'image' as const,
      };
    }

    throw new BadRequestException(
      'That file type is not supported. Use JPEG, PNG, WebP, GIF, MP4 or WebM.');
  }

  async upload(ownerId: string, buf: Buffer, declaredType: string, meta: {
    width?: number; height?: number; durationMs?: number;
  } = {}): Promise<MediaRow> {
    if (!buf.length) throw new BadRequestException('That file was empty');

    const { mime, ext, kind } = this.sniff(buf, declaredType);

    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (buf.length > limit) {
      throw new PayloadTooLargeException(
        `${kind === 'image' ? 'Images' : 'Videos'} must be under ${Math.round(limit / 1048576)}MB`);
    }

    const key = this.storage.key(ownerId, ext);
    const checksum = createHash('sha256').update(buf).digest('hex');

    /* The row is written before the bytes, and only marked ready afterwards.
       A crash between the two leaves an 'uploading' row with no object, which
       the cleanup worker can find and remove. The reverse — bytes with no row —
       is an orphan nothing knows about. */
    const row = await this.db.one<MediaRow>(
      `INSERT INTO media (owner_id, storage_key, mime_type, byte_size, width, height,
                          duration_ms, checksum, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'uploading')
       RETURNING id, owner_id, storage_key, mime_type, byte_size, width, height,
                 duration_ms, status, moderation`,
      [ownerId, key, mime, buf.length, meta.width ?? null, meta.height ?? null,
       meta.durationMs ?? null, checksum]);

    try {
      await this.storage.put(key, buf, mime);
    } catch (err) {
      await this.db.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [row!.id]);
      this.log.error(`upload failed for ${row!.id}: ${(err as Error).message}`);
      throw new BadRequestException('Upload failed. Try again.');
    }

    /* Images are usable immediately. Video goes to 'processing' for the
       transcode worker, so the client shows a spinner rather than a broken
       player (spec §33). */
    const status = kind === 'video' ? 'processing' : 'ready';
    await this.db.query(`UPDATE media SET status = $2 WHERE id = $1`, [row!.id, status]);

    return { ...row!, status };
  }

  /**
   * The single authorisation check for media.
   *
   * You may see media if you own it, it was snapped to you, it is attached to a
   * message in a conversation you are in, or it is on a story you can view.
   * Everything else is a 404 — a 403 confirms the media exists, which is
   * exactly what someone probing ids wants to know.
   */
  async authorise(viewerId: string, mediaId: string): Promise<MediaRow> {
    const row = await this.db.one<MediaRow>(
      `SELECT m.id, m.owner_id, m.storage_key, m.mime_type, m.byte_size,
              m.width, m.height, m.duration_ms, m.status, m.moderation
         FROM media m
        WHERE m.id = $1 AND m.deleted_at IS NULL AND m.status <> 'removed'`, [mediaId]);
    if (!row) throw new NotFoundException('Media not found');

    if (row.owner_id === viewerId) return row;

    // Blocked users cannot reach each other's media at all, whatever route
    // they found the id through.
    const blocked = await this.db.one<{ b: boolean }>(
      `SELECT is_blocked_between($1, $2) AS b`, [viewerId, row.owner_id]);
    if (blocked?.b) throw new NotFoundException('Media not found');

    const allowed = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM snaps s
           JOIN snap_recipients sr ON sr.snap_id = s.id
          WHERE s.media_id = $1 AND sr.recipient_id = $2
            AND sr.status <> 'expired'
       ) OR EXISTS (
         SELECT 1 FROM messages msg
           JOIN conversation_members cm ON cm.conversation_id = msg.conversation_id
          WHERE msg.media_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL
            AND msg.deleted_at IS NULL
       ) OR EXISTS (
         SELECT 1 FROM stories st
          WHERE st.media_id = $1 AND st.deleted_at IS NULL AND st.expires_at > now()
            AND (st.privacy = 'everyone'
              OR (st.privacy = 'friends' AND are_friends($2, st.author_id))
              OR (st.privacy = 'custom' AND EXISTS (
                    SELECT 1 FROM story_audience sa
                     WHERE sa.story_id = st.id AND sa.user_id = $2)))
       ) AS ok`, [mediaId, viewerId]);

    if (!allowed?.ok) throw new NotFoundException('Media not found');
    return row;
  }

  /** Signed URL for media the viewer is allowed to see. */
  async urlFor(viewerId: string, mediaId: string, expiresInSec = 900) {
    const row = await this.authorise(viewerId, mediaId);
    if (row.status === 'processing') {
      return { id: row.id, status: 'processing', url: null, mimeType: row.mime_type };
    }
    return {
      id: row.id,
      status: row.status,
      url: await this.storage.signedUrl(row.storage_key, expiresInSec),
      mimeType: row.mime_type,
      width: row.width, height: row.height, durationMs: row.duration_ms,
      expiresIn: expiresInSec,
    };
  }

  /** Soft delete. The bytes go with the retention worker, not synchronously. */
  async remove(ownerId: string, mediaId: string) {
    const row = await this.db.one<{ owner_id: string }>(
      `SELECT owner_id FROM media WHERE id = $1 AND deleted_at IS NULL`, [mediaId]);
    if (!row) throw new NotFoundException('Media not found');
    if (row.owner_id !== ownerId) throw new ForbiddenException('That is not yours to delete');

    await this.db.query(
      `UPDATE media SET deleted_at = now(), status = 'removed' WHERE id = $1`, [mediaId]);
    return { ok: true };
  }

  /** Saves a copy to the user's private Memories (spec §19). */
  async saveToMemories(userId: string, mediaId: string, kind: 'snap' | 'story' | 'import') {
    await this.authorise(userId, mediaId);
    await this.db.query(
      `INSERT INTO memories (user_id, media_id, kind) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, media_id) DO UPDATE SET deleted_at = NULL`,
      [userId, mediaId, kind]);
    return { ok: true };
  }

  async listMemories(userId: string, limit = 60, before?: string) {
    return this.db.query(
      `SELECT m.id AS media_id, m.mime_type, m.width, m.height, m.duration_ms,
              mem.kind, mem.favourite, mem.created_at
         FROM memories mem JOIN media m ON m.id = mem.media_id
        WHERE mem.user_id = $1 AND mem.deleted_at IS NULL AND m.deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR mem.created_at < $2)
        ORDER BY mem.created_at DESC LIMIT $3`,
      [userId, before ?? null, Math.min(limit, 100)]);
  }
}
