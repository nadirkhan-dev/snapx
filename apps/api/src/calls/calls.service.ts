import {
  Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger,
} from '@nestjs/common';
import { Db } from '../database/database.module';
import { makeTurnCredential } from './turn';

/**
 * Voice and video calls (spec §21).
 *
 * The split that matters: **signalling and media are separate**. This service
 * and the gateway carry only signalling — who is calling whom, the SDP offer
 * and answer, and ICE candidates. The audio and video never touch our servers;
 * they go peer-to-peer over the connection those messages negotiate.
 *
 * That is not merely an optimisation. Routing media through a server means
 * bandwidth costs proportional to call minutes and a server that can read every
 * call. Peer-to-peer with DTLS-SRTP means we could not eavesdrop if we wanted
 * to, which is the right property for a calling feature.
 *
 * Call *state* is persisted because a missed call has to appear in the log
 * afterwards, and because a ringing call must be cancellable from another
 * device. The SDP itself is never stored — it is relayed and forgotten.
 */

export type CallType = 'voice' | 'video';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'missed' | 'rejected' | 'failed';

// A call nobody answers should not ring forever.
const RING_TIMEOUT_MS = 45_000;

@Injectable()
export class CallsService {
  private readonly log = new Logger('Calls');

  constructor(private readonly db: Db) {}

