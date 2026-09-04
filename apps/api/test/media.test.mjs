import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { call, token, upload, PNG, waitForServer } from './helpers.mjs';

let A, B;
before(async () => { await waitForServer(); A = await token('ayesha'); B = await token('bilal'); });

test('a real PNG uploads and never leaks its storage key', async () => {
  const r = await upload(A);
  assert.equal(r.status, 201);
  assert.equal(r.body.byteSize, PNG.length);
  assert.ok(!('storage_key' in r.body) && !('storageKey' in r.body),
    'the storage path was exposed to the client');
});

test('HTML disguised as a PNG is rejected by magic bytes', async () => {
  const evil = Buffer.from('<!DOCTYPE html><script>alert(1)</script>');
  assert.equal((await upload(A, evil, 'image/png')).status, 400);
});

test('SVG is refused outright', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  assert.equal((await upload(A, svg, 'image/svg+xml')).status, 400);
});

test('an empty upload is rejected', async () => {
  assert.equal((await upload(A, Buffer.alloc(0))).status, 400);
});

test('media is invisible to an unrelated user, as 404 rather than 403', async () => {
  const { body } = await upload(A);
  // 403 would confirm the media exists, which is what someone probing ids wants.
  assert.equal((await call(B, `/media/${body.id}/url`)).status, 404);
});

test('a signed URL serves the exact bytes and dies when tampered with', async () => {
  const { body } = await upload(A);
  const signed = (await call(A, `/media/${body.id}/url`)).body;
  assert.ok(signed.url, 'no signed URL issued');

  const ok = await fetch('http://localhost:4000' + signed.url);
  assert.equal(ok.status, 200);
  assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG), 'bytes did not round-trip');

  const tampered = signed.url.replace(/sig=[a-f0-9]+/, 'sig=' + '0'.repeat(32));
  assert.equal((await fetch('http://localhost:4000' + tampered)).status, 404);
});
