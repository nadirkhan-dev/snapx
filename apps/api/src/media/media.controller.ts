import {
  Controller, Post, Get, Delete, Param, Query, Req, Res, Body, HttpCode, NotFoundException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { MediaService, MAX_VIDEO_BYTES } from './media.service';
import { StorageService } from '../storage/storage.module';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/auth.guard';

/**
 * Media endpoints.
 *
 * Uploads arrive as a raw body with metadata in headers rather than multipart.
 * One file per request needs no parser dependency, streams straight from the
 * browser without a FormData round-trip, and keeps the same shape for the
 * native clients later.
 */
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly storage: StorageService,
  ) {}

  @Post('upload')
  // Generous enough for a burst of snaps, tight enough that nobody fills the
  // bucket. Per-user because the guard runs first.
  @Throttle({ default: { limit: 40, ttl: 300_000 } })
  async upload(@CurrentUser() userId: string, @Req() req: Request) {
    const buf = await readBody(req, MAX_VIDEO_BYTES);
    const declared = (req.get('content-type') ?? '').split(';')[0].trim();

    const num = (h: string) => {
      const v = Number(req.get(h));
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };

    const row = await this.media.upload(userId, buf, declared, {
      width: num('x-media-width'),
      height: num('x-media-height'),
      durationMs: num('x-media-duration'),
    });

    // The storage key is deliberately absent from this response.
    return {
      id: row.id, status: row.status, mimeType: row.mime_type,
      byteSize: row.byte_size, width: row.width, height: row.height,
      durationMs: row.duration_ms,
    };
  }

  /** Signed, expiring URL for media the caller is allowed to see. */
  @Get(':id/url')
  url(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.media.urlFor(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.media.remove(userId, id);
  }

  @Post(':id/memories')
  @HttpCode(200)
  save(@CurrentUser() userId: string, @Param('id') id: string,
       @Body() body: { kind?: 'snap' | 'story' | 'import' }) {
    return this.media.saveToMemories(userId, id, body?.kind ?? 'import');
  }

  @Get('memories/list')
  memories(@CurrentUser() userId: string, @Query('before') before?: string) {
    return this.media.listMemories(userId, 60, before);
  }

  /**
   * Local-disk file serving.
   *
   * Public because the signature in the query string *is* the authorisation —
   * exactly as an S3 presigned URL works. Requiring a bearer token here too
   * would break `<img src>` and `<video src>`, which cannot send headers.
   * In production with S3 configured, this route is never reached.
   */
  @Public()
  @Get('file/:key')
  async file(@Param('key') key: string, @Query('exp') exp: string,
             @Query('sig') sig: string, @Res() res: Response) {
    const decoded = decodeURIComponent(key);
    if (!this.storage.verifyLocal(decoded, exp, sig)) {
      throw new NotFoundException('That link has expired');
    }
    // nosniff plus an explicit type: the object was verified by magic bytes at
    // upload, and must not be re-sniffed into something executable now.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=900');
    const stream = await this.storage.stream(decoded);
    stream.pipe(res);
  }
}

/** Buffers a request body with a hard ceiling, destroying the socket if exceeded. */
function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
