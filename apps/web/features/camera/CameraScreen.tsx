'use client';
import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { Zap, ZapOff, SwitchCamera, Images, X } from 'lucide-react';
import { useCamera } from './useCamera';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/cn';

const MAX_VIDEO_MS = 60_000;
const R = 41;
const RING = 2 * Math.PI * R;

/**
 * Camera screen (spec §7).
 *
 * Tap to photograph, hold to record — the one gesture every camera-first app
 * shares, so users arrive already knowing it. Chrome floats over the video
 * rather than boxing it in: a letterboxed preview is the fastest way to make a
 * camera app feel cheap.
 */
export function CameraScreen({ onCapture, onPickFile }: {
  onCapture: (blob: Blob, kind: 'photo' | 'video') => void;
  onPickFile: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cam = useCamera(videoRef);
  const fileRef = useRef<HTMLInputElement>(null!);

  const shutterRef = useRef<HTMLButtonElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const chromeRef = useRef<HTMLDivElement>(null);

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const holdTimer = useRef<number | undefined>(undefined);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const tick = useRef<number | undefined>(undefined);

  useEffect(() => { void cam.start('user'); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    if (cam.status !== 'live') return;
    const ctx = gsap.context(() => {
      gsap.fromTo(chromeRef.current!.querySelectorAll('[data-fade]'),
        { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.06, ease: 'power3.out' });
    });
    return () => ctx.revert();
  }, [cam.status]);

  const shootPhoto = async () => {
    haptic('capture');
    // A white flash reads as a shutter without needing a sound, which browsers
    // block anyway.
    gsap.fromTo(flashRef.current, { opacity: 0.9 }, { opacity: 0, duration: 0.32, ease: 'power2.out' });
    gsap.fromTo(shutterRef.current, { scale: 0.86 }, { scale: 1, duration: 0.45, ease: 'elastic.out(1, 0.5)' });
    const blob = await cam.capturePhoto();
    if (blob) onCapture(blob, 'photo');
  };

  const startRecording = async () => {
    if (!cam.stream.current) return;
    haptic('capture');

    // Audio is requested only now, so a photo-only session never lights the
    // microphone indicator (spec §42: request the minimum a feature needs).
    let audio: MediaStream | null = null;
    try { audio = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { /* recording silently beats refusing to record */ }

    const combined = new MediaStream([
      ...cam.stream.current.getVideoTracks(), ...(audio?.getAudioTracks() ?? []),
    ]);
    // Safari has no WebM encoder; picking the first supported type keeps one
    // code path instead of a Safari special case.
    const mime = ['video/mp4;codecs=h264', 'video/webm;codecs=vp9', 'video/webm']
      .find(t => MediaRecorder.isTypeSupported(t)) ?? '';

    const rec = new MediaRecorder(combined, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = () => {
      audio?.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks.current, { type: mime || 'video/webm' });
      if (blob.size) onCapture(blob, 'video');
    };
    rec.start(100);
    recorder.current = rec;

    setRecording(true);
    setElapsed(0);
    const startedAt = Date.now();
    tick.current = window.setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsed(ms);
      if (ms >= MAX_VIDEO_MS) stopRecording();
    }, 50);
    gsap.to(ringRef.current, { strokeDashoffset: 0, duration: MAX_VIDEO_MS / 1000, ease: 'none' });
  };

  const stopRecording = () => {
    clearInterval(tick.current);
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    setRecording(false);
    haptic('success');
    gsap.killTweensOf(ringRef.current);
    gsap.to(ringRef.current, { strokeDashoffset: RING, duration: 0.3, ease: 'power2.out' });
  };

  // 320ms separates a tap from a hold without feeling laggy.
  const onPressStart = () => { holdTimer.current = window.setTimeout(startRecording, 320); };
  const onPressEnd = () => {
    clearTimeout(holdTimer.current);
    if (recording) stopRecording(); else void shootPhoto();
  };

  useEffect(() => () => { clearTimeout(holdTimer.current); clearInterval(tick.current); }, []);

  if (cam.status !== 'live' && cam.status !== 'prompting') {
    return <CameraFallback message={cam.message} status={cam.status}
      onRetry={() => void cam.start(cam.facing)} onPick={() => fileRef.current?.click()}
      fileRef={fileRef} onFile={onPickFile} />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video ref={videoRef} playsInline muted autoPlay
        className={cn('absolute inset-0 h-full w-full object-cover',
          // Mirrored preview only. capturePhoto() does not flip, so text in
          // frame stays readable in the saved file.
          cam.facing === 'user' && 'scale-x-[-1]')} />

      <div ref={flashRef} className="pointer-events-none absolute inset-0 bg-white opacity-0" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/60 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-52 bg-gradient-to-t from-black/75 to-transparent" />

      <div ref={chromeRef} className="absolute inset-0 flex flex-col">
        <header className="flex items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))]">
          <div data-fade className="text-[15px] font-semibold tracking-tight text-ink/90">SNAPX</div>
          {recording && (
            <div className="flex items-center gap-2 rounded-full glass px-3.5 py-1.5">
              <span className="h-2 w-2 rounded-full bg-danger animate-pulse-rec" />
              <span className="font-mono text-[13px] tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
            </div>
          )}
          <div data-fade className="flex gap-2">
            {cam.hasFlash && (
              <Button variant="glass" size="icon" onClick={() => void cam.toggleFlash()}
                aria-label={cam.flashOn ? 'Turn flash off' : 'Turn flash on'} aria-pressed={cam.flashOn}>
                {cam.flashOn ? <Zap size={19} className="text-brand" fill="#FFE500" /> : <ZapOff size={19} />}
              </Button>
            )}
          </div>
        </header>

        <div className="flex-1" />

        {cam.zoomRange && !recording && (
          <div data-fade className="mb-5 flex justify-center gap-2">
            {[1, 2, 3].filter(z => z <= cam.zoomRange!.max).map(z => (
              <button key={z} onClick={() => { haptic(); void cam.setZoom(z); }} aria-label={`Zoom ${z}x`}
                className={cn('h-9 min-w-9 rounded-full px-2.5 text-xs font-semibold transition',
                  Math.abs(cam.zoom - z) < 0.15 ? 'bg-brand text-brand-ink scale-110' : 'glass text-ink/80')}>
                {z}×
              </button>
            ))}
          </div>
        )}

        <footer className="flex items-center justify-between px-9 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <Button data-fade variant="glass" size="icon-lg" aria-label="Choose from gallery"
            onClick={() => fileRef.current?.click()}
            className={cn(recording && 'pointer-events-none opacity-0')}>
            <Images size={22} />
          </Button>

          <button ref={shutterRef} data-fade
            onPointerDown={onPressStart} onPointerUp={onPressEnd}
            onPointerLeave={() => { clearTimeout(holdTimer.current); if (recording) stopRecording(); }}
            onContextMenu={e => e.preventDefault()}
            aria-label={recording ? 'Stop recording' : 'Take a photo, or hold to record'}
            className="relative grid h-[86px] w-[86px] touch-none place-items-center">
            <svg className="absolute inset-0 -rotate-90" viewBox="0 0 86 86" aria-hidden="true">
              <circle cx="43" cy="43" r={R} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="4" />
              <circle ref={ringRef} cx="43" cy="43" r={R} fill="none" stroke="#FFE500" strokeWidth="4"
                strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING} />
            </svg>
            <span className={cn('rounded-full bg-white transition-all duration-200',
              recording ? 'h-7 w-7 rounded-lg bg-danger' : 'h-[66px] w-[66px]')} />
          </button>

          <Button data-fade variant="glass" size="icon-lg" onClick={() => void cam.flip()}
            aria-label="Switch camera" className={cn(recording && 'pointer-events-none opacity-0')}>
            <SwitchCamera size={22} />
          </Button>
        </footer>

        <p data-fade className="pb-3 text-center text-[11px] tracking-wide text-ink-dim">
          {recording ? 'Release to finish' : 'Tap for photo · Hold for video'}
        </p>
      </div>

      <GalleryInput fileRef={fileRef} onFile={onPickFile} />
    </div>
  );
}

