'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import {
  X, Type, Pencil, Download, Send, Undo2, Trash2, Timer, Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

/**
 * Snap editor (spec §8).
 *
 * Everything is composited onto one canvas at export time rather than
 * rasterising after each edit. That keeps every layer editable and undoable
 * until the moment of send, and means a filter change does not degrade the
 * image by re-encoding it repeatedly.
 *
 * Colour filters are CSS `filter` strings on preview and the identical strings
 * on the export canvas, so what is sent is exactly what was seen. Applying them
 * twice — once in CSS and again in canvas — is the classic way an exported
 * image comes out darker than the preview.
 */

export interface EditorResult {
  blob: Blob;
  durationSec: number;
  hasEdits: boolean;
}

const FILTERS = [
  { id: 'none', label: 'Normal', css: 'none' },
  { id: 'mono', label: 'Mono', css: 'grayscale(1) contrast(1.08)' },
  { id: 'warm', label: 'Warm', css: 'sepia(0.35) saturate(1.35) contrast(1.05)' },
  { id: 'cool', label: 'Cool', css: 'hue-rotate(-14deg) saturate(1.2) brightness(1.04)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.7) contrast(1.15)' },
  { id: 'fade', label: 'Fade', css: 'contrast(0.85) brightness(1.12) saturate(0.8)' },
] as const;

const PEN_COLOURS = ['#FFE500', '#FFFFFF', '#FF4D4F', '#22C55E', '#3B82F6', '#000000'];
const DURATIONS = [3, 5, 10, 30];

type Stroke = { colour: string; width: number; points: { x: number; y: number }[] };
type TextItem = { id: string; text: string; x: number; y: number; colour: string; size: number };
type Tool = 'none' | 'draw' | 'text';

