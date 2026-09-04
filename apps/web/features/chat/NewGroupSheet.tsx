'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Avatar, EmptyState } from '@/components/ui/bits';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

interface Friend { id: string; display_name: string; username: string }

/**
 * Group creation (spec §13).
 *
 * Only friends can be added — the API enforces it, and offering non-friends
 * here would just produce a request the server rejects. The name defaults to
 * the members' first names, because most groups never get renamed and an
 * untitled list of "New group" entries is unusable.
 */
export function NewGroupSheet({ onClose, onCreated }: {
  onClose: () => void; onCreated: () => void;
}) {
  const toast = useToast();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [touchedTitle, setTouchedTitle] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api<Friend[]>('/friends').then(setFriends).catch(() => {}); }, []);

  const toggle = (id: string) => {
    haptic();
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      // Suggest a name until the person edits it themselves.
      if (!touchedTitle) {
        const names = friends.filter(f => next.has(f.id)).map(f => f.display_name.split(' ')[0]);
        setTitle(names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''));
      }
      return next;
    });
  };

  const create = async () => {
    setBusy(true);
    try {
      await api('/chat/conversations/group', {
        method: 'POST',
        body: { title: title.trim() || 'New group', memberIds: [...picked] },
      });
      toast(`Group created with ${picked.size + 1} people`);
      onCreated();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not create the group', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[75] flex flex-col justify-end bg-black/70" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="max-h-[80vh] overflow-y-auto rounded-t-3xl glass pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="sticky top-0 flex justify-center rounded-t-3xl glass pb-2 pt-3">
          <div className="h-1 w-10 rounded-full bg-white/25" />
        </div>

        <h2 className="px-6 pb-3 text-lg font-semibold">New group</h2>

        <div className="px-6 pb-4">
          <input
            value={title}
            onChange={e => { setTitle(e.target.value); setTouchedTitle(true); }}
            placeholder="Group name"
            aria-label="Group name"
            className="h-11 w-full rounded-xl border border-line bg-surface px-4 text-sm
                       placeholder:text-ink-faint focus:border-brand focus:outline-none"
          />
        </div>

        <div className="px-4">
          {friends.length === 0
            ? <EmptyState title="No friends yet" body="Add someone before creating a group." />
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
          <button onClick={onClose}
            className="h-12 flex-1 rounded-xl bg-surface-2 text-sm font-medium">Cancel</button>
          <button onClick={() => void create()} disabled={!picked.size || busy}
            className="h-12 flex-1 rounded-xl bg-brand text-sm font-semibold text-brand-ink
                       disabled:opacity-40">
            {busy ? 'Creating…' : `Create${picked.size ? ` · ${picked.size + 1}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