/** The only way a browser can reach the photo library — a file input the user
 *  drives. There is no API to enumerate a gallery, by design. */
function GalleryInput({ fileRef, onFile }: {
  fileRef: React.RefObject<HTMLInputElement>; onFile: (f: File) => void;
}) {
  return (
    <input ref={fileRef} type="file" accept="image/*,video/*" hidden
      onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
  );
}

/** Every non-live camera state gets a real screen with an action — never a
 *  spinner or a blank frame (spec §39). */
function CameraFallback({ status, message, onRetry, onPick, fileRef, onFile }: {
  status: string; message: string | null; onRetry: () => void; onPick: () => void;
  fileRef: React.RefObject<HTMLInputElement>; onFile: (f: File) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-10 pb-24 text-center">
      <div className="grid h-16 w-16 place-items-center rounded-2xl bg-surface-2">
        <X size={26} className="text-ink-dim" />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {status === 'denied' ? 'Camera access needed' : 'Camera unavailable'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim">{message}</p>
      </div>
      <div className="flex gap-3">
        <Button onClick={onRetry}>Try again</Button>
        {/* Uploading from the library still works without a camera, so the
            screen offers a way forward rather than only an apology. */}
        <Button variant="secondary" onClick={onPick}>Choose a file</Button>
      </div>
      <GalleryInput fileRef={fileRef} onFile={onFile} />
    </div>
  );
}
