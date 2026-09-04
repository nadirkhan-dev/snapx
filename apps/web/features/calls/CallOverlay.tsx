'use client';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Video, VideoOff, AlertTriangle } from 'lucide-react';
import type { useCall } from './useCall';
import { Avatar } from '@/components/ui/bits';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

type Call = ReturnType<typeof useCall>;

/**
 * The call UI (spec §21).
 *
 * One overlay covers incoming, outgoing and active states — they are the same
 * screen at different moments, and treating them as three separate components
 * makes the transitions jarring.
 */
export function CallOverlay({ call }: { call: Call }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const [seconds, setSeconds] = useState(0);

  // Attach streams imperatively: srcObject is not a serialisable prop.
  useEffect(() => {
    if (remoteRef.current) remoteRef.current.srcObject = call.remoteStream.current;
  }, [call.remoteStream, call.state]);

  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = call.localStream.current;
  }, [call.localStream, call.state]);

  useEffect(() => {
    if (call.state !== 'active') { setSeconds(0); return; }
    const t = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [call.state]);

  const visible = call.state !== 'idle' || call.incoming !== null;
  if (!mounted || !visible) return null;

  const isVideo = call.type === 'video';
  const inbound = call.incoming !== null && call.state === 'ringing';
  const name = inbound ? call.incoming!.from.display_name : call.peerName;

  const status =
    inbound ? `Incoming ${call.incoming!.type} call`
    : call.state === 'calling' ? 'Calling…'
    : call.state === 'connecting' ? 'Connecting…'
    : call.state === 'active' ? formatDuration(seconds)
    : call.state === 'failed' ? 'Call failed'
    : call.state === 'ended' ? 'Call ended' : '';

  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col bg-bg">
      {/* Remote video fills the screen when there is video to show. */}
      {isVideo && call.state === 'active' && (
        <video ref={remoteRef} autoPlay playsInline
          className="absolute inset-0 h-full w-full bg-black object-cover" />
      )}

      {/* Audio still needs an element, even with nothing to render. */}
      {!isVideo && <video ref={remoteRef} autoPlay playsInline className="hidden" />}

      <div className={cn('relative flex flex-1 flex-col items-center justify-center gap-4 px-8',
        isVideo && call.state === 'active' && 'justify-start pt-12')}>
        {(!isVideo || call.state !== 'active') && (
          <>
            <Avatar name={name || '?'} size={110} className="text-3xl" />
            <div className="text-center">
              <h2 className="text-2xl font-semibold tracking-tight">{name || 'Unknown'}</h2>
              <p className="mt-1 text-sm text-ink-dim">{status}</p>
            </div>
          </>
        )}

        {isVideo && call.state === 'active' && (
          <div className="rounded-full glass px-4 py-1.5 text-sm">{name} · {status}</div>
        )}

        {call.error && (
          <p role="alert" className="max-w-xs rounded-xl border border-danger/30 bg-danger/10
                                     px-4 py-2.5 text-center text-[13px] text-danger">
            {call.error}
          </p>
        )}

        {/* Stated plainly rather than letting the call mysteriously fail on a
            restrictive network. */}
        {call.noTurnWarning && call.state === 'connecting' && (
          <p className="flex max-w-xs items-start gap-2 text-center text-[11px] text-warn">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            No TURN server configured — this may not connect across some networks.
          </p>
        )}
      </div>

      {/* Local preview, mirrored like every self-view. */}
      {isVideo && call.state === 'active' && (
        <video ref={localRef} autoPlay playsInline muted
          className="absolute right-4 top-4 h-40 w-28 scale-x-[-1] rounded-xl border border-white/10
                     bg-black object-cover shadow-lift" />
      )}

      <footer className="relative pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-6">
        {inbound ? (
          <div className="flex items-center justify-center gap-16">
            <button onClick={() => { haptic('warn'); call.decline(); }} aria-label="Decline"
              className="grid h-16 w-16 place-items-center rounded-full bg-danger text-white
                         transition active:scale-90">
              <PhoneOff size={26} />
            </button>
            <button onClick={() => { haptic('success'); void call.accept(); }} aria-label="Accept"
              className="grid h-16 w-16 place-items-center rounded-full bg-ok text-white
                         transition active:scale-90">
              <Phone size={26} />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-5">
            <button onClick={call.toggleMute} aria-label={call.muted ? 'Unmute' : 'Mute'}
              aria-pressed={call.muted}
              className={cn('grid h-14 w-14 place-items-center rounded-full transition active:scale-90',
                call.muted ? 'bg-ink text-bg' : 'glass text-ink')}>
              {call.muted ? <MicOff size={22} /> : <Mic size={22} />}
            </button>

            {isVideo && (
              <button onClick={call.toggleCamera}
                aria-label={call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
                aria-pressed={call.cameraOff}
                className={cn('grid h-14 w-14 place-items-center rounded-full transition active:scale-90',
                  call.cameraOff ? 'bg-ink text-bg' : 'glass text-ink')}>
                {call.cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
              </button>
            )}

            <button onClick={() => { haptic('warn'); call.hangUp(); }} aria-label="End call"
              className="grid h-16 w-16 place-items-center rounded-full bg-danger text-white
                         transition active:scale-90">
              <PhoneOff size={26} />
            </button>
          </div>
        )}
      </footer>
    </div>,
    document.body,
  );
}

const formatDuration = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
