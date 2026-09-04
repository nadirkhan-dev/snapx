'use client';
import { useState } from 'react';
import { ArrowLeft, MailCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Step = 'request' | 'code' | 'password' | 'done';

/**
 * Password reset (spec §5).
 *
 * The confirmation after step one is deliberately vague — "if that account
 * exists" — matching the API, which never confirms whether an address is
 * registered. Saying "we've sent you an email" would leak exactly what the
 * backend takes care not to.
 */
export function ResetFlow({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<Step>('request');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await fn(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <button onClick={onBack} className="mb-6 flex items-center gap-2 text-sm text-ink-dim">
        <ArrowLeft size={16} /> Back to sign in
      </button>

      {step === 'request' && (
        <form onSubmit={e => { e.preventDefault(); void run(async () => {
          await api('/auth/password/forgot', { method: 'POST', body: { identifier } });
          setStep('code');
        }); }} className="space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
            <p className="mt-1.5 text-sm text-ink-dim">
              We will send a 6-digit code to the email or phone on your account.
            </p>
          </div>
          <Input label="Username, email or phone" value={identifier}
            onChange={e => setIdentifier(e.target.value)} autoCapitalize="none" required autoFocus />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <Button type="submit" size="lg" full loading={busy}>Send code</Button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={e => { e.preventDefault(); void run(async () => {
          const r = await api<{ valid: boolean }>('/auth/password/verify',
            { method: 'POST', body: { identifier, code } });
          if (!r.valid) { setError('That code is not valid or has expired.'); return; }
          setStep('password');
        }); }} className="space-y-4">
          <div className="flex items-start gap-3">
            <MailCheck size={22} className="mt-0.5 shrink-0 text-brand" />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Enter your code</h1>
              <p className="mt-1 text-sm text-ink-dim">
                If that account exists, a 6-digit code is on its way. It expires in 15 minutes.
              </p>
            </div>
          </div>
          <Input label="6-digit code" value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus
            className="text-center font-mono text-2xl tracking-[0.4em]" />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <Button type="submit" size="lg" full loading={busy} disabled={code.length !== 6}>
            Continue
          </Button>
          <button type="button" className="w-full text-center text-sm text-ink-dim"
            onClick={() => void run(async () => {
              await api('/auth/password/forgot', { method: 'POST', body: { identifier } });
              setCode(''); setError('');
            })}>
            Send a new code
          </button>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={e => { e.preventDefault(); void run(async () => {
          if (password !== confirm) { setError('Those passwords do not match.'); return; }
          await api('/auth/password/reset',
            { method: 'POST', body: { identifier, code, password } });
          setStep('done');
        }); }} className="space-y-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Choose a new password</h1>
            <p className="mt-1 text-sm text-ink-dim">
              You will be signed out everywhere else.
            </p>
          </div>
          <Input label="New password" type="password" value={password}
            onChange={e => setPassword(e.target.value)} autoComplete="new-password" required autoFocus
            hint="At least 10 characters — a short phrase works well" />
          <Input label="Confirm password" type="password" value={confirm}
            onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <Button type="submit" size="lg" full loading={busy}>Set new password</Button>
        </form>
      )}

      {step === 'done' && (
        <div className="space-y-4 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-ok/15 text-ok">
            <MailCheck size={26} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Password updated</h1>
          <p className="text-sm text-ink-dim">
            Every other session has been signed out. You can sign in with your new password.
          </p>
          <Button size="lg" full onClick={onBack}>Back to sign in</Button>
        </div>
      )}
    </div>
  );
}
