import {
  WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody,
  ConnectedSocket, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { ChatService } from './chat.service';
import { Db } from '../database/database.module';
import { loadConfig } from '../config/config';

/**
 * Real-time gateway (spec §12).
 *
 * Every socket joins a room named after its user id. Fan-out is then "emit to
 * these user rooms" rather than tracking socket ids by hand, which also means a
 * user with three tabs open receives everything on all three without any extra
 * bookkeeping.
 *
 * **Scaling note.** With more than one API instance, rooms are per-process and
 * a message sent on instance A never reaches a socket on instance B. The fix is
 * the socket.io Redis adapter — Redis is already a dependency, so it is a few
 * lines when the second instance appears. Documented rather than pre-built,
 * because an adapter configured for one instance is untested infrastructure.
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: loadConfig().WEB_ORIGIN.split(','), credentials: true },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('RT');
  // userId -> number of open sockets, so presence flips only on the last one.
  private readonly connections = new Map<string, number>();

  constructor(
    private readonly auth: AuthService,
    private readonly chat: ChatService,
    private readonly db: Db,
  ) {}

  /**
   * The handshake carries the access token. Cookies are not used here: the
   * refresh cookie is scoped to /api/auth, and a socket must present the same
   * short-lived credential as any other request rather than a special one.
   */
  async handleConnection(socket: Socket) {
    const token = (socket.handshake.auth?.token
      ?? socket.handshake.query?.token) as string | undefined;
    if (!token) { socket.disconnect(true); return; }

    try {
      const { sub } = await this.auth.verifyAccess(token);
      socket.data.userId = sub;
      await socket.join(`user:${sub}`);

      const next = (this.connections.get(sub) ?? 0) + 1;
      this.connections.set(sub, next);

      if (next === 1) {
        await this.db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [sub]);
        await this.broadcastPresence(sub, true);
      }
    } catch {
      // An expired token is an ordinary event, not an error worth logging per
      // socket — clients reconnect after refreshing.
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket) {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;
    const left = (this.connections.get(userId) ?? 1) - 1;
    if (left <= 0) {
      this.connections.delete(userId);
      await this.db.query(`UPDATE users SET last_seen_at = now() WHERE id = $1`, [userId]);
      await this.broadcastPresence(userId, false);
    } else {
      this.connections.set(userId, left);
    }
  }

  /** Presence goes only to friends, and only if the user allows it (spec §25). */
  private async broadcastPresence(userId: string, online: boolean) {
    const allowed = await this.db.one<{ show: boolean }>(
      `SELECT show_activity AS show FROM privacy_settings WHERE user_id = $1`, [userId]);
    if (!allowed?.show) return;

    const friends = await this.db.query<{ id: string }>(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS id
         FROM friendships WHERE $1 IN (user_a, user_b)`, [userId]);
    for (const f of friends) {
      this.server.to(`user:${f.id}`).emit(online ? 'presence:online' : 'presence:offline', { userId });
    }
  }

  /* --------------------------------------------------------------- events */

  @SubscribeMessage('message:send')
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: {
    conversationId?: string; toUserId?: string; type: 'text' | 'image' | 'video' | 'voice';
    body?: string; mediaId?: string; replyToId?: string; clientNonce?: string;
  }) {
    const me = socket.data.userId as string;
    try {
      const msg = await this.chat.send(me, body);
      const recipients = await this.chat.memberIds(msg.conversation_id as string);
      for (const r of recipients) {
        this.server.to(`user:${r}`).emit('message:new', msg);
      }
      // The ack lets the sender reconcile its optimistic copy with the real id.
      return { ok: true, message: msg };
    } catch (err) {
      return { ok: false, error: (err as Error).message, clientNonce: body.clientNonce };
    }
  }

  @SubscribeMessage('message:read')
  async onRead(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId: string }) {
    const me = socket.data.userId as string;
    await this.chat.markRead(me, body.conversationId);
    const others = await this.chat.memberIds(body.conversationId, me);
    for (const r of others) {
      this.server.to(`user:${r}`).emit('message:read',
        { conversationId: body.conversationId, userId: me, at: new Date().toISOString() });
    }
    return { ok: true };
  }

  @SubscribeMessage('typing')
  async onTyping(@ConnectedSocket() socket: Socket,
                 @MessageBody() body: { conversationId: string; typing: boolean }) {
    const me = socket.data.userId as string;
    /* Typing is not persisted and is not authorised beyond membership — it is
       ephemeral and low-value. It IS checked for membership, because otherwise
       anyone could spam a typing indicator into any conversation. */
    const others = await this.chat.memberIds(body.conversationId, me);
    if (!others.length) return { ok: false };
    for (const r of others) {
      this.server.to(`user:${r}`).emit(body.typing ? 'typing:start' : 'typing:stop',
        { conversationId: body.conversationId, userId: me });
    }
    return { ok: true };
  }

  @SubscribeMessage('message:react')
  async onReact(@ConnectedSocket() socket: Socket,
                @MessageBody() body: { messageId: string; emoji: string | null }) {
    const me = socket.data.userId as string;
    const out = await this.chat.react(me, body.messageId, body.emoji);
    for (const r of await this.chat.memberIds(out.conversationId)) {
      this.server.to(`user:${r}`).emit('message:reaction',
        { messageId: body.messageId, userId: me, emoji: body.emoji });
    }
    return { ok: true };
  }

  /** Used by HTTP handlers to push events without importing the socket server. */
  emitToUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
