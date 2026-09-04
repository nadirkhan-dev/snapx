'use client';
import { forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

/**
 * Labelled input.
 *
 * The label is always rendered, never replaced by a placeholder: a placeholder
 * disappears the moment someone types, so anyone who loses their place — or
 * uses a screen reader — has no way to recover what the field was for.
 */
export const Input = forwardRef<HTMLInputElement, Props>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const auto = useId();
    const inputId = id ?? auto;
    const describedBy = error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined;

    return (
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-xs font-medium tracking-wide text-ink-dim">
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={cn(
            'h-12 w-full rounded-xl border bg-surface px-4 text-[15px] text-ink',
            'placeholder:text-ink-faint transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bg',
            error
              ? 'border-danger focus:ring-danger'
              : 'border-line focus:border-brand focus:ring-brand',
            className,
          )}
          {...props}
        />
        {error && <p id={`${inputId}-err`} className="text-xs text-danger">{error}</p>}
        {!error && hint && <p id={`${inputId}-hint`} className="text-xs text-ink-faint">{hint}</p>}
      </div>
    );
  },
);
Input.displayName = 'Input';
