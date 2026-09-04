'use client';
import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { useI18n } from '@/lib/i18n';

/**
 * Offline indicator (spec §40).
 *
 * `navigator.onLine` only reports whether the device has *a* network, not
 * whether our server is reachable — a captive portal reports online. So the
 * banner also listens for the realtime socket dropping, which is the signal
 * that actually matters for chat.
 */
export function OfflineBanner({ socketDown }: { socketDown?: boolean }) {
  const { t } = useI18n();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline && !socketDown) return null;

  return (
    <div role="status" aria-live="polite"
      className="fixed inset-x-0 top-0 z-[95] flex items-center justify-center gap-2
                 bg-warn px-4 py-1.5 text-[12px] font-medium text-bg">
      <WifiOff size={13} />
      {offline ? t('offline.title') : t('chat.reconnecting')}
    </div>
  );
}
