import { cn } from '@/lib/cn';

/** Initials avatar. No network request, no broken-image state, deterministic. */
export function Avatar({ name, size = 40, className }: {
  name: string; size?: number; className?: string;
}) {
  const initials = name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full bg-surface-2 font-semibold text-ink-dim', className)}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 py-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-10 w-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 rounded" style={{ width: `${60 - i * 8}%` }} />
            <div className="skeleton h-2.5 rounded" style={{ width: `${40 - i * 5}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, body, action }: {
  title: string; body: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-14 text-center">
      <p className="text-sm font-semibold">{title}</p>
      <p className="max-w-xs text-sm leading-relaxed text-ink-dim">{body}</p>
      {action}
    </div>
  );
}
