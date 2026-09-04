'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '@/lib/socket';

/**
 * WebRTC calling (spec §21).
 *
 * The hard parts of a peer connection, in the order they bite:
 *
 * 1. **Glare.** Both sides can create an offer at once. Solved by the
 *    *perfect negotiation* pattern: the caller is impolite and ignores an
 *    incoming offer during its own negotiation; the callee is polite and rolls
 *    back. Without this, simultaneous renegotiation deadlocks the connection.
 *
 * 2. **Candidate ordering.** ICE candidates routinely arrive before the remote
 *    description that gives them meaning. Adding one early throws, so early
 *    arrivals are queued and flushed once the description is set.
 *
 * 3. **Cleanup.** A peer connection and its media tracks survive component
 *    unmount unless closed explicitly — leaving the camera light on after a
 *    call ends, which users correctly read as spyware.
 */

export type CallState =
  | 'idle' | 'calling' | 'ringing' | 'connecting' | 'active' | 'ended' | 'failed';

export interface IncomingCall {
  callId: string; type: 'voice' | 'video';
  from: { id: string; display_name: string; username: string };
}

interface IceConfig { iceServers: RTCIceServer[]; hasTurn: boolean; ephemeral?: boolean }

export function useCall() {
  const { socket, on } = useSocket();

  const [state, setState] = useState<CallState>('idle');
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [type, setType] = useState<'voice' | 'video'>('voice');
  const [peerName, setPeerName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [noTurnWarning, setNoTurnWarning] = useState(false);

  const pc = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const remoteStream = useRef<MediaStream>(new MediaStream());
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  /* The caller sends its offer the moment it adds tracks — which is before the
     callee has answered the ring and built a peer. That offer must be held, not
     dropped: nothing ever re-sends it, so losing it leaves the caller stuck on
     "Connecting…" forever while the callee sees only its own preview. */
  const pendingOffer = useRef<RTCSessionDescriptionInit | null>(null);
  const makingOffer = useRef(false);
  const polite = useRef(false);          // callee is polite, caller is not
  /* Only the caller opens negotiation. Adding tracks fires
     onnegotiationneeded on BOTH peers, so without this the callee races out a
     competing offer, the impolite caller correctly ignores it, and the
     callee's tracks are never negotiated — audio and video flow one way only,
     with no error anywhere. The callee's tracks ride along in its answer. */
  const mayOffer = useRef(false);
  /* ICE restart state. A network change (Wi-Fi to mobile data, or a lost and
     regained connection) invalidates every candidate pair, and the connection
     sits in 'disconnected' until something forces renegotiation. Browsers do
     not do it for you. */
  const restartTimer = useRef<number | undefined>(undefined);
  const restarts = useRef(0);
  const currentCall = useRef<string | null>(null);

  /* ------------------------------------------------------------ teardown */

  const cleanup = useCallback(() => {
    // Tracks first: this is what turns the camera light off.
    localStream.current?.getTracks().forEach(t => t.stop());
    localStream.current = null;
    remoteStream.current.getTracks().forEach(t => remoteStream.current.removeTrack(t));
    pc.current?.close();
    pc.current = null;
    clearTimeout(restartTimer.current);
    restarts.current = 0;
    pendingCandidates.current = [];
    pendingOffer.current = null;
    makingOffer.current = false;
    mayOffer.current = false;
    currentCall.current = null;
    setCallId(null);
    setMuted(false);
    setCameraOff(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  /* ---------------------------------------------------------- connection */

  const buildPeer = useCallback(async (id: string, ice: IceConfig, wantVideo: boolean) => {
    setNoTurnWarning(!ice.hasTurn);

    const conn = new RTCPeerConnection({
      iceServers: ice.iceServers,
      // Trickle ICE: send candidates as they are found rather than waiting for
      // gathering to finish. Cuts connection time from seconds to hundreds of ms.
      iceCandidatePoolSize: 4,
    });
    pc.current = conn;

    const media = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    localStream.current = media;
    media.getTracks().forEach(t => conn.addTrack(t, media));

    conn.ontrack = e => {
      // One MediaStream reused, so the <video> srcObject never has to change.
      e.streams[0]?.getTracks().forEach(t => {
        if (!remoteStream.current.getTracks().includes(t)) remoteStream.current.addTrack(t);
      });
    };

    conn.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('call:signal',
          { callId: id, kind: 'candidate', payload: e.candidate.toJSON() });
      }
    };

    conn.onconnectionstatechange = () => {
      const s = conn.connectionState;
      if (s === 'connected') {
        setState('active');
        restarts.current = 0;                 // recovered; allow future retries
        clearTimeout(restartTimer.current);
      }
      if (s === 'failed') {
        // Almost always a NAT that needs TURN. Say so rather than "failed".
        setError(ice.hasTurn
          ? 'The connection dropped.'
          : 'Could not connect. This network needs a TURN server.');
        setState('failed');
        socket.emit('call:end', { callId: id, reason: 'failed' });
      }
      if (s === 'disconnected') {
        setState('connecting');
        /* Give the browser a few seconds to recover on its own — most brief
           blips resolve without intervention, and restarting immediately would
           tear down a connection that was about to come back. Only the caller
           restarts, so both sides do not offer at once. */
        clearTimeout(restartTimer.current);
        restartTimer.current = window.setTimeout(() => {
          if (conn.connectionState !== 'disconnected') return;
          if (!mayOffer.current) return;      // the answering side waits
          if (restarts.current >= 2) {
            setError('The connection was lost.');
            setState('failed');
            socket.emit('call:end', { callId: id, reason: 'failed' });
            return;
          }
          restarts.current += 1;
          // restartIce() forces fresh candidate gathering and triggers
          // onnegotiationneeded, which sends a new offer through the same path.
          conn.restartIce();
        }, 4000);
      }
    };

    conn.onnegotiationneeded = async () => {
      if (!mayOffer.current) return;
      try {
        makingOffer.current = true;
        await conn.setLocalDescription();
        socket.emit('call:signal',
          { callId: id, kind: 'offer', payload: conn.localDescription });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        makingOffer.current = false;
      }
    };

    return conn;
  }, [socket]);

  /** Applies an offer that arrived before this peer existed. */
  const applyPendingOffer = useCallback(async () => {
    const conn = pc.current;
    const offer = pendingOffer.current;
    if (!conn || !offer) return;
    pendingOffer.current = null;
    await conn.setRemoteDescription(offer);
    await conn.setLocalDescription();
    socket.emit('call:signal',
      { callId: currentCall.current!, kind: 'answer', payload: conn.localDescription });
    mayOffer.current = true;
  }, [socket]);

  const flushCandidates = useCallback(async () => {
    const conn = pc.current;
    if (!conn?.remoteDescription) return;
    const queued = pendingCandidates.current;
    pendingCandidates.current = [];
    for (const c of queued) {
      await conn.addIceCandidate(c).catch(() => { /* stale candidate; harmless */ });
    }
  }, []);

  /* -------------------------------------------------------------- actions */

  const call = useCallback(async (calleeId: string, name: string, kind: 'voice' | 'video') => {
    setError(null);
    setType(kind);
    setPeerName(name);
    setState('calling');
    polite.current = false;                 // the caller is impolite

    const ack = await socket.emitWithAck('call:start', { calleeId, type: kind })
      .catch(() => null) as { ok: boolean; callId?: string; ice?: IceConfig; error?: string } | null;

    if (!ack?.ok || !ack.callId) {
      setError(ack?.error ?? 'Could not start the call');
      setState('failed');
      return;
    }

    setCallId(ack.callId);
    currentCall.current = ack.callId;
    mayOffer.current = true;              // the caller opens negotiation
    try {
      // Creating the peer fires onnegotiationneeded, which sends the offer.
      await buildPeer(ack.callId, ack.ice!, kind === 'video');
    } catch (e) {
      setError(permissionMessage(e));
      setState('failed');
      socket.emit('call:end', { callId: ack.callId, reason: 'failed' });
    }
  }, [socket, buildPeer]);

  const accept = useCallback(async () => {
    if (!incoming) return;
    setError(null);
    setType(incoming.type);
    setPeerName(incoming.from.display_name);
    setCallId(incoming.callId);
    currentCall.current = incoming.callId;
    setState('connecting');
    polite.current = true;                  // the callee is polite

    const ack = await socket.emitWithAck('call:accept', { callId: incoming.callId })
      .catch(() => null) as { ok: boolean; ice?: IceConfig; error?: string } | null;

    if (!ack?.ok) {
      setError(ack?.error ?? 'Could not join the call');
      setState('failed');
      setIncoming(null);
      return;
    }

    try {
      mayOffer.current = false;           // the callee answers instead
      await buildPeer(incoming.callId, ack.ice!, incoming.type === 'video');
      // Order matters: answer the held offer first, then release the candidates
      // it gives meaning to.
      await applyPendingOffer();
      await flushCandidates();
    } catch (e) {
      setError(permissionMessage(e));
      setState('failed');
      socket.emit('call:end', { callId: incoming.callId, reason: 'failed' });
    }
    setIncoming(null);
  }, [incoming, socket, buildPeer, flushCandidates, applyPendingOffer]);

  const decline = useCallback(() => {
    if (!incoming) return;
    socket.emit('call:end', { callId: incoming.callId, reason: 'declined' });
    setIncoming(null);
  }, [incoming, socket]);

  const hangUp = useCallback(() => {
    const id = currentCall.current;
    if (id) {
      socket.emit('call:end',
        { callId: id, reason: state === 'calling' ? 'cancelled' : 'hangup' });
    }
    cleanup();
    setState('ended');
    setTimeout(() => setState('idle'), 600);
  }, [socket, state, cleanup]);

  const toggleMute = useCallback(() => {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const track = localStream.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  }, []);

  /* ------------------------------------------------------------- signals */

  useEffect(() => on<IncomingCall>('call:incoming', c => {
    // Already busy: decline automatically rather than showing a second screen.
    if (currentCall.current) {
      socket.emit('call:end', { callId: c.callId, reason: 'declined' });
      return;
    }
    setIncoming(c);
    setState('ringing');
  }), [on, socket]);

  useEffect(() => on<{ callId: string }>('call:accepted', () => {
    setState('connecting');
  }), [on]);

  useEffect(() => on<{ callId: string; status: string }>('call:ended', e => {
    if (e.callId !== currentCall.current && e.callId !== incoming?.callId) return;
    cleanup();
    setIncoming(null);
    setState('ended');
    setTimeout(() => setState('idle'), 600);
  }), [on, cleanup, incoming]);

  useEffect(() => on<{ callId: string; kind: string; payload: unknown }>('call:signal', async sig => {
    const conn = pc.current;
    if (!conn) {
      // Arrived before this side built its peer — hold everything until it has.
      if (sig.kind === 'candidate') {
        pendingCandidates.current.push(sig.payload as RTCIceCandidateInit);
      } else if (sig.kind === 'offer') {
        pendingOffer.current = sig.payload as RTCSessionDescriptionInit;
      }
      return;
    }
    if (sig.callId !== currentCall.current) return;

    try {
      if (sig.kind === 'candidate') {
        if (conn.remoteDescription) await conn.addIceCandidate(sig.payload as RTCIceCandidateInit);
        else pendingCandidates.current.push(sig.payload as RTCIceCandidateInit);
        return;
      }

      const description = sig.payload as RTCSessionDescriptionInit;

      /* Perfect negotiation. If an offer arrives while we are mid-offer, the
         impolite peer ignores it and the polite peer rolls back. Both sides
         doing the same thing is exactly how a connection deadlocks. */
      const offerCollision = description.type === 'offer'
        && (makingOffer.current || conn.signalingState !== 'stable');

      if (offerCollision && !polite.current) return;

      await conn.setRemoteDescription(description);
      await flushCandidates();

      if (description.type === 'offer') {
        // The answer carries this peer's tracks, which is how the callee's
        // media reaches the caller without a second offer.
        await conn.setLocalDescription();
        socket.emit('call:signal',
          { callId: sig.callId, kind: 'answer', payload: conn.localDescription });
        // Renegotiation from here on is legitimate (adding video to a voice
        // call, for instance), so allow it now that the initial exchange is done.
        mayOffer.current = true;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }), [on, socket, flushCandidates]);

  return {
    state, incoming, callId, type, peerName, error, muted, cameraOff, noTurnWarning,
    localStream, remoteStream,
    call, accept, decline, hangUp, toggleMute, toggleCamera,
  };
}

/** Permission failures are the most common call failure and deserve real copy. */
function permissionMessage(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'NotAllowedError') {
    return 'Microphone access is blocked. Allow it in your browser settings and try again.';
  }
  if (name === 'NotFoundError') return 'No microphone or camera found on this device.';
  if (name === 'NotReadableError') return 'Another app is using your microphone or camera.';
  return 'Could not start audio or video.';
}
