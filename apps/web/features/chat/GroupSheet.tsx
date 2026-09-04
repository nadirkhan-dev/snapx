'use client';
import { useCallback, useEffect, useState } from 'react';
import { Crown, Shield, UserMinus, LogOut, BellOff, Bell, Pencil, UserPlus } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Avatar, Skeleton } from '@/components/ui/bits';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/features/auth/store';
import { cn } from '@/lib/cn';

interface Member {
  id: string; username: string; display_name: string;
  role: 'owner' | 'admin' | 'member'; muted: boolean;
}
interface GroupDetail {
  id: string; title: string | null; myRole: 'owner' | 'admin' | 'member'; members: Member[];
}
interface Friend { id: string; display_name: string; username: string }

/**
 * Group management (spec §13).
 *
 * Actions are shown by role rather than shown-and-rejected: an admin never sees
 * a "Make admin" button that will 403, because a control that exists only to
 * refuse you is worse than one that is absent.
 */
export function GroupSheet({ conversationId, onClose, onChanged, onLeft }: {
  conversationId: string; onClose: () => void; onChanged: () => void; onLeft: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [g, setG] = useState<GroupDetail | null>(null);
  const [adding, setAdding] = useState(false);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<GroupDetail>(`/chat/conversations/${conversationId}/members`);
      setG(d); setTitle(d.title ?? '');
    } catch { onClose(); }
  }, [conversationId, onClose]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done); await load(); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'That did not work', 'error'); }
    finally { setBusy(false); }
  };

  const openAdd = async () => {
    setAdding(true);
    const all = await api<Friend[]>('/friends').catch(() => []);
    // Only offer people who are not already in the group.
    const present = new Set(g?.members.map(m => m.id));
    setFriends(all.filter(f => !present.has(f.id)));
  };

  const canManage = g?.myRole === 'owner' || g?.myRole === 'admin';
  const me = g?.members.find(m => m.id === user?.id);

  return (
    <div className="fixed inset-0 z-[75] flex flex-col justify-end bg-black/70" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="max-h-[85vh] overflow-y-auto rounded-t-3xl glass pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="sticky top-0 flex justify-center rounded-t-3xl glass pb-2 pt-3">
          <div className="h-1 w-10 rounded-full bg-white/25" />
        </div>

        {!g ? <div className="px-6 pb-6"><Skeleton rows={4} /></div> : (
          <>
            <div className="flex items-center gap-2 px-6 pb-4">
              {renaming ? (
                <>
                  <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
                    aria-label="Group name"
                    className="h-10 flex-1 rounded-xl border border-line bg-surface px-3 text-sm
                               focus:border-brand focus:outline-none" />
                  <button className="text-sm font-semibold text-brand" disabled={busy}
                    onClick={() => act(() => api(`/chat/conversations/${g.id}/rename`,
                      { method: 'POST', body: { title } }), 'Renamed').then(() => setRenaming(false))}>
                    Save
                  </button>
                </>
              ) : (
                <>
                  <h2 className="flex-1 text-lg font-semibold">{g.title ?? 'Group'}</h2>
                  {canManage && (
                    <button onClick={() => setRenaming(true)} aria-label="Rename group"
                      className="grid h-9 w-9 place-items-center rounded-full bg-surface-2">
                      <Pencil size={15} />
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="flex gap-2 px-6 pb-4">
              {canManage && (
                <button onClick={openAdd}
                  className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs">
                  <UserPlus size={14} /> Add people
                </button>
              )}
              <button
                onClick={() => act(() => api(`/chat/conversations/${g.id}/mute`, {
                  method: 'POST',
                  body: { until: me?.muted ? null : new Date(Date.now() + 8 * 3600_000).toISOString() },
                }), me?.muted ? 'Unmuted' : 'Muted for 8 hours')}
                className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs">
                {me?.muted ? <><Bell size={14} /> Unmute</> : <><BellOff size={14} /> Mute</>}
              </button>
            </div>

            <p className="px-6 pb-2 text-xs uppercase tracking-wider text-ink-faint">
              {g.members.length} members
            </p>

            <div className="px-4">
              {g.members.map(m => (
                <div key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
                  <Avatar name={m.display_name} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {m.display_name}
                      {m.role === 'owner' && <Crown size={12} className="text-brand" aria-label="Owner" />}
                      {m.role === 'admin' && <Shield size={12} className="text-ink-dim" aria-label="Admin" />}
                    </p>
                    <p className="truncate text-xs text-ink-dim">@{m.username}</p>
                  </div>

                  {g.myRole === 'owner' && m.role !== 'owner' && (
                    <button disabled={busy}
                      onClick={() => act(() => api(
                        `/chat/conversations/${g.id}/members/${m.id}/role`,
                        { method: 'POST', body: { role: m.role === 'admin' ? 'member' : 'admin' } }),
                        m.role === 'admin' ? 'Now a member' : 'Now an admin')}
                      className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px]">
                      {m.role === 'admin' ? 'Demote' : 'Make admin'}
                    </button>
                  )}

                  {canManage && m.role !== 'owner' && m.id !== user?.id && (
                    <button disabled={busy} aria-label={`Remove ${m.display_name}`}
                      onClick={() => act(() => api(
                        `/chat/conversations/${g.id}/members/${m.id}`, { method: 'DELETE' }), 'Removed')}
                      className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-ink-dim">
                      <UserMinus size={15} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="px-6 pt-4">
              <button
                onClick={() => act(async () => {
                  await api(`/chat/conversations/${g.id}/leave`, { method: 'POST' });
                  onLeft();
                }, 'You left the group')}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-danger/10
                           py-3 text-sm font-medium text-danger">
                <LogOut size={16} /> Leave group
              </button>
              {g.myRole === 'owner' && (
                <p className="pt-2 text-center text-[11px] text-ink-faint">
                  Ownership passes to the longest-standing member.
                </p>
              )}
            </div>
          </>
        )}

        {adding && (
          <div className="fixed inset-0 z-[80] flex flex-col justify-end bg-black/70"
            onClick={() => setAdding(false)}>
            <div onClick={e => e.stopPropagation()}
              className="max-h-[60vh] overflow-y-auto rounded-t-3xl glass p-4">
              <h3 className="px-2 pb-3 text-base font-semibold">Add to group</h3>
              {friends.length === 0
                ? <p className="px-2 pb-4 text-sm text-ink-dim">All your friends are already here.</p>
                : friends.map(f => (
                  <button key={f.id} disabled={busy}
                    onClick={() => act(() => api(`/chat/conversations/${conversationId}/members`,
                      { method: 'POST', body: { userIds: [f.id] } }), `Added ${f.display_name}`)
                      .then(() => setAdding(false))}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left">
                    <Avatar name={f.display_name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{f.display_name}</p>
                      <p className="truncate text-xs text-ink-dim">@{f.username}</p>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Call history (spec §21). Lives beside chat because that is where people look. */
export function CallHistory() {
  const [rows, setRows] = useState<{
    id: string; type: string; status: string; outgoing: boolean;
    display_name: string; created_at: string; duration_sec: number | null;
  }[] | null>(null);

  useEffect(() => { void api<never[]>('/calls/history').then(setRows).catch(() => setRows([])); }, []);

  if (!rows) return <Skeleton rows={3} />;
  if (!rows.length) {
    return <p className="px-4 py-6 text-center text-sm text-ink-dim">No calls yet.</p>;
  }

  return (
    <div className="px-2">
      {rows.map(r => (
        <div key={r.id} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
          <Avatar name={r.display_name} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{r.display_name}</p>
            <p className={cn('text-xs',
              r.status === 'missed' && !r.outgoing ? 'text-danger' : 'text-ink-dim')}>
              {r.outgoing ? '↗' : '↙'} {r.type} · {r.status}
              {r.duration_sec ? ` · ${formatDur(r.duration_sec)}` : ''}
            </p>
          </div>
          <span className="text-[11px] text-ink-faint">{timeAgo(r.created_at)}</span>
        </div>
      ))}
    </div>
  );
}

const formatDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const timeAgo = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
};
