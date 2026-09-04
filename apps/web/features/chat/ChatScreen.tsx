'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Send, Timer, Users, Info, PhoneCall } from 'lucide-react';
import { api } from '@/lib/api';
import { uploadMedia } from '@/lib/upload';
import { VoiceRecorder, VoiceMessage, type VoiceRecording } from './VoiceRecorder';
import { NewGroupSheet } from './NewGroupSheet';
import { GroupSheet, CallHistory } from './GroupSheet';
import { useSocket } from '@/lib/socket';
import { useAuth } from '@/features/auth/store';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/bits';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

interface Conversation {
  id: string; type: string; title: string | null; unread: number;
  last_message_at: string | null; disappear_after_sec: number | null;
  last_message: { type: string; body: string | null; senderId: string } | null;
  others: { id: string; displayName: string; username: string }[] | null;
}

interface Message {
  id: string; conversation_id: string; type: string; body: string | null;
  media_id: string | null;
  sender_id: string; display_name: string | null; created_at: string;
  expires_at: string | null;
}

/** Conversation list, then a thread. Two views, one screen. */
export function ChatScreen({ startWith }: { startWith?: string | null }) {
  const [open, setOpen] = useState<Conversation | null>(null);
  const [list, setList] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroup, setNewGroup] = useState(false);
  const [tab, setTab] = useState<'chats' | 'calls'>('chats');

  const load = useCallback(async () => {
    try { setList(await api<Conversation[]>('/chat/conversations')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A message arriving anywhere refreshes the list, so unread counts and
  // ordering stay live without a poll.
  const { on } = useSocket();
  useEffect(() => on('message:new', () => { void load(); }), [on, load]);

  // Opening a thread from the friends screen.
  useEffect(() => {
    if (!startWith) return;
    void (async () => {
      const { id } = await api<{ id: string }>('/chat/conversations/direct',
        { method: 'POST', body: { userId: startWith } });
      const fresh = await api<Conversation[]>('/chat/conversations');
      setList(fresh);
      setOpen(fresh.find(c => c.id === id) ?? null);
    })();
  }, [startWith]);

  if (open) return <Thread conversation={open} onBack={() => { setOpen(null); void load(); }} />;

  return (
    <div className="px-3 pb-32 pt-2">
      <div className="mb-3 flex gap-1 rounded-full bg-surface p-1">
        {(['chats', 'calls'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-xs font-medium capitalize',
              tab === t ? 'bg-surface-2 text-ink' : 'text-ink-dim')}>
            {t === 'calls' && <PhoneCall size={13} />}{t}
          </button>
        ))}
      </div>

      {tab === 'calls' && <CallHistory />}

      {tab === 'chats' && <>
      <button onClick={() => setNewGroup(true)}
        className="mb-2 flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left active:scale-[0.99]">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-brand text-brand-ink">
          <Users size={19} />
        </span>
        <span className="text-sm font-medium">New group</span>
      </button>

      {newGroup && (
        <NewGroupSheet
          onClose={() => setNewGroup(false)}
          onCreated={() => { setNewGroup(false); void load(); }} />
      )}

      {loading ? <Skeleton rows={4} />
        : list.length === 0
        ? <EmptyState title="No conversations yet"
            body="Message a friend from the Friends tab and it will appear here." />
        : list.map(c => {
          const other = c.others?.[0];
          const name = c.title ?? other?.displayName ?? 'Conversation';
          return (
            <button key={c.id} onClick={() => { haptic(); setOpen(c); }}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left active:scale-[0.99]">
              <Avatar name={name} size={46} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  {c.disappear_after_sec && <Timer size={13} className="shrink-0 text-brand" />}
                </div>
                <p className={cn('truncate text-xs',
                  c.unread ? 'font-medium text-ink' : 'text-ink-dim')}>
                  {c.last_message?.body ?? (c.last_message ? `[${c.last_message.type}]` : 'No messages yet')}
                </p>
              </div>
              {c.unread > 0 && (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5
                                 text-[11px] font-bold text-brand-ink">{c.unread}</span>
              )}
            </button>
          );
        })}
      </>}
    </div>
  );
}

function Thread({ conversation, onBack }: { conversation: Conversation; onBack: () => void }) {
  const { user } = useAuth();
  const { socket, on, connected } = useSocket();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [theyType, setTheyType] = useState(false);
  const [loading, setLoading] = useState(true);
  const [groupInfo, setGroupInfo] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const typingSent = useRef(0);

  const name = conversation.title ?? conversation.others?.[0]?.displayName ?? 'Conversation';

  useEffect(() => {
    void (async () => {
      try {
        setMessages(await api<Message[]>(`/chat/conversations/${conversation.id}/messages`));
        socket.emit('message:read', { conversationId: conversation.id });
      } finally { setLoading(false); }
    })();
  }, [conversation.id, socket]);

  useEffect(() => on<Message>('message:new', m => {
    if (m.conversation_id !== conversation.id) return;
    setMessages(prev => {
      // The optimistic copy is replaced by the server's, matched on nonce.
      // Without this the sender sees their own message twice.
      if (prev.some(p => p.id === m.id)) return prev;
      return [...prev, m];
    });
    socket.emit('message:read', { conversationId: conversation.id });
  }), [on, conversation.id, socket]);

  useEffect(() => on<{ conversationId: string }>('typing:start', d => {
    if (d.conversationId === conversation.id) setTheyType(true);
  }), [on, conversation.id]);

  useEffect(() => on<{ conversationId: string }>('typing:stop', d => {
    if (d.conversationId === conversation.id) setTheyType(false);
  }), [on, conversation.id]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, theyType]);

  const onType = (v: string) => {
    setDraft(v);
    // Throttled to one event every two seconds. A typing packet per keystroke
    // is a lot of traffic to say one thing.
    const now = Date.now();
    if (now - typingSent.current > 2000) {
      typingSent.current = now;
      socket.emit('typing', { conversationId: conversation.id, typing: true });
    }
  };

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    socket.emit('typing', { conversationId: conversation.id, typing: false });

    const nonce = crypto.randomUUID();
    // Optimistic: the message appears instantly and is reconciled by id when
    // the server echoes it back. On a slow connection this is the difference
    // between "fast" and "broken".
    const optimistic: Message = {
      id: `pending-${nonce}`, conversation_id: conversation.id, type: 'text',
      body, media_id: null, sender_id: user!.id, display_name: user!.displayName,
      created_at: new Date().toISOString(), expires_at: null,
    };
    setMessages(prev => [...prev, optimistic]);

    const ack = await socket.emitWithAck('message:send',
      { conversationId: conversation.id, type: 'text', body, clientNonce: nonce })
      .catch(() => null) as { ok: boolean; message?: Message } | null;

    setMessages(prev => {
      const without = prev.filter(m => m.id !== optimistic.id);
      return ack?.ok && ack.message ? [...without, ack.message] : without;
    });
    if (!ack?.ok) setDraft(body);   // hand the text back rather than losing it
  };

  /**
   * Uploads the clip, then sends a `voice` message referencing it.
   *
   * Duration and the waveform ride in the message body as JSON. They are
   * presentation metadata, not content — putting them in a column would mean a
   * migration for every future attachment type that wants its own hints.
   */
  const sendVoice = async (rec: VoiceRecording) => {
    try {
      const media = await uploadMedia(rec.blob);
      const meta = JSON.stringify({ durationMs: rec.durationMs, peaks: rec.peaks });
      const ack = await socket.emitWithAck('message:send', {
        conversationId: conversation.id, type: 'voice',
        mediaId: media.id, body: meta, clientNonce: crypto.randomUUID(),
      }).catch(() => null) as { ok: boolean; message?: Message } | null;
      if (ack?.ok && ack.message) {
        setMessages(prev => prev.some(p => p.id === ack.message!.id) ? prev : [...prev, ack.message!]);
      }
    } catch {
      // The recorder has already released the microphone; a failed upload must
      // not block the composer.
    }
  };

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="flex items-center gap-3 border-b border-line px-3
                         pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button onClick={onBack} aria-label="Back" className="grid h-9 w-9 place-items-center rounded-full">
          <ArrowLeft size={20} />
        </button>
        <Avatar name={name} size={36} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-[11px] text-ink-dim">
            {theyType ? 'typing…' : connected ? 'connected' : 'reconnecting…'}
          </p>
        </div>
        {conversation.disappear_after_sec && (
          <span className="flex items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-brand">
            <Timer size={12} /> {conversation.disappear_after_sec}s
          </span>
        )}
        {conversation.type === 'group' && (
          <button onClick={() => setGroupInfo(true)} aria-label="Group info"
            className="grid h-9 w-9 place-items-center rounded-full bg-surface-2">
            <Info size={17} />
          </button>
        )}
      </header>

      {groupInfo && (
        <GroupSheet
          conversationId={conversation.id}
          onClose={() => setGroupInfo(false)}
          onChanged={() => {}}
          onLeft={() => { setGroupInfo(false); onBack(); }} />
      )}

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {loading ? <Skeleton rows={3} />
          : messages.length === 0
          ? <p className="pt-10 text-center text-sm text-ink-dim">Say something.</p>
          : messages.map(m => {
            const mine = m.sender_id === user?.id;
            if (m.type === 'system') {
              return <p key={m.id} className="py-2 text-center text-[11px] text-ink-faint">{m.body}</p>;
            }
            if (m.type === 'voice' && m.media_id) {
              return (
                <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                  <div className="max-w-[85%]">
                    <VoicePlayer mediaId={m.media_id} meta={m.body} mine={mine} />
                  </div>
                </div>
              );
            }
            return (
              <div key={m.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[78%] rounded-2xl px-3.5 py-2 text-sm',
                  mine ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-ink',
                  m.id.startsWith('pending-') && 'opacity-60')}>
                  {m.body}
                </div>
              </div>
            );
          })}
        {theyType && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface-2 px-4 py-3">
              <span className="flex gap-1">
                {[0, 1, 2].map(i => (
                  <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-dim"
                    style={{ animationDelay: `${i * 150}ms` }} />
                ))}
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-3
                      pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <input
          value={draft}
          onChange={e => onType(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Message"
          aria-label="Message"
          className="h-11 flex-1 rounded-full border border-line bg-surface px-4 text-sm
                     placeholder:text-ink-faint focus:border-brand focus:outline-none"
        />
        {draft.trim() ? (
          <button onClick={() => void send()} aria-label="Send"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand
                       text-brand-ink">
            <Send size={18} />
          </button>
        ) : (
          <VoiceRecorder onRecorded={sendVoice} />
        )}
      </div>
    </div>
  );
}

/** Resolves a media id to a signed URL, then renders the player. */
function VoicePlayer({ mediaId, meta, mine }: {
  mediaId: string; meta: string | null; mine: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void api<{ url: string | null }>(`/media/${mediaId}/url`)
      .then(r => setUrl(r.url))
      .catch(() => setUrl(null));
  }, [mediaId]);

  let durationMs = 0, peaks: number[] = [];
  try {
    const parsed = meta ? JSON.parse(meta) : null;
    durationMs = parsed?.durationMs ?? 0;
    peaks = parsed?.peaks ?? [];
  } catch { /* older or malformed metadata; the player copes with defaults */ }

  if (!url) {
    return <div className="h-14 w-56 animate-pulse rounded-2xl bg-surface-2" />;
  }
  return <VoiceMessage url={url} durationMs={durationMs} peaks={peaks} mine={mine} />;
}