  /**
   * ICE servers for the client.
   *
   * STUN alone lets two peers behind ordinary home routers find each other.
   * TURN is required when one of them is behind a symmetric NAT or a corporate
   * firewall that blocks UDP — roughly 10–20% of real connections, so a
   * production deployment needs one. Configure TURN_URL / TURN_USERNAME /
   * TURN_CREDENTIAL and it is handed to clients automatically.
   *
   * Returned from the server rather than hardcoded in the client so credentials
   * can rotate without shipping a new build. TURN credentials are short-lived
   * by convention; wire your provider's ephemeral-credential API here.
   */
  iceServers(userId?: string) {
    const servers: RTCIceServerConfig[] = [
      { urls: (process.env.STUN_URLS ??
          'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') },
    ];

    const urls = process.env.TURN_URL?.split(',').map(u => u.trim()).filter(Boolean) ?? [];

    if (urls.length && process.env.TURN_SECRET && userId) {
      /* Preferred: short-lived credentials derived from a shared secret. The
         secret stays on this server; the client receives something that stops
         working on its own. */
      const cred = makeTurnCredential({
        urls, secret: process.env.TURN_SECRET, userId,
        ttlSec: Number(process.env.TURN_TTL_SEC) || undefined,
      });
      servers.push({ urls: cred.urls, username: cred.username, credential: cred.credential });
      return { iceServers: servers, hasTurn: true, credentialTtl: cred.ttl, ephemeral: true };
    }

    if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      /* Fallback: static credentials. Works, but anyone who opens DevTools has
         your TURN account until you rotate it by hand. Flagged in the response
         so the client can warn during development and so this shows up in a
         production readiness check rather than hiding. */
      this.log.warn(
        'Using STATIC TURN credentials. Set TURN_SECRET for ephemeral credentials — ' +
        'static ones are extractable from any client and cannot be revoked individually.');
      servers.push({
        urls,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
      return { iceServers: servers, hasTurn: true, ephemeral: false };
    }

    // No TURN. Calls still work peer-to-peer on permissive networks and fail on
    // restrictive ones; the client shows a warning rather than hanging.
    return { iceServers: servers, hasTurn: false, ephemeral: false };
  }

  /** Both parties must be friends, and neither may have blocked the other. */
  private async assertCallable(callerId: string, calleeId: string) {
    if (callerId === calleeId) throw new BadRequestException('You cannot call yourself');

    const row = await this.db.one<{ friends: boolean; blocked: boolean; status: string }>(
      `SELECT are_friends($1,$2) AS friends,
              is_blocked_between($1,$2) AS blocked,
              u.status
         FROM users u WHERE u.id = $2 AND u.deleted_at IS NULL`,
      [callerId, calleeId]);

    if (!row || row.blocked) throw new NotFoundException('No such user');
    if (row.status !== 'active') throw new ForbiddenException('That account is unavailable');
    if (!row.friends) throw new ForbiddenException('You can only call friends');
  }

  /**
   * Starts a call. Returns immediately in `ringing`; the gateway pushes the
   * invitation to the callee's devices.
   */
  async start(callerId: string, calleeId: string, type: CallType) {
    await this.assertCallable(callerId, calleeId);

    /* One live call at a time per person. Without this, a double-tap creates
       two calls and the callee sees two incoming screens for the same person. */
    const busy = await this.db.one<{ id: string }>(
      `SELECT c.id FROM calls c
         JOIN call_participants p ON p.call_id = c.id
        WHERE c.status IN ('ringing','active') AND p.user_id IN ($1,$2)
        LIMIT 1`, [callerId, calleeId]);
    if (busy) throw new ForbiddenException('One of you is already on a call');

    return this.db.tx(async c => {
      const { rows } = await c.query(
        `INSERT INTO calls (initiator_id, type, status) VALUES ($1,$2,'ringing')
         RETURNING id, type, status, created_at`, [callerId, type]);
      const call = rows[0];
      await c.query(
        `INSERT INTO call_participants (call_id, user_id, joined_at)
         VALUES ($1,$2,now()), ($1,$3,NULL)`, [call.id, callerId, calleeId]);
      return { ...call, calleeId };
    });
  }

  /** The callee picked up. */
  async accept(userId: string, callId: string) {
    const call = await this.participantCall(userId, callId);
    if (call.status !== 'ringing') {
      throw new ForbiddenException(`That call is already ${call.status}`);
    }
    await this.db.tx(async c => {
      await c.query(
        `UPDATE calls SET status='active', started_at=now() WHERE id=$1`, [callId]);
      await c.query(
        `UPDATE call_participants SET joined_at=now() WHERE call_id=$1 AND user_id=$2`,
        [callId, userId]);
    });
    return { id: callId, status: 'active' as CallStatus };
  }

  /**
   * Ends a call, whatever state it was in.
   *
   * The final status depends on who hung up and when: the callee declining a
   * ringing call is `rejected`, the caller giving up is `missed`, and either
   * side ending an active call is `ended`. That distinction is the entire
   * content of a call log, so it is computed here rather than trusted from the
   * client that happened to send the message.
   */
  async end(userId: string, callId: string, reason?: 'declined' | 'cancelled' | 'hangup' | 'failed') {
    const call = await this.participantCall(userId, callId);
    if (['ended', 'missed', 'rejected', 'failed'].includes(call.status)) {
      return { id: callId, status: call.status as CallStatus };
    }

    let status: CallStatus;
    if (reason === 'failed') status = 'failed';
    else if (call.status === 'active') status = 'ended';
    else if (userId === call.initiator_id) status = 'missed';   // caller gave up
    else status = 'rejected';                                   // callee declined

    await this.db.tx(async c => {
      await c.query(`UPDATE calls SET status=$2, ended_at=now() WHERE id=$1`, [callId, status]);
      await c.query(
        `UPDATE call_participants SET left_at=now() WHERE call_id=$1 AND left_at IS NULL`, [callId]);
    });

    // A missed call is worth a notification; a completed one is not.
    if (status === 'missed') {
      const other = await this.otherParty(callId, call.initiator_id);
      if (other) {
        await this.db.query(
          `INSERT INTO notifications (user_id, kind, title, data)
           VALUES ($1,'call_missed',
             (SELECT display_name FROM profiles WHERE user_id=$2) || ' tried to call you', $3)`,
          [other, call.initiator_id, JSON.stringify({ callId, type: call.type })]);
      }
    }

    return { id: callId, status };
  }

  /** Sweeps calls that rang out without anyone acting. */
  async expireRinging() {
    const rows = await this.db.query<{ id: string; initiator_id: string }>(
      `UPDATE calls SET status='missed', ended_at=now()
        WHERE status='ringing' AND created_at < now() - ($1 || ' milliseconds')::interval
        RETURNING id, initiator_id`, [String(RING_TIMEOUT_MS)]);
    if (rows.length) this.log.log(`expired ${rows.length} unanswered call(s)`);
    return rows;
  }

  async history(userId: string) {
    return this.db.query(
      `SELECT c.id, c.type, c.status, c.created_at, c.started_at, c.ended_at,
              (c.initiator_id = $1) AS outgoing,
              u.id AS other_id, u.username, p.display_name,
              EXTRACT(EPOCH FROM (c.ended_at - c.started_at))::int AS duration_sec
         FROM calls c
         JOIN call_participants me ON me.call_id = c.id AND me.user_id = $1
         JOIN call_participants them ON them.call_id = c.id AND them.user_id <> $1
         JOIN users u ON u.id = them.user_id
         JOIN profiles p ON p.user_id = u.id
        ORDER BY c.created_at DESC LIMIT 50`, [userId]);
  }

  /* ------------------------------------------------------------- helpers */

  /** Loads a call the user is actually part of, or 404s. */
  async participantCall(userId: string, callId: string) {
    const row = await this.db.one<{
      id: string; initiator_id: string; type: CallType; status: CallStatus;
    }>(`SELECT c.id, c.initiator_id, c.type, c.status
          FROM calls c JOIN call_participants p ON p.call_id = c.id
         WHERE c.id = $1 AND p.user_id = $2`, [callId, userId]);
    if (!row) throw new NotFoundException('No such call');
    return row;
  }

  async otherParty(callId: string, notUserId: string): Promise<string | null> {
    const row = await this.db.one<{ user_id: string }>(
      `SELECT user_id FROM call_participants WHERE call_id=$1 AND user_id <> $2 LIMIT 1`,
      [callId, notUserId]);
    return row?.user_id ?? null;
  }
}

interface RTCIceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}
