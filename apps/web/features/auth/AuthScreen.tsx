'use client';
import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { Camera, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from './store';
import { ApiError } from '@/lib/api';
import { ResetFlow } from './ResetFlow';

type Mode = 'signin' | 'signup';

export function AuthScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [v, setV] = useState({
    identifier: '', password: '', username: '', displayName: '', email: '', dateOfBirth: '',
  });

  const root = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);

  /* The entrance sets the tone for the whole product, so it gets a real
     timeline rather than a fade. Runs once on mount; switching between sign in
     and sign up animates only the form, so the brand does not re-enter. */
  /* fromTo, never from.
     `from()` reads the element's current value as the destination — so two
     tweens targeting the same nodes race, and the second captures the first's
     mid-flight opacity as its end state. That left the submit button stuck
     invisible on first paint: a form nobody could submit, with nothing in the
     console to explain it. fromTo states both ends explicitly and cannot drift. */
  const first = useRef(true);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
      tl.fromTo(markRef.current,
          { scale: 0.6, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.7, ease: 'back.out(1.7)' })
        .fromTo('[data-brand]',
          { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.08 }, '-=0.35')
        .fromTo('[data-form] > *',
          { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, stagger: 0.06 }, '-=0.2');
    }, root);
    return () => ctx.revert();
  }, []);

  /* Re-animates only when switching mode, never on the initial mount where the
     timeline above already owns these elements. */
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const ctx = gsap.context(() => {
      gsap.fromTo('[data-form] > *',
        { y: 12, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.35, stagger: 0.045, ease: 'power2.out' });
    }, root);
    return () => ctx.revert();
  }, [mode]);

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV(s => ({ ...s, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setFormError(''); setFields({});
    try {
      if (mode === 'signin') await signIn(v.identifier, v.password);
      else await signUp({
        username: v.username, displayName: v.displayName, email: v.email,
        password: v.password, dateOfBirth: v.dateOfBirth,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.fields ? '' : err.message);
        setFields(err.fields ?? {});
      } else setFormError('Something went wrong. Try again.');
      // A failed attempt shakes rather than only turning red — colour alone is
      // not enough signal (spec §45).
      gsap.fromTo('[data-form]', { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.35)' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={root} className="relative flex min-h-dvh flex-col justify-center overflow-hidden px-6 py-10">
      {/* A single brand-tinted bloom. Restrained: the spec calls yellow an
          accent, not a background. */}
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-[-18%] h-[420px] w-[420px]
        -translate-x-1/2 rounded-full bg-brand/15 blur-[120px]" />

      {resetting ? (
        <div className="relative mx-auto w-full max-w-sm">
          <ResetFlow onBack={() => setResetting(false)} />
        </div>
      ) : (
      <div className="relative mx-auto w-full max-w-sm">
        <header className="mb-9 text-center">
          <div ref={markRef}
            className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl
                       bg-gradient-to-br from-brand to-brand-dim shadow-glow">
            <Camera size={30} className="text-brand-ink" strokeWidth={2.4} />
          </div>
          <h1 data-brand className="text-[34px] font-bold leading-none tracking-tight">SNAPX</h1>
          <p data-brand className="mt-2.5 text-sm text-ink-dim">Capture. Connect. Share.</p>
        </header>

        <form data-form onSubmit={submit} className="space-y-4" noValidate>
          {mode === 'signin' ? (
            <>
              <Input label="Username, email or phone" value={v.identifier} onChange={set('identifier')}
                autoComplete="username" autoCapitalize="none" required
                error={fields.identifier} />
              <Input label="Password" type="password" value={v.password} onChange={set('password')}
                autoComplete="current-password" required error={fields.password} />
            </>
          ) : (
            <>
              <Input label="Name" value={v.displayName} onChange={set('displayName')}
                placeholder="Ayesha Siddiqui" autoComplete="name" required error={fields.displayName} />
              <Input label="Username" value={v.username} onChange={set('username')}
                placeholder="ayesha" autoCapitalize="none" autoComplete="username" required
                hint="Letters, numbers, _ and . — this is how friends find you"
                error={fields.username} />
              <Input label="Email" type="email" value={v.email} onChange={set('email')}
                autoComplete="email" required error={fields.email} />
              <Input label="Password" type="password" value={v.password} onChange={set('password')}
                autoComplete="new-password" required
                hint="At least 10 characters — a short phrase works well"
                error={fields.password} />
              <Input label="Date of birth" type="date" value={v.dateOfBirth} onChange={set('dateOfBirth')}
                required hint="SNAPX is for ages 13 and over" error={fields.dateOfBirth} />
            </>
          )}

          {formError && (
            <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">
              {formError}
            </p>
          )}

          <Button type="submit" size="lg" full loading={busy}>
            {mode === 'signin' ? 'Sign in' : 'Create account'}
            {!busy && <ArrowRight size={18} />}
          </Button>

          {mode === 'signin' && (
            <button type="button" onClick={() => setResetting(true)}
              className="w-full text-center text-sm text-ink-dim underline-offset-4 hover:text-ink hover:underline">
              Forgot your password?
            </button>
          )}
        </form>

        <p className="mt-7 text-center text-sm text-ink-dim">
          {mode === 'signin' ? 'New to SNAPX?' : 'Already have an account?'}{' '}
          <button
            onClick={() => { setMode(m => (m === 'signin' ? 'signup' : 'signin')); setFormError(''); setFields({}); }}
            className="font-semibold text-brand underline-offset-4 hover:underline">
            {mode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
      )}
    </div>
  );
}
