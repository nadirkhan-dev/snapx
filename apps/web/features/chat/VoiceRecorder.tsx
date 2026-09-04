'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Trash2, Play, Pause } from 'lucide-react';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

/**
 * Voice messages (spec §20).
 *
 * Hold to record, slide left to cancel, release to send. The waveform is
 * sampled live from an AnalyserNode rather than decoded afterwards, so it
 * appears as you speak — a waveform that only shows up after you stop makes the
 * recording feel like it did not work.
 *
 * Amplitude samples are stored with the message so playback can draw the same
 * shape without decoding the audio: decoding a 60-second clip to draw a
 * 40-pixel bar chart is a lot of main-thread work for a decoration.
 */

const MAX_MS = 120_000;          // two minutes
const CANCEL_SLIDE_PX = 90;
const WAVE_SAMPLES = 40;

export interface VoiceRecording {
  blob: Blob;
  durationMs: number;
  peaks: number[];               // 0..1, WAVE_SAMPLES long
}

export function VoiceRecorder({ onRecorded, disabled }: {
  onRecorded: (rec: VoiceRecording) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [slide, setSlide] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const peaks = useRef<number[]>([]);
  const startedAt = useRef(0);
  const startX = useRef(0);
  const cancelled = useRef(false);

  const teardown = useCallback(() => {
    cancelAnimationFrame(raf.current!);
    stream.current?.getTracks().forEach(t => t.stop());   // releases the mic light
    stream.current = null;
    void audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    analyser.current = null;
    setRecording(false);
    setSlide(0);
    setLevel(0);
    setElapsed(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const sample = useCallback(() => {
    const node = analyser.current;
    if (!node) return;
    const buf = new Uint8Array(node.frequencyBinCount);
    node.getByteTimeDomainData(buf);

    // RMS around the 128 midpoint gives perceived loudness; peak alone spikes
    // on a single click and makes every waveform look the same.
    let sum = 0;
    for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
    const rms = Math.min(1, Math.sqrt(sum / buf.length) * 3);

    setLevel(rms);
    peaks.current.push(rms);

    const ms = Date.now() - startedAt.current;
    setElapsed(ms);
    if (ms >= MAX_MS) { stop(false); return; }
    raf.current = requestAnimationFrame(sample);
    // Deliberately no deps: this recurses via rAF and must keep one stable
    // identity for the whole recording. `stop` is hoisted below and read at
    // call time, not capture time.
  }, []);

  const start = useCallback(async () => {
    if (disabled || recording) return;
    setError(null);
    cancelled.current = false;
    peaks.current = [];

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it in your browser settings.'
        : name === 'NotFoundError' ? 'No microphone found.'
        : 'Could not start recording.');
      return;
    }

    stream.current = media;
    haptic('capture');

    const ctx = new AudioContext();
    audioCtx.current = ctx;
    const node = ctx.createAnalyser();
    node.fftSize = 512;
    ctx.createMediaStreamSource(media).connect(node);
    analyser.current = node;

    // Safari has no Opus-in-WebM encoder; taking the first supported type keeps
    // one code path rather than a Safari branch.
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(t => MediaRecorder.isTypeSupported(t)) ?? '';

    const rec = new MediaRecorder(media, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: mime || 'audio/webm' });
      const durationMs = Date.now() - startedAt.current;
      teardown();
      // A tap that never became a hold is not a message.
      if (cancelled.current || blob.size < 512 || durationMs < 400) return;
      onRecorded({ blob, durationMs, peaks: downsample(peaks.current, WAVE_SAMPLES) });
    };

    rec.start(100);
    recorder.current = rec;
    startedAt.current = Date.now();
    setRecording(true);
    raf.current = requestAnimationFrame(sample);
  }, [disabled, recording, onRecorded, sample, teardown]);

  const stop = useCallback((cancel: boolean) => {
    cancelled.current = cancel;
    haptic(cancel ? 'warn' : 'success');
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else teardown();
    recorder.current = null;
  }, [teardown]);

  return (
    <div className="relative flex items-center gap-2">
      {recording && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[3.5rem] flex items-center
                        gap-2 rounded-full glass px-3 py-2">
          <span className="h-2 w-2 shrink-0 animate-pulse-rec rounded-full bg-danger" />
          <span className="font-mono text-xs tabular-nums">{(elapsed / 1000).toFixed(1)}s</span>
          <LiveWave level={level} />
          <span className={cn('shrink-0 text-[11px] transition-colors',
            slide > CANCEL_SLIDE_PX ? 'text-danger' : 'text-ink-dim')}>
            {slide > CANCEL_SLIDE_PX ? 'Release to cancel' : '‹ slide to cancel'}
          </span>
        </div>
      )}

      <button
        aria-label={recording ? 'Release to send' : 'Hold to record a voice message'}
        disabled={disabled}
        onPointerDown={e => {
          // Capture the pointer for this element. Without it, the recording
          // status bar that appears alongside pushes this button aside, the
          // release lands on whatever moved into that spot, and pointerup never
          // fires here — so recording runs forever and nothing is ever sent.
          e.currentTarget.setPointerCapture(e.pointerId);
          startX.current = e.clientX;
          void start();
        }}
        onPointerMove={e => { if (recording) setSlide(Math.max(0, startX.current - e.clientX)); }}
        onPointerUp={() => { if (recording) stop(slide > CANCEL_SLIDE_PX); }}
        onPointerCancel={() => { if (recording) stop(true); }}
        onContextMenu={e => e.preventDefault()}
        className={cn(
          'grid h-11 w-11 shrink-0 touch-none place-items-center rounded-full transition',
          recording
            ? slide > CANCEL_SLIDE_PX ? 'scale-110 bg-danger text-white' : 'scale-110 bg-brand text-brand-ink'
            : 'bg-surface-2 text-ink-dim',
        )}
        style={{ transform: recording ? `translateX(-${Math.min(slide, CANCEL_SLIDE_PX)}px)` : undefined }}
      >
        {recording && slide > CANCEL_SLIDE_PX ? <Trash2 size={18} /> : <Mic size={18} />}
      </button>

      {error && <p role="alert" className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}

/** Live level meter while recording. */
function LiveWave({ level }: { level: number }) {
  return (
    <div className="flex h-6 flex-1 items-center gap-[2px] overflow-hidden">
      {Array.from({ length: 24 }, (_, i) => {
        // A travelling shape rather than 24 identical bars, so it reads as
        // sound rather than a loading indicator.
        const phase = Math.sin((Date.now() / 120) + i * 0.6) * 0.35 + 0.65;
        const h = Math.max(3, level * 22 * phase);
        return <span key={i} className="w-[3px] shrink-0 rounded-full bg-brand"
          style={{ height: h }} />;
      })}
    </div>
  );
}

/**
 * Playback with a static waveform.
 *
 * Peaks come from the message, so nothing has to be decoded to draw it. The
 * played portion is brand-coloured and the rest is dim — position is legible at
 * a glance without a separate progress bar.
 */
export function VoiceMessage({ url, durationMs, peaks, mine }: {
  url: string; durationMs: number; peaks: number[]; mine?: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rate, setRate] = useState(1);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (playing) { el.pause(); } else { void el.play(); }
  };

  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  const bars = peaks.length ? peaks : Array.from({ length: WAVE_SAMPLES }, () => 0.35);

  return (
    <div className={cn('flex items-center gap-3 rounded-2xl px-3 py-2.5',
      mine ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-ink')}>
      <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play voice message'}
        className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full',
          mine ? 'bg-brand-ink/15' : 'bg-white/10')}>
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>

      <div className="flex h-8 flex-1 items-center gap-[2px]">
        {bars.map((p, i) => (
          <span key={i}
            className={cn('flex-1 rounded-full transition-opacity',
              i / bars.length <= progress ? 'opacity-100' : 'opacity-35')}
            style={{
              height: Math.max(3, p * 28),
              background: mine ? 'rgba(8,8,8,0.75)' : '#FFE500',
            }} />
        ))}
      </div>

      <button onClick={cycleRate} aria-label={`Playback speed ${rate}x`}
        className={cn('shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px]',
          mine ? 'bg-brand-ink/15' : 'bg-white/10')}>
        {rate}×
      </button>

      <span className="shrink-0 font-mono text-[11px] tabular-nums opacity-70">
        {formatMs(playing ? progress * durationMs : durationMs)}
      </span>

      <audio ref={audio} src={url} preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setProgress(0); }}
        onTimeUpdate={e => {
          const el = e.currentTarget;
          // Browsers report Infinity for WebM duration until fully buffered, so
          // the recorded value is used rather than el.duration.
          if (durationMs > 0) setProgress(Math.min(1, (el.currentTime * 1000) / durationMs));
        }} />
    </div>
  );
}

/** Averages the raw sample stream down to a fixed bar count. */
function downsample(input: number[], count: number): number[] {
  if (!input.length) return Array.from({ length: count }, () => 0.3);
  const size = Math.ceil(input.length / count);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const slice = input.slice(i * size, (i + 1) * size);
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0);
  }
  const max = Math.max(...out, 0.01);
  // Normalised so a quiet recording still shows a readable shape.
  return out.map(v => Math.min(1, v / max));
}

const formatMs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
