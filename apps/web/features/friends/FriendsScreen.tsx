'use client';
import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Check, X, Search as SearchIcon, UserMinus, Ban, Phone, Video } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/bits';

interface Person {
  id: string; username: string; display_name: string;
  avatar_media_id: string | null; last_seen_at?: string | null;
}
interface Request { id: string; user_id: string; username: string; display_name: string }
interface Hit extends Person { is_friend: boolean; request_pending: boolean }

/**
 * Friends (spec §16).
 *
 * Search, requests and the friend list on one screen. Splitting them across
 * three tabs makes the common journey — find someone, add them, see them
 * appear — into three navigations.
 */
export function FriendsScreen({ onMessage, onCall }: {
  onMessage?: (userId: string) => void;
  onCall?: (userId: string, name: string, kind: 'voice' | 'video') => void;
}) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [friends, setFriends] = useState<Person[]>([]);
  const [incoming, setIncoming] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [f, r] = await Promise.all([
        api<Person[]>('/friends'),
        api<{ incoming: Request[] }>('/friends/requests'),
      ]);
      setFriends(f);
      setIncoming(r.incoming);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Debounced: a request per keystroke is a request per keystroke.
  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api<{ results: Hit[] }>(`/users/search?q=${encodeURIComponent(term)}`);
        setHits(r.results);
      } catch { setHits([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast(done); await refresh(); setTerm(''); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'That did not work', 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-6 px-5 pb-32 pt-2">
      <div className="relative">
        <SearchIcon size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint" />
        <input
          value={term} onChange={e => setTerm(e.target.value)}
          placeholder="Find people by username"
          aria-label="Search for people"
          className="h-12 w-full rounded-xl border border-line bg-surface pl-10 pr-4 text-[15px]
                     placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {term.trim().length >= 2 && (
        <Section title="Results">
          {hits.length === 0
            ? <p className="px-1 text-sm text-ink-dim">Nobody by that name.</p>
            : hits.map(h => (
              <Row key={h.id} person={h}>
                {h.is_friend ? <span className="text-xs text-ok">Friends</span>
                  : h.request_pending ? <span className="text-xs text-ink-dim">Pending</span>
                  : <Button size="sm" loading={busy === h.id}
                      onClick={() => act(h.id, () => api('/friends/requests',
                        { method: 'POST', body: { userId: h.id } }), 'Request sent')}>
                      <UserPlus size={15} /> Add
                    </Button>}
              </Row>
            ))}
        </Section>
      )}

      {incoming.length > 0 && (
        <Section title={`Requests · ${incoming.length}`}>
          {incoming.map(r => (
            <Row key={r.id} person={{ id: r.user_id, username: r.username,
              display_name: r.display_name, avatar_media_id: null }}>
              <div className="flex gap-2">
                <Button size="icon" aria-label="Accept" loading={busy === r.id}
                  onClick={() => act(r.id, () => api(`/friends/requests/${r.id}/accept`,
                    { method: 'POST' }), `You and ${r.display_name} are friends`)}>
                  <Check size={16} />
                </Button>
                <Button size="icon" variant="secondary" aria-label="Decline"
                  onClick={() => act(r.id, () => api(`/friends/requests/${r.id}/reject`,
                    { method: 'POST' }), 'Declined')}>
                  <X size={16} />
                </Button>
              </div>
            </Row>
          ))}
        </Section>
      )}

      <Section title={`Friends · ${friends.length}`}>
        {loading ? <Skeleton rows={3} />
          : friends.length === 0
          ? <EmptyState title="No friends yet"
              body="Search for a username above to send your first request." />
          : friends.map(f => (
            <Row key={f.id} person={f}>
              <div className="flex gap-1.5">
                {onCall && <>
                  <Button size="icon" variant="ghost" aria-label={`Call ${f.display_name}`}
                    onClick={() => onCall(f.id, f.display_name, 'voice')}>
                    <Phone size={16} />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Video call ${f.display_name}`}
                    onClick={() => onCall(f.id, f.display_name, 'video')}>
                    <Video size={16} />
                  </Button>
                </>}
                {onMessage && (
                  <Button size="sm" variant="secondary" onClick={() => onMessage(f.id)}>Chat</Button>
                )}
                <Button size="icon" variant="ghost" aria-label={`Remove ${f.display_name}`}
                  onClick={() => act(f.id, () => api(`/friends/${f.id}`, { method: 'DELETE' }),
                    'Removed')}>
                  <UserMinus size={16} />
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Block ${f.display_name}`}
                  onClick={() => act(f.id, () => api('/friends/blocks',
                    { method: 'POST', body: { userId: f.id } }), 'Blocked')}>
                  <Ban size={16} />
                </Button>
              </div>
            </Row>
          ))}
      </Section>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-1">
    <h2 className="px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-faint">{title}</h2>
    {children}
  </section>
);

function Row({ person, children }: { person: Person; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-1 py-2.5">
      <Avatar name={person.display_name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{person.display_name}</p>
        <p className="truncate text-xs text-ink-dim">@{person.username}</p>
      </div>
      {children}
    </div>
  );
}
