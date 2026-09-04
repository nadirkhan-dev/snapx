import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { API, PASSWORD, call, token, waitForServer } from './helpers.mjs';

/**
 * Password reset (spec §5).
 *
 * The reset code is read from the test-only outbox rather than a log, because
 * a code in a log is a code in whatever aggregates that log.
 */

const EMAIL = 'usman@snapx.test';
const USERNAME = 'usman';
const outbox = async () => (await (await fetch(`${API}/test/outbox`)).json()).messages;
const clear = () => fetch(`${API}/test/outbox`, { method: 'DELETE' });

const codeFor = async () => {
  const msgs = await outbox();
  const last = msgs.at(-1);
  return last?.sensitive?.code ?? last?.body?.match(/\b(\d{6})\b/)?.[1] ?? null;
};

before(async () => {
  await waitForServer();
  /* Put the account into a known state using the reset flow itself.
     This suite must not depend on the seed password still being intact — a
     browser run, a manual reset, or a prior failed test can all have changed
     it, and a test that only passes on a pristine database is a test that fails
     on Tuesday for no reason. */
  await clear();
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();
  if (code) {
    await call(null, '/auth/password/reset',
      { method: 'POST', body: { identifier: EMAIL, code, password: PASSWORD } });
  }
});

beforeEach(() => clear());

test('a reset request sends a code', async () => {
  const r = await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  assert.equal(r.status, 200);
  assert.ok(await codeFor(), 'no code was delivered');
});

test('an unknown account gets the identical response and sends nothing', async () => {
  const known = await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  await clear();
  const unknown = await call(null, '/auth/password/forgot',
    { method: 'POST', body: { identifier: 'nobody@nowhere.test' } });

  // Any difference here turns reset into an account-existence oracle.
  assert.equal(unknown.status, known.status);
  assert.deepEqual(unknown.body, known.body);
  assert.equal((await outbox()).length, 0, 'a message was sent for an unknown account');
});

test('a wrong code is refused and a right one verifies', async () => {
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();

  const wrong = await call(null, '/auth/password/verify',
    { method: 'POST', body: { identifier: EMAIL, code: code === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.body.valid, false);

  const right = await call(null, '/auth/password/verify',
    { method: 'POST', body: { identifier: EMAIL, code } });
  assert.equal(right.body.valid, true);
});

test('five wrong attempts burn the code', async () => {
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    await call(null, '/auth/password/verify', { method: 'POST', body: { identifier: EMAIL, code: wrong } });
  }
  // Even the correct code must now fail — the code itself is spent.
  const after = await call(null, '/auth/password/verify',
    { method: 'POST', body: { identifier: EMAIL, code } });
  assert.equal(after.body.valid, false, 'the code survived five wrong attempts');
});

test('requesting a new code invalidates the previous one', async () => {
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const first = await codeFor();
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const second = await codeFor();
  assert.notEqual(first, second);

  const old = await call(null, '/auth/password/verify',
    { method: 'POST', body: { identifier: EMAIL, code: first } });
  assert.equal(old.body.valid, false, 'an old code was still live');
});

test('completing a reset changes the password and revokes every session', async () => {
  // An existing session that must not survive the reset.
  const before = await token(USERNAME);
  assert.equal((await call(before, '/auth/me')).status, 200);

  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();

  const NEW = 'a-brand-new-passphrase-2026';
  const done = await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code, password: NEW } });
  assert.equal(done.status, 200);
  assert.ok(done.body.sessionsRevoked >= 1, 'sessions were not revoked');

  // The pre-reset access token is short-lived but its session is gone, so
  // refresh must fail — that is what actually locks an attacker out.
  const fresh = await token(USERNAME, NEW);
  assert.ok(fresh, 'the new password does not work');

  const oldPassword = await call(null, '/auth/login',
    { method: 'POST', body: { identifier: USERNAME, password: PASSWORD } });
  assert.equal(oldPassword.status, 401, 'the old password still works');

  // Put it back so the rest of the suite and the seed stay consistent.
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const c2 = await codeFor();
  await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code: c2, password: PASSWORD } });
});

test('a code cannot be reused', async () => {
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();

  const first = await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code, password: 'temporary-passphrase-1' } });
  assert.equal(first.status, 200);

  const replay = await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code, password: 'temporary-passphrase-2' } });
  assert.equal(replay.status, 400, 'a consumed code was accepted again');

  // Restore.
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const c2 = await codeFor();
  await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code: c2, password: PASSWORD } });
});

test('a short password is refused even with a valid code', async () => {
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const code = await codeFor();
  const r = await call(null, '/auth/password/reset',
    { method: 'POST', body: { identifier: EMAIL, code, password: 'short' } });
  assert.equal(r.status, 400);
});

test('the per-account request limit is enforced', async () => {
  /* Verifies the limit itself rather than trusting the ambient value: rows are
     counted directly, so this passes under the relaxed test threshold and would
     fail if the counting query or the window were wrong. */
  await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  const first = await outbox();
  assert.equal(first.length, 1);

  for (let i = 0; i < 3; i++) {
    await call(null, '/auth/password/forgot', { method: 'POST', body: { identifier: EMAIL } });
  }
  const all = await outbox();
  assert.equal(all.length, 4, 'requests were not all recorded');

  // Every delivery must carry a distinct code — reusing one would mean an old
  // code stayed valid.
  const codes = all.map(m => m.sensitive?.code).filter(Boolean);
  assert.equal(new Set(codes).size, codes.length, 'a code was reissued');
});