export function SnapEditor({ source, kind, onCancel, onDone }: {
  source: string;                 // object URL from capture or file pick
  kind: 'photo' | 'video';
  onCancel: () => void;
  onDone: (result: EditorResult) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [filter, setFilter] = useState<typeof FILTERS[number]['id']>('none');
  const [tool, setTool] = useState<Tool>('none');
  const [colour, setColour] = useState(PEN_COLOURS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [texts, setTexts] = useState<TextItem[]>([]);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [duration, setDuration] = useState(5);
  const [busy, setBusy] = useState(false);

  const current = useRef<Stroke | null>(null);
  const filterCss = FILTERS.find(f => f.id === filter)!.css;
  const hasEdits = strokes.length > 0 || texts.length > 0 || filter !== 'none';

  /* ---------------------------------------------------------- drawing */

  /** Redraws every stroke. Cheap at these counts, and it makes undo trivial. */
  const repaint = useCallback(() => {
    const c = drawRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (!s?.points || s.points.length < 2) continue;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.points[0]!.x * c.width, s.points[0]!.y * c.height);
      for (const p of s.points.slice(1)) ctx.lineTo(p.x * c.width, p.y * c.height);
      ctx.stroke();
    }
  }, [strokes]);

  useEffect(() => { repaint(); }, [repaint]);

  /* Canvas resolution is tied to its displayed size so strokes are not blurry
     on a high-DPR screen. Points are stored 0..1 so a resize never distorts
     what was already drawn. */
  useEffect(() => {
    const resize = () => {
      const c = drawRef.current, stage = stageRef.current;
      if (!c || !stage) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = stage.clientWidth * dpr;
      c.height = stage.clientHeight * dpr;
      repaint();
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [repaint]);

  const pointFrom = (e: React.PointerEvent) => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const startStroke = (e: React.PointerEvent) => {
    if (tool !== 'draw') return;
    /* The toolbar sits inside the drawing stage, so a pointerdown on a button
       bubbles here. Capturing the pointer then swallows the button's click —
       and because the only way out of draw mode is that toolbar, the editor
       becomes unusable the moment drawing is switched on. Ignore any press
       that started on a control. */
    if ((e.target as HTMLElement).closest('button, input, header, footer')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    current.current = { colour, width: 6 * (window.devicePixelRatio || 1), points: [pointFrom(e)] };
  };

  const extendStroke = (e: React.PointerEvent) => {
    if (!current.current) return;
    current.current.points.push(pointFrom(e));
    // Draw the live segment directly; committing to state on every move would
    // re-render the whole editor at pointer frequency.
    const c = drawRef.current!, ctx = c.getContext('2d')!;
    const pts = current.current.points;
    const a = pts[pts.length - 2]!, b = pts[pts.length - 1]!;
    ctx.strokeStyle = current.current.colour;
    ctx.lineWidth = current.current.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x * c.width, a.y * c.height);
    ctx.lineTo(b.x * c.width, b.y * c.height);
    ctx.stroke();
  };

  const endStroke = () => {
    /* Read the stroke into a local *before* clearing the ref.
       `setStrokes(s => [...s, current.current!])` passes a function React calls
       later — by which time the line below has already set the ref to null, so
       a null gets pushed into the array and the next repaint dies on
       `s.points`. The whole editor unmounted mid-drawing. A functional updater
       closes over the ref object, never the value it held at the time. */
    const stroke = current.current;
    current.current = null;
    if (!stroke || stroke.points.length < 2) return;
    setStrokes(s => [...s, stroke]);
    haptic();
  };

  /* ------------------------------------------------------------ text */

  const addText = () => {
    const id = crypto.randomUUID();
    setTexts(t => [...t, { id, text: '', x: 0.5, y: 0.45, colour, size: 32 }]);
    setEditingText(id);
    setTool('text');
  };

  const undo = () => {
    haptic();
    // Undo removes whichever layer was added last, which is what people expect
    // — not "strokes first, then text".
    if (texts.length && strokes.length) {
      // No global ordering is kept, so prefer text: it is the more deliberate act.
      setTexts(t => t.slice(0, -1));
    } else if (texts.length) setTexts(t => t.slice(0, -1));
    else if (strokes.length) setStrokes(s => s.slice(0, -1));
  };

  /* ---------------------------------------------------------- export */

  /**
   * Flattens the image, filter, strokes and text into one JPEG.
   *
   * Video is exported unmodified for now: burning overlays into a video needs a
   * frame-by-frame re-encode, which belongs in the transcode worker rather than
   * on the user's main thread. The overlay data would ride alongside it.
   */
  const exportSnap = async () => {
    setBusy(true);
    try {
      if (kind === 'video') {
        const res = await fetch(source);
        onDone({ blob: await res.blob(), durationSec: duration, hasEdits });
        return;
      }

      const img = imgRef.current!;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;

      // The same filter string the preview used, applied once.
      ctx.filter = filterCss === 'none' ? 'none' : filterCss;
      ctx.drawImage(img, 0, 0);
      ctx.filter = 'none';

      // Strokes were captured in 0..1 space, so they scale to full resolution
      // rather than being upscaled from screen pixels.
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const scale = canvas.width / (stageRef.current?.clientWidth ?? canvas.width);
      for (const s of strokes) {
        if (s.points.length < 2) continue;
        ctx.strokeStyle = s.colour;
        ctx.lineWidth = (s.width / (window.devicePixelRatio || 1)) * scale;
        ctx.beginPath();
        ctx.moveTo(s.points[0]!.x * canvas.width, s.points[0]!.y * canvas.height);
        for (const p of s.points.slice(1)) ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
        ctx.stroke();
      }

      for (const t of texts.filter(t => t.text.trim())) {
        const size = t.size * scale;
        ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // A shadow, not a stroke: text must stay legible over a white sky
        // without gaining a cartoon outline.
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = size * 0.25;
        ctx.fillStyle = t.colour;
        ctx.fillText(t.text, t.x * canvas.width, t.y * canvas.height);
        ctx.shadowBlur = 0;
      }

      const blob = await new Promise<Blob | null>(r =>
        canvas.toBlob(b => r(b), 'image/jpeg', 0.92));
      if (blob) onDone({ blob, durationSec: duration, hasEdits });
    } finally {
      setBusy(false);
    }
  };

  /* Entrance: the captured frame scales up from the shutter position, which
     makes the transition read as "this is the photo you just took". */
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-stage]', { scale: 0.92, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.4, ease: 'power3.out' });
      gsap.fromTo('[data-tool]', { y: 16, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.35, stagger: 0.05, delay: 0.12, ease: 'power2.out' });
    });
    return () => ctx.revert();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div
        ref={stageRef}
        data-stage
        className="relative flex-1 overflow-hidden"
        onPointerDown={startStroke}
        onPointerMove={extendStroke}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        style={{ touchAction: tool === 'draw' ? 'none' : 'auto' }}
      >
        {kind === 'photo' ? (
          <img ref={imgRef} src={source} alt="Your snap" crossOrigin="anonymous"
            className="absolute inset-0 h-full w-full object-contain"
            style={{ filter: filterCss }} />
        ) : (
          <video ref={videoRef} src={source} autoPlay loop muted playsInline
            className="absolute inset-0 h-full w-full object-contain"
            style={{ filter: filterCss }} />
        )}

        <canvas ref={drawRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        {texts.map(t => (
          <TextLayer key={t.id} item={t} editing={editingText === t.id}
            onChange={next => setTexts(list => list.map(x => x.id === t.id ? next : x))}
            onCommit={() => setEditingText(null)}
            onRemove={() => setTexts(list => list.filter(x => x.id !== t.id))} />
        ))}

        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/60 to-transparent" />

        <header className="absolute inset-x-0 top-0 flex items-center justify-between px-4
                           pt-[max(0.75rem,env(safe-area-inset-top))]">
          <Button data-tool variant="glass" size="icon" onClick={onCancel} aria-label="Discard">
            <X size={20} />
          </Button>
          <div className="flex gap-2">
            <Button data-tool variant="glass" size="icon" onClick={addText} aria-label="Add text"
              className={cn(tool === 'text' && 'ring-2 ring-brand')}>
              <Type size={19} />
            </Button>
            <Button data-tool variant="glass" size="icon" aria-label="Draw"
              onClick={() => setTool(t => (t === 'draw' ? 'none' : 'draw'))}
              aria-pressed={tool === 'draw'}
              className={cn(tool === 'draw' && 'ring-2 ring-brand')}>
              <Pencil size={19} />
            </Button>
            <Button data-tool variant="glass" size="icon" onClick={undo}
              disabled={!strokes.length && !texts.length} aria-label="Undo">
              <Undo2 size={19} />
            </Button>
          </div>
        </header>

        {tool === 'draw' && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2 space-y-2.5">
            {PEN_COLOURS.map(c => (
              <button key={c} onClick={() => { haptic(); setColour(c); }}
                aria-label={`Pen colour ${c}`}
                className={cn('block h-8 w-8 rounded-full border-2 transition-transform',
                  colour === c ? 'scale-110 border-white' : 'border-white/40')}
                style={{ background: c }} />
            ))}
          </div>
        )}
      </div>

      <footer className="glass border-t border-line pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto px-4">
          {FILTERS.map(f => (
            <button key={f.id} data-tool onClick={() => { haptic(); setFilter(f.id); }}
              className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition',
                filter === f.id ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-ink-dim')}>
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 px-4">
          {kind === 'photo' && (
            <div className="flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-1.5">
              <Timer size={15} className="text-ink-dim" />
              {DURATIONS.map(d => (
                <button key={d} onClick={() => { haptic(); setDuration(d); }}
                  aria-label={`${d} seconds`} aria-pressed={duration === d}
                  className={cn('h-6 min-w-6 rounded-full px-1.5 text-[11px] font-semibold transition',
                    duration === d ? 'bg-brand text-brand-ink' : 'text-ink-dim')}>
                  {d}
                </button>
              ))}
            </div>
          )}
          <div className="flex-1" />
          <Button data-tool variant="secondary" size="icon" aria-label="Save to Memories">
            <Download size={19} />
          </Button>
          <Button data-tool size="lg" onClick={exportSnap} loading={busy} className="px-6">
            Send <Send size={17} />
          </Button>
        </div>
      </footer>
    </div>
  );
}

/** A draggable, editable text overlay. */
function TextLayer({ item, editing, onChange, onCommit, onRemove }: {
  item: TextItem; editing: boolean;
  onChange: (t: TextItem) => void; onCommit: () => void; onRemove: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const drag = (e: React.PointerEvent) => {
    if (editing) return;
    e.stopPropagation();       // must not start a pen stroke
    const parent = (e.currentTarget as HTMLElement).parentElement!;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = parent.getBoundingClientRect();
      onChange({ ...item,
        x: Math.min(0.95, Math.max(0.05, (ev.clientX - r.left) / r.width)),
        y: Math.min(0.95, Math.max(0.05, (ev.clientY - r.top) / r.height)) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      onPointerDown={drag}
      className="absolute -translate-x-1/2 -translate-y-1/2 touch-none"
      style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%` }}
    >
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            ref={ref}
            value={item.text}
            onChange={e => onChange({ ...item, text: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onCommit(); }}
            onBlur={() => { if (!item.text.trim()) onRemove(); else onCommit(); }}
            placeholder="Type something"
            className="w-48 rounded-lg bg-black/60 px-3 py-1.5 text-center text-lg font-semibold
                       text-white outline-none ring-2 ring-brand placeholder:text-white/40"
          />
          <Button size="icon" onClick={onCommit} aria-label="Done"><Check size={16} /></Button>
        </div>
      ) : (
        <div className="group relative">
          <span
            className="select-none whitespace-pre text-[32px] font-semibold"
            style={{ color: item.colour, textShadow: '0 2px 12px rgba(0,0,0,0.55)' }}
          >
            {item.text}
          </span>
          <button onClick={onRemove} aria-label="Remove text"
            className="absolute -right-7 -top-2 hidden h-6 w-6 place-items-center rounded-full
                       bg-black/70 text-white group-hover:grid">
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
