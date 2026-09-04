'use client';
import { MessageCircle, Camera, CircleDashed, User } from 'lucide-react';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

export type Tab = 'chat' | 'camera' | 'stories' | 'profile';

const TABS = [
  { id: 'chat' as const, label: 'Chat', Icon: MessageCircle },
  { id: 'camera' as const, label: 'Camera', Icon: Camera },
  { id: 'stories' as const, label: 'Stories', Icon: CircleDashed },
  { id: 'profile' as const, label: 'Snaps', Icon: User },
];

/**
 * Primary navigation (spec §4). Camera is the centre and the highlighted
 * action, so it is rendered larger and in brand yellow rather than as a fourth
 * equal tab — that difference is what makes the product camera-first at a
 * glance rather than in a description.
 */
export function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[480px] glass border-t border-line
                 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 md:sticky md:rounded-b-[2rem]">
      <ul className="flex items-end justify-around px-4">
        {TABS.map(({ id, label, Icon }) => {
          const on = active === id;
          const isCamera = id === 'camera';
          return (
            <li key={id}>
              <button
                onClick={() => { haptic(); onChange(id); }}
                aria-current={on ? 'page' : undefined}
                aria-label={label}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-2xl px-4 py-1.5',
                  'transition-transform active:scale-90',
                  isCamera && '-translate-y-3',
                )}
              >
                <span className={cn(
                  'grid place-items-center transition-all duration-200',
                  isCamera
                    ? 'h-14 w-14 rounded-full bg-brand text-brand-ink shadow-glow'
                    : cn('h-7 w-7', on ? 'text-brand' : 'text-ink-faint'),
                )}>
                  <Icon size={isCamera ? 26 : 23} strokeWidth={on && !isCamera ? 2.4 : 2} />
                </span>
                {!isCamera && (
                  <span className={cn('text-[10px] font-medium tracking-wide transition-colors',
                    on ? 'text-brand' : 'text-ink-faint')}>{label}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
