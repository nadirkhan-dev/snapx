import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { API, call, token, me, waitForServer } from './helpers.mjs';

before(() => waitForServer());

test('login succeeds and returns a usable access token', async () => {
  const t = await token('ayesha');
  const user = await me(t);
  assert.equal(user.username, 'ayesha');
});

test('wrong password and unknown user are indistinguishable', async () => {
  const wrong = await call(null, '/auth/login',
    { method: 'POST', body: { identifier: 'ayesha', password: 'not-the-password' } });
  const missing = await call(null, '/auth/login',
    { method: 'POST', body: { identifier: 'nobody-here', password: 'not-the-password' } });

  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  // Different messages would turn login into an account-existence oracle.
  assert.equal(wrong.body.message, missing.body.message);
});

test('an unauthenticated request is refused', async () => {
  assert.equal((await call(null, '/auth/me')).status, 401);
});

test('a refresh token cannot be used as an access token', async () => {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'ayesha', password: 'snapx-demo-2026' }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).find(c => c.startsWith('snapx_rt='));
  const refresh = cookie?.split(';')[0].split('=')[1];
  assert.ok(refresh, 'no refresh cookie issued');

  assert.equal((await call(refresh, '/auth/me')).status, 401);
});

test('refresh rotates the token, and replaying the old one revokes the family', async () => {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'bilal', password: 'snapx-demo-2026' }),
  });
  const first = (login.headers.getSetCookie?.() ?? [])
    .find(c => c.startsWith('snapx_rt='))?.split(';')[0].split('=')[1];

  const rotate = await fetch(`${API}/auth/refresh`,
    { method: 'POST', headers: { cookie: `snapx_rt=${first}` } });
  const second = (rotate.headers.getSetCookie?.() ?? [])
    .find(c => c.startsWith('snapx_rt='))?.split(';')[0].split('=')[1];

  assert.equal(rotate.status, 200);
  assert.notEqual(first, second, 'the token was not rotated');

  // Replaying the retired token means it was stolen; the whole family dies.
  const replay = await fetch(`${API}/auth/refresh`,
    { method: 'POST', headers: { cookie: `snapx_rt=${first}` } });
  assert.equal(replay.status, 401);

  const afterward = await fetch(`${API}/auth/refresh`,
    { method: 'POST', headers: { cookie: `snapx_rt=${second}` } });
  assert.equal(afterward.status, 401, 'the family was not revoked');
});

test('refresh with no cookie is 401, not a 200 carrying an error', async () => {
  // A 200 here once made the client treat an anonymous visitor as signed in.
  assert.equal((await call(null, '/auth/refresh', { method: 'POST' })).status, 401);
});

test('the age gate is enforced server-side', async () => {
  const r = await call(null, '/auth/register', {
    method: 'POST',
    body: {
      username: `kid${Date.now() % 100000}`, displayName: 'Too Young',
      email: `kid${Date.now() % 100000}@snapx.test`,
      password: 'a-long-enough-passphrase', dateOfBirth: '2020-01-01',
    },
  });
  assert.equal(r.status, 403);
});
