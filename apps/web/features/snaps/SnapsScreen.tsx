'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { Square, Play, RotateCcw, X } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/bits';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

interface InboxRow {
  id: string; snap_id: string; type: 'photo' | 'video';
  duration_sec: number; status: string;
  delivered_at: string; opened_at: string | null; replay_count: number;
  sender_id: string; username: string; display_name: string;
}

interface OpenedSnap {
  id: string; durationSec: number; isReplay: boolean;
  replaysLeft: number; expiresAt: string; mimeType: string; url: string;
}

/**
 * Snap inbox (spec §9).
 *
 * Unopened snaps show a filled square; opened ones show an outline. That
 * distinction is the whole information design of the screen — you should be
 * able to tell at a glance what is waiting for you.
 */
export function SnapsScreen() {
  const toast = useToast();
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<{ meta: InboxRow; snap: OpenedSnap } | null>(null);

  const load = useCallback(async () => {
    try { setRows(await api<InboxRow[]>('/snaps')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = async (row: InboxRow) => {
    haptic();
    try {
      const snap = await api<OpenedSnap>(`/snaps/${row.id}/open`, { method: 'POST' });
      setViewing({ meta: row, snap });
    } catch (e) {
      // An expired snap disappearing on tap is normal, not an error worth
      // dressing up — refresh so the row goes away too.
      toast(e instanceof ApiError ? e.message : 'That snap is gone', 'error');
      void load();
    }
  };

  const unopened = rows.filter(r => r.status !== 'opened');
  const opened = rows.filter(r => r.status === 'opened');

  return (
    <div className="px-5 pb-32 pt-2">
      {loading ? <Skeleton rows={4} />
        : rows.length === 0
        ? <EmptyState title="No snaps yet"
            body="When a friend sends you one it appears here. Tap to open — you get one replay." />
        : (
          <div className="space-y-1">
            {unopened.length > 0 && (
              <h2 className="px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-brand">
                New · {unopened.length}
              </h2>
            )}
            {unopened.map(r => <SnapRow key={r.id} row={r} onOpen={() => open(r)} />)}

            {opened.length > 0 && (
              <h2 className="px-1 pb-1 pt-5 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Opened
              </h2>
            )}
            {opened.map(r => <SnapRow key={r.id} row={r} onOpen={() => open(r)} />)}
          </div>
        )}

      {viewing && (
        <SnapViewer
          snap={viewing.snap}
          from={viewing.meta.display_name}
          onClose={() => { setViewing(null); void load(); }}
        />
      )}
    </div>
  );
}

function SnapRow({ row, onOpen }: { row: InboxRow; onOpen: () => void }) {
  const isNew = row.status !== 'opened';
  const canReplay = row.status === 'opened' && row.replay_count < 1;

  return (
    <button
      onClick={onOpen}
      disabled={row.status === 'opened' && !canReplay}
      className="flex w-full items-center gap-3 rounded-xl px-1 py-3 text-left
                 transition active:scale-[0.99] disabled:opacity-45"
    >
      <Avatar name={row.display_name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.display_name}</p>
        <p className="text-xs text-ink-dim">
          {isNew ? `New ${row.type} · tap to open`
            : canReplay ? 'Opened · tap to replay once'
            : 'Opened'}
        </p>
      </div>
      <span className={cn('grid h-9 w-9 place-items-center rounded-lg',
        isNew ? 'bg-brand text-brand-ink' : 'border border-line text-ink-faint')}>
        {isNew ? <Square size={15} fill="currentColor" />
          : canReplay ? <RotateCcw size={15} /> : <Play size={15} />}
      </span>
    </button>
  );
}

/**
 * Full-screen viewer.
 *
 * The progress bar is driven by `expiresAt` from the server, not by a local
 * duration. If the tab was backgrounded, or the request was slow, or the clocks
 * disagree, the bar still reflects when the media actually stops being
 * fetchable — which is the only deadline that means anything.
 *
 * Holding pauses nothing: the server's clock keeps running. The UI does not
 * pretend otherwise, because a pause that isn't real is a lie the user
 * discovers at the worst moment.
 */
function SnapViewer({ snap, from, onClose }: {
  snap: OpenedSnap; from: string; onClose: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const endsAt = new Date(snap.expiresAt).getTime();
    const remaining = Math.max(0, endsAt - Date.now());

    const tween = gsap.fromTo(bar.current,
      { scaleX: 1 },
      { scaleX: 0, duration: remaining / 1000, ease: 'none', transformOrigin: 'left center' });

    const timer = setTimeout(onClose, remaining);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);

    return () => {
      tween.kill();
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, [snap.expiresAt, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col bg-black" onClick={onClose}>
      <div className="h-1 bg-white/20">
        <div ref={bar} className="h-full bg-brand" />
      </div>

      <header className="flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center gap-2.5">
          <Avatar name={from} size={32} />
          <span className="text-sm font-medium">{from}</span>
        </div>
        <div className="flex items-center gap-3">
          {snap.replaysLeft > 0 && (
            <span className="text-[11px] text-ink-dim">{snap.replaysLeft} replay left</span>
          )}
          <button aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full glass">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center p-4">
        {snap.mimeType.startsWith('video')
          ? <video src={snap.url} autoPlay playsInline controls={false}
              className="max-h-full max-w-full rounded-xl" onEnded={onClose} />
          : <img src={snap.url} alt={`Snap from ${from}`} className="max-h-full max-w-full rounded-xl" />}
      </div>

      <p className="pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center text-[11px] text-ink-faint">
        Tap anywhere to close
      </p>
    </div>,
    document.body,
  );
}

/** Recipient picker, shown after the editor when sending a snap. */
export function SendToSheet({ mediaId, durationSec, onDone, onCancel }: {
  mediaId: string; durationSec: number; onDone: () => void; onCancel: () => void;
}) {
  const toast = useToast();
  const [friends, setFriends] = useState<{ id: string; display_name: string; username: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => { void api<typeof friends>('/friends').then(setFriends).catch(() => {}); }, []);

  const toggle = (id: string) => {
    haptic();
    setPicked(p => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const send = async () => {
    setSending(true);
    try {
      const r = await api<{ sentTo: number; skipped?: number }>('/snaps', {
        method: 'POST',
        body: { mediaId, recipientIds: [...picked], durationSec },
      });
      toast(r.skipped
        ? `Sent to ${r.sentTo} — ${r.skipped} could not receive it`
        : `Sent to ${r.sentTo}`);
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not send', 'error');
    } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-[75] flex flex-col justify-end bg-black/70" onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        className="max-h-[75vh] overflow-y-auto rounded-t-3xl glass pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="sticky top-0 flex justify-center rounded-t-3xl glass pb-2 pt-3">
          <div className="h-1 w-10 rounded-full bg-white/25" />
        </div>
        <h2 className="px-6 pb-3 text-lg font-semibold">Send to</h2>

        <div className="px-4">
          {friends.length === 0
            ? <EmptyState title="No friends yet" body="Add someone before you can send a snap." />
            : friends.map(f => (
              <button key={f.id} onClick={() => toggle(f.id)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left">
                <Avatar name={f.display_name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.display_name}</p>
                  <p className="truncate text-xs text-ink-dim">@{f.username}</p>
                </div>
                <span className={cn('grid h-6 w-6 place-items-center rounded-full border-2',
                  picked.has(f.id) ? 'border-brand bg-brand text-brand-ink' : 'border-line')}>
                  {picked.has(f.id) && <span className="text-[11px]">✓</span>}
                </span>
              </button>
            ))}
        </div>

        <div className="mt-3 flex gap-3 px-6">
          <button onClick={onCancel}
            className="h-12 flex-1 rounded-xl bg-surface-2 text-sm font-medium">Cancel</button>
          <button onClick={send} disabled={!picked.size || sending}
            className="h-12 flex-1 rounded-xl bg-brand text-sm font-semibold text-brand-ink
                       disabled:opacity-40">
            {sending ? 'Sending…' : `Send${picked.size ? ` · ${picked.size}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
