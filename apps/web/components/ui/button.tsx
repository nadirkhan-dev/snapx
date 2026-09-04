'use client';
import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';

const button = cva(
  'inline-flex items-center justify-center gap-2 font-medium select-none ' +
  'transition-[transform,background-color,opacity] duration-150 active:scale-[0.97] ' +
  'disabled:opacity-40 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-ink hover:bg-brand/90 shadow-glow',
        secondary: 'bg-surface-2 text-ink hover:bg-surface-3',
        ghost: 'text-ink-dim hover:text-ink hover:bg-surface-2',
        danger: 'bg-danger text-white hover:bg-danger/90',
        glass: 'glass text-ink hover:bg-surface-2/80 border border-white/5',
      },
      size: {
        sm: 'h-9 px-3.5 text-[13px] rounded-xl',
        md: 'h-11 px-5 text-sm rounded-xl',
        lg: 'h-14 px-7 text-base rounded-2xl',
        // 44px floor, per touch-target guidance (spec §45).
        icon: 'h-11 w-11 rounded-full',
        'icon-lg': 'h-14 w-14 rounded-full',
      },
      full: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, full, loading, children, onClick, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(button({ variant, size, full }), className)}
      disabled={disabled || loading}
      onClick={e => { haptic(); onClick?.(e); }}
      {...props}
    >
      {loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
