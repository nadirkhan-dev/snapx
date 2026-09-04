'use client';
import { useEffect } from 'react';
import { useAuth } from '@/features/auth/store';
import { AuthScreen } from '@/features/auth/AuthScreen';
import { Home } from '@/features/shell/Home';
import { ToastProvider } from '@/components/ui/toast';

export default function Page() {
  const { status, restore } = useAuth();
  useEffect(() => { void restore(); }, [restore]);

  // Held on a brand mark rather than a spinner: the refresh call is usually
  // under 100ms, and a spinner that flashes for 80ms reads as a glitch.
  if (status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="h-14 w-14 animate-pulse rounded-2xl bg-gradient-to-br from-brand to-brand-dim" />
      </div>
    );
  }

  return <ToastProvider>{status === 'authed' ? <Home /> : <AuthScreen />}</ToastProvider>;
}
