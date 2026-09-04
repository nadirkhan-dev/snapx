'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import gsap from 'gsap';
import { X, Eye, Send, Plus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/store';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/bits';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

interface StoryItem { id: string; mediaId: string; caption: string | null; createdAt: string; seen: boolean }
interface AuthorGroup {
  author_id: string; username: string; display_name: string;
  is_me: boolean; all_seen: boolean; story_count: number; stories: StoryItem[];
}
interface Viewed { id: string; caption: string | null; mimeType: string; url: string }
interface Viewer { id: string; username: string; display_name: string; viewed_at: string; reaction: string | null }

const REACTIONS = ['🔥', '😂', '😍', '👏', '😮', '💯'];

/**
 * Stories (spec §14).
 *
 * The ring is the whole information design: a brand ring means unseen, a dim
 * one means watched. That single distinction is what people scan for, and it
 * costs one conditional.
 */
export function StoriesScreen() {
  const { user } = useAuth();
  const toast = useToast();
  const [groups, setGroups] = useState<AuthorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [watching, setWatching] = useState<{ group: AuthorGroup; index: number } | null>(null);

  const load = useCallback(async () => {
    try { setGroups(await api<AuthorGroup[]>('/stories')); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not load stories', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const mine = groups.find(g => g.is_me);
  const others = groups.filter(g => !g.is_me);

  return (
    <div className="px-4 pb-32 pt-3">
      {/* The ring rail. Yours is always first and always present, so "add to
          story" is one tap from here rather than hidden in the camera. */}
      <div className="no-scrollbar -mx-1 flex gap-4 overflow-x-auto px-1 pb-5">
        <button
          onClick={() => { haptic(); mine ? setWatching({ group: mine, index: 0 }) : toast('Capture something first, then Add to story'); }}
          className="flex w-16 shrink-0 flex-col items-center gap-1.5">
          <span className="relative">
            <Avatar name={user?.displayName ?? 'You'} size={60}
              className={cn(mine && 'ring-2 ring-offset-2 ring-offset-bg ring-brand')} />
            {!mine && (
              <span className="absolute -bottom-0.5 -right-0.5 grid h-6 w-6 place-items-center
                               rounded-full border-2 border-bg bg-brand text-brand-ink">
                <Plus size={13} strokeWidth={3} />
              </span>
            )}
          </span>
          <span className="truncate text-[11px] text-ink-dim">Your story</span>
        </button>

        {others.map(g => (
          <button key={g.author_id} onClick={() => { haptic(); setWatching({ group: g, index: 0 }); }}
            className="flex w-16 shrink-0 flex-col items-center gap-1.5">
            <Avatar name={g.display_name} size={60}
              className={cn('ring-2 ring-offset-2 ring-offset-bg',
                g.all_seen ? 'ring-line' : 'ring-brand')} />
            <span className="truncate text-[11px] text-ink-dim">{g.display_name.split(' ')[0]}</span>
          </button>
        ))}
      </div>

      {loading ? <Skeleton rows={3} />
        : others.length === 0 && !mine
        ? <EmptyState title="No stories yet"
            body="Capture something and tap Add to story. Friends' stories appear here for 24 hours." />
        : null}

      {watching && (
        <StoryViewer
          group={watching.group}
          startIndex={watching.index}
          onClose={() => { setWatching(null); void load(); }}
        />
      )}
    </div>
  );
}

/**
 * Full-screen viewer (spec §15).
 *
 * Tap right advances, tap left goes back, and the segmented bar shows position
 * within the author's set. The timer is per story, not per author — moving to
 * the next one restarts it, which is what makes a long set feel navigable
 * rather than a single countdown you cannot influence.
 */
function StoryViewer({ group, startIndex, onClose }: {
  group: AuthorGroup; startIndex: number; onClose: () => void;
}) {
  const toast = useToast();
  const [index, setIndex] = useState(startIndex);
  const [item, setItem] = useState<Viewed | null>(null);
  const [viewers, setViewers] = useState<Viewer[] | null>(null);
  const [paused, setPaused] = useState(false);
  const [mounted, setMounted] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const tween = useRef<gsap.core.Tween | null>(null);

  useEffect(() => setMounted(true), []);

  const story = group.stories[index];

  const advance = useCallback(() => {
    setIndex(i => {
      if (i + 1 < group.stories.length) return i + 1;
      onClose();
      return i;
    });
  }, [group.stories.length, onClose]);

  // Load the current story. Marking it viewed is a server side-effect of this
  // call, so a story cannot be counted as seen without its media being fetched.
  useEffect(() => {
    if (!story) return;
    setItem(null);
    setViewers(null);
    let cancelled = false;
    void (async () => {
      try {
        const v = await api<Viewed>(`/stories/${story.id}/view`, { method: 'POST' });
        if (!cancelled) setItem(v);
      } catch {
        if (!cancelled) { toast('That story has expired', 'error'); advance(); }
      }
    })();
    return () => { cancelled = true; };
  }, [story, advance, toast]);

  // 5s per story, restarted on each change and pausable by holding.
  useEffect(() => {
    if (!item) return;
    tween.current = gsap.fromTo(barRef.current,
      { scaleX: 0 },
      { scaleX: 1, duration: 5, ease: 'none', transformOrigin: 'left center', onComplete: advance });
    return () => { tween.current?.kill(); };
  }, [item, advance]);

  useEffect(() => {
    if (paused) tween.current?.pause(); else tween.current?.play();
  }, [paused]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') advance();
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [advance, onClose]);

  const react = async (emoji: string) => {
    haptic('success');
    try {
      await api(`/stories/${story!.id}/react`, { method: 'POST', body: { emoji } });
      toast(`Reacted ${emoji}`);
    } catch { toast('Could not react', 'error'); }
  };

  const showViewers = async () => {
    setPaused(true);
    try { setViewers(await api<Viewer[]>(`/stories/${story!.id}/viewers`)); }
    catch { toast('Only the author can see viewers', 'error'); setPaused(false); }
  };

  if (!mounted || !story) return null;

  return createPortal(
    <div className="fixed inset-0 z-[85] flex flex-col bg-black">
      {/* Segmented progress — one bar per story in the set. */}
      <div className="flex gap-1 px-2 pt-2">
        {group.stories.map((s, i) => (
          <div key={s.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/25">
            <div
              ref={i === index ? barRef : undefined}
              className={cn('h-full bg-white', i < index && 'scale-x-100')}
              style={{ transformOrigin: 'left center', transform: i < index ? 'scaleX(1)' : 'scaleX(0)' }}
            />
          </div>
        ))}
      </div>

      <header className="flex items-center justify-between px-4 pt-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={group.display_name} size={32} />
          <div>
            <p className="text-sm font-medium">{group.is_me ? 'Your story' : group.display_name}</p>
            <p className="text-[11px] text-ink-dim">{timeAgo(story.createdAt)}</p>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close"
          className="grid h-9 w-9 place-items-center rounded-full glass"><X size={18} /></button>
      </header>

      {/* Tap zones. Deliberately invisible: a visible hit target here would
          compete with the photo for attention. */}
      <div className="relative flex-1">
        {item ? (
          item.mimeType.startsWith('video')
            ? <video src={item.url} autoPlay playsInline className="h-full w-full object-contain" />
            : <img src={item.url} alt={item.caption ?? 'Story'} className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        )}

        <button aria-label="Previous" onClick={() => setIndex(i => Math.max(0, i - 1))}
          onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)}
          className="absolute inset-y-0 left-0 w-1/3" />
        <button aria-label="Next" onClick={advance}
          onPointerDown={() => setPaused(true)} onPointerUp={() => setPaused(false)}
          className="absolute inset-y-0 right-0 w-2/3" />

        {item?.caption && (
          <p className="pointer-events-none absolute inset-x-0 bottom-4 px-6 text-center text-[15px]
                        font-medium" style={{ textShadow: '0 2px 12px rgba(0,0,0,0.7)' }}>
            {item.caption}
          </p>
        )}
      </div>

      <footer className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {group.is_me ? (
          <button onClick={showViewers}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-surface-2 py-3 text-sm">
            <Eye size={16} /> See who viewed
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex flex-1 justify-around">
              {REACTIONS.map(e => (
                <button key={e} onClick={() => react(e)} aria-label={`React ${e}`}
                  className="text-2xl transition-transform active:scale-125">{e}</button>
              ))}
            </div>
            <button aria-label="Reply" className="grid h-11 w-11 place-items-center rounded-full bg-surface-2">
              <Send size={17} />
            </button>
          </div>
        )}
      </footer>

      {viewers && (
        <div className="absolute inset-0 z-10 flex flex-col justify-end bg-black/70"
          onClick={() => { setViewers(null); setPaused(false); }}>
          <div onClick={e => e.stopPropagation()}
            className="max-h-[60vh] overflow-y-auto rounded-t-3xl glass p-6">
            <h2 className="mb-4 text-lg font-semibold">Viewed by {viewers.length}</h2>
            {viewers.length === 0
              ? <p className="pb-4 text-sm text-ink-dim">Nobody yet.</p>
              : viewers.map(v => (
                <div key={v.id} className="flex items-center gap-3 py-2.5">
                  <Avatar name={v.display_name} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{v.display_name}</p>
                    <p className="text-xs text-ink-dim">{timeAgo(v.viewed_at)}</p>
                  </div>
                  {v.reaction && <span className="text-lg">{v.reaction}</span>}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}
