import {
  WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import { CallsService } from './calls.service';
import { Db } from '../database/database.module';
import { loadConfig } from '../config/config';

/**
 * WebRTC signalling (spec §21).
 *
 * This gateway is a relay and nothing more. It forwards SDP offers, answers and
 * ICE candidates between two peers who are already authorised to talk. It never
 * parses SDP, never stores it, and never touches media.
 *
 * Every relayed message is re-authorised against the database rather than
 * trusted from the socket payload. Without that, anyone who learned a call id
 * could inject candidates into someone else's call — signalling is exactly the
 * kind of "just plumbing" surface where authorisation gets skipped.
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: loadConfig().WEB_ORIGIN.split(','), credentials: true },
})
export class CallsGateway {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('Calls');

  constructor(private readonly calls: CallsService, private readonly db: Db) {}

  private me(socket: Socket): string {
    const id = socket.data.userId as string | undefined;
    if (!id) throw new Error('unauthenticated socket');
    return id;
  }

  /** Places a call and rings the callee's devices. */
  @SubscribeMessage('call:start')
  async onStart(@ConnectedSocket() socket: Socket,
                @MessageBody() body: { calleeId: string; type: 'voice' | 'video' }) {
    const me = this.me(socket);
    try {
      const call = await this.calls.start(me, body.calleeId, body.type);
      const caller = await this.db.one<{ display_name: string; username: string }>(
        `SELECT display_name, u.username FROM profiles p JOIN users u ON u.id = p.user_id
          WHERE p.user_id = $1`, [me]);

      this.server.to(`user:${body.calleeId}`).emit('call:incoming', {
        callId: call.id, type: call.type, from: { id: me, ...caller },
      });
      return { ok: true, callId: call.id, ice: this.calls.iceServers(me) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('call:accept')
  async onAccept(@ConnectedSocket() socket: Socket, @MessageBody() body: { callId: string }) {
    const me = this.me(socket);
    try {
      await this.calls.accept(me, body.callId);
      const other = await this.calls.otherParty(body.callId, me);
      if (other) this.server.to(`user:${other}`).emit('call:accepted', { callId: body.callId });
      return { ok: true, ice: this.calls.iceServers(me) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('call:end')
  async onEnd(@ConnectedSocket() socket: Socket,
              @MessageBody() body: { callId: string; reason?: 'declined' | 'cancelled' | 'hangup' | 'failed' }) {
    const me = this.me(socket);
    try {
      const out = await this.calls.end(me, body.callId, body.reason);
      const other = await this.calls.otherParty(body.callId, me);
      if (other) {
        this.server.to(`user:${other}`).emit('call:ended',
          { callId: body.callId, status: out.status });
      }
      return { ok: true, status: out.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Relays an SDP offer or answer.
   *
   * The membership check is the important line. `participantCall` throws unless
   * the sender is genuinely on this call, so a forged call id gets nowhere.
   */
  @SubscribeMessage('call:signal')
  async onSignal(@ConnectedSocket() socket: Socket, @MessageBody() body: {
    callId: string;
    kind: 'offer' | 'answer' | 'candidate';
    payload: unknown;
  }) {
    const me = this.me(socket);
    try {
      const call = await this.calls.participantCall(me, body.callId);
      if (!['ringing', 'active'].includes(call.status)) {
        return { ok: false, error: `call is ${call.status}` };
      }
      const other = await this.calls.otherParty(body.callId, me);
      if (!other) return { ok: false, error: 'no other party' };

      this.server.to(`user:${other}`).emit('call:signal', {
        callId: body.callId, kind: body.kind, payload: body.payload, from: me,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** ICE servers on demand, so a client can prepare before the call connects. */
  @SubscribeMessage('call:ice-config')
  onIceConfig(@ConnectedSocket() socket: Socket) {
    return { ok: true, ice: this.calls.iceServers(this.me(socket)) };
  }
}
