'use client';
import { useState } from 'react';
import { LogOut, Users } from 'lucide-react';
import { useAuth } from '@/features/auth/store';
import { TabBar, type Tab } from './TabBar';
import { CaptureFlow } from '@/features/camera/CaptureFlow';
import { ChatScreen } from '@/features/chat/ChatScreen';
import { SnapsScreen } from '@/features/snaps/SnapsScreen';
import { FriendsScreen } from '@/features/friends/FriendsScreen';
import { StoriesScreen } from '@/features/stories/StoriesScreen';
import { useCall } from '@/features/calls/useCall';
import { CallOverlay } from '@/features/calls/CallOverlay';
import { Button } from '@/components/ui/button';

/**
 * Phase 1 shell.
 *
 * The four-tab structure and the camera-as-centre-action are in place; the tab
 * contents arrive in their own phases. Each placeholder says what it will do
 * and when, rather than showing invented messages or fake stories — the spec
 * (§53) forbids placeholder implementations dressed as working features, and a
 * mock inbox is exactly that.
 */
export function Home() {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('camera');
  const [showFriends, setShowFriends] = useState(false);
  const [dmWith, setDmWith] = useState<string | null>(null);
  /* One call instance for the whole app: an incoming call must be answerable
     from any tab, and a second hook would mean two sockets racing to answer. */
  const call = useCall();

  return (
    <div className="mx-auto flex min-h-dvh max-w-[480px] flex-col md:my-6 md:min-h-[calc(100dvh-3rem)]
                    md:rounded-[2rem] md:border md:border-line md:shadow-lift">
      {tab !== 'camera' && (
      <header className="flex items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br
                          from-brand to-brand-dim text-sm font-bold text-brand-ink">
            {user?.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">{user?.displayName}</p>
            <p className="text-xs text-ink-dim">@{user?.username}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="icon" aria-label="Friends"
            onClick={() => { setTab('chat'); setShowFriends(f => !f); setDmWith(null); }}>
            <Users size={19} />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut size={19} />
          </Button>
        </div>
      </header>
      )}

      <main className="flex-1 pb-28">
        {tab === 'camera' && (
          <div className="fixed inset-0 z-30 mx-auto max-w-[480px]">
            <CaptureFlow />
          </div>
        )}
        {tab === 'chat' && (
          showFriends
            ? <FriendsScreen
                onMessage={id => { setDmWith(id); setShowFriends(false); }}
                onCall={(id, name, kind) => void call.call(id, name, kind)} />
            : <ChatScreen startWith={dmWith} />
        )}
        {tab === 'stories' && <StoriesScreen />}
        {tab === 'profile' && <SnapsScreen />}
      </main>

      <TabBar active={tab} onChange={setTab} />

      <CallOverlay call={call} />
    </div>
  );
}
