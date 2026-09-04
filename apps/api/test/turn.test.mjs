import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTurnCredential, verifyTurnCredential } from '../dist/calls/turn.js';

const SECRET = 'a-shared-secret-only-the-servers-know';

test('a minted credential verifies the way a TURN server would', () => {
  const c = makeTurnCredential({ urls: ['turn:x:3478'], secret: SECRET, userId: 'u1', ttlSec: 3600 });
  assert.match(c.username, /^\d+:u1$/);
  assert.equal(verifyTurnCredential(c.username, c.credential, SECRET).valid, true);
});

test('a credential is rejected under a different secret', () => {
  const c = makeTurnCredential({ urls: ['turn:x'], secret: SECRET, userId: 'u1' });
  assert.equal(verifyTurnCredential(c.username, c.credential, 'other').valid, false);
});

test('a tampered credential is rejected', () => {
  const c = makeTurnCredential({ urls: ['turn:x'], secret: SECRET, userId: 'u1' });
  const bad = 'AAAA' + c.credential.slice(4);
  assert.equal(verifyTurnCredential(c.username, bad, SECRET).valid, false);
});

test('a credential expires on its own', () => {
  const c = makeTurnCredential({ urls: ['turn:x'], secret: SECRET, userId: 'u1', ttlSec: -10 });
  assert.equal(verifyTurnCredential(c.username, c.credential, SECRET).reason, 'expired');
});

test('one user\'s credential does not work for another', () => {
  const a = makeTurnCredential({ urls: ['turn:x'], secret: SECRET, userId: 'user-A' });
  const b = makeTurnCredential({ urls: ['turn:x'], secret: SECRET, userId: 'user-B' });
  assert.notEqual(a.credential, b.credential);
  assert.equal(verifyTurnCredential(b.username, a.credential, SECRET).valid, false);
});
