'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'ok' | 'error';
type Item = { id: number; text: string; tone: Tone };

const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);

  const push = useCallback((text: string, tone: Tone = 'ok') => {
    const id = ++seq;
    setItems(v => [...v, { id, text, tone }]);
    // Errors linger — if something failed, the person needs time to read why.
    setTimeout(() => setItems(v => v.filter(t => t.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-6"
        role="status" aria-live="polite">
        {items.map(t => (
          <div key={t.id}
            className={cn('pointer-events-auto max-w-sm rounded-2xl px-4 py-3 text-sm shadow-lift',
              t.tone === 'error' ? 'bg-danger text-white' : 'glass text-ink')}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
