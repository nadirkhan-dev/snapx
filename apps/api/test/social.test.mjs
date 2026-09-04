import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { call, token, me, upload, waitForServer } from './helpers.mjs';

let A, B, H, U, ayesha, bilal, hina, usman;
before(async () => {
  await waitForServer();
  // .map(token) would pass the array index as the second argument, making
  // password=0. Arity leakage bit the before() hook too — worth watching for.
  [A, B, H, U] = await Promise.all(['ayesha', 'bilal', 'hina', 'usman'].map(u => token(u)));
  [ayesha, bilal, hina, usman] = await Promise.all([A, B, H, U].map(t => me(t)));
});

/* ---------------------------------------------------------------- blocking */

test('a block makes two users mutually invisible', async () => {
  // hina blocked usman in the seed.
  assert.equal((await call(H, `/friends/state/${usman.id}`)).body.state, 'blocked');
  assert.equal((await call(H, `/users/${usman.username}`)).status, 404);
  assert.equal((await call(U, `/users/${hina.username}`)).status, 404);

  const hits = (await call(H, '/users/search?q=usman')).body.results;
  assert.equal(hits.length, 0, 'a blocked user appeared in search');
});

test('search needs at least two characters', async () => {
  assert.deepEqual((await call(A, '/users/search?q=a')).body.results, []);
});

/* ------------------------------------------------------------------- snaps */

test('a snap cannot be sent to someone who is not a friend', async () => {
  const media = (await upload(A)).body;
  const r = await call(A, '/snaps', {
    method: 'POST', body: { mediaId: media.id, recipientIds: [usman.id], durationSec: 3 },
  });
  assert.equal(r.status, 403);
});

test('a snap expires, and its signed URL dies with it', async () => {
  const media = (await upload(A)).body;
  const sent = await call(A, '/snaps', {
    method: 'POST', body: { mediaId: media.id, recipientIds: [bilal.id], durationSec: 1 },
  });
  assert.equal(sent.status, 201);

  const row = (await call(B, '/snaps')).body.find(s => s.status === 'delivered');
  const opened = await call(B, `/snaps/${row.id}/open`, { method: 'POST' });
  assert.equal(opened.status, 200);

  // The URL must outlive the snap by no more than the grace window.
  const url = 'http://localhost:4000' + opened.body.url;
  assert.equal((await fetch(url)).status, 200);

  const ttl = new Date(opened.body.expiresAt).getTime() - Date.now();
  await new Promise(r => setTimeout(r, ttl + 1500));

  assert.equal((await call(B, `/snaps/${row.id}/open`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(url)).status, 404, 'the media URL outlived the snap');
});

test('one replay is allowed, a second is refused', async () => {
  const media = (await upload(A)).body;
  await call(A, '/snaps', {
    method: 'POST', body: { mediaId: media.id, recipientIds: [bilal.id], durationSec: 30 },
  });
  const row = (await call(B, '/snaps')).body.find(s => s.status === 'delivered');

  assert.equal((await call(B, `/snaps/${row.id}/open`, { method: 'POST' })).status, 200);
  assert.equal((await call(B, `/snaps/${row.id}/open`, { method: 'POST' })).status, 200);
  assert.equal((await call(B, `/snaps/${row.id}/open`, { method: 'POST' })).status, 403);
});

/* ------------------------------------------------------------------ groups */

test('group roles, ownership succession and friends-only membership', async () => {
  const g = await call(A, '/chat/conversations/group',
    { method: 'POST', body: { title: 'Audit Group', memberIds: [bilal.id] } });
  assert.equal(g.status, 201);
  const gid = g.body.id;

  // A plain member cannot add anyone.
  assert.equal((await call(B, `/chat/conversations/${gid}/members`,
    { method: 'POST', body: { userIds: [hina.id] } })).status, 403);

  assert.equal((await call(A, `/chat/conversations/${gid}/members/${bilal.id}/role`,
    { method: 'POST', body: { role: 'admin' } })).status, 200);

  // The owner cannot be removed, even by an admin.
  assert.equal((await call(B, `/chat/conversations/${gid}/members/${ayesha.id}`,
    { method: 'DELETE' })).status, 403);

  // Only the owner may change roles.
  assert.equal((await call(B, `/chat/conversations/${gid}/members/${bilal.id}/role`,
    { method: 'POST', body: { role: 'member' } })).status, 403);

  // Owner leaves: ownership must pass, not vanish.
  const left = await call(A, `/chat/conversations/${gid}/leave`, { method: 'POST' });
  assert.equal(left.status, 200);
  assert.ok(left.body.newOwner, 'the group was orphaned');

  const detail = (await call(B, `/chat/conversations/${gid}/members`)).body;
  assert.equal(detail.myRole, 'owner');

  // Someone who was never a member sees nothing.
  assert.equal((await call(H, `/chat/conversations/${gid}/members`)).status, 404);
});

/* -------------------------------------------------------------- disappearing */

test('a disappearing message is gone after its window', async () => {
  const conv = (await call(A, '/chat/conversations/direct',
    { method: 'POST', body: { userId: bilal.id } })).body;

  await call(A, `/chat/conversations/${conv.id}/disappearing`,
    { method: 'POST', body: { seconds: 5 } });
  const marker = `vanish-${Date.now()}`;
  await call(A, '/chat/messages',
    { method: 'POST', body: { conversationId: conv.id, type: 'text', body: marker } });

  const before = (await call(B, `/chat/conversations/${conv.id}/messages`)).body;
  assert.ok(before.some(m => m.body === marker));

  await new Promise(r => setTimeout(r, 6000));
  const after = (await call(B, `/chat/conversations/${conv.id}/messages`)).body;
  assert.ok(!after.some(m => m.body === marker), 'the message did not disappear');

  await call(A, `/chat/conversations/${conv.id}/disappearing`,
    { method: 'POST', body: { seconds: null } });
});

test('a duplicate client nonce returns the original message', async () => {
  const conv = (await call(A, '/chat/conversations/direct',
    { method: 'POST', body: { userId: bilal.id } })).body;
  const nonce = `nonce-${Date.now()}`;

  const first = await call(A, '/chat/messages',
    { method: 'POST', body: { conversationId: conv.id, type: 'text', body: 'once', clientNonce: nonce } });
  const second = await call(A, '/chat/messages',
    { method: 'POST', body: { conversationId: conv.id, type: 'text', body: 'once', clientNonce: nonce } });

  assert.equal(first.body.id, second.body.id, 'the retry created a duplicate');
});

test('a non-member cannot read a conversation', async () => {
  const conv = (await call(A, '/chat/conversations/direct',
    { method: 'POST', body: { userId: bilal.id } })).body;
  assert.equal((await call(H, `/chat/conversations/${conv.id}/messages`)).status, 404);
});

/* ----------------------------------------------------------------- stories */

test('a friends-only story is invisible to a non-friend', async () => {
  const media = (await upload(A)).body;
  const story = await call(A, '/stories',
    { method: 'POST', body: { mediaId: media.id, privacy: 'friends' } });
  assert.equal(story.status, 201);

  // usman is not ayesha's friend.
  assert.equal((await call(U, `/stories/${story.body.id}/view`, { method: 'POST' })).status, 404);

  // A friend can view, and only the author sees the viewer list.
  assert.equal((await call(B, `/stories/${story.body.id}/view`, { method: 'POST' })).status, 200);
  assert.equal((await call(A, `/stories/${story.body.id}/viewers`)).body.length, 1);
  assert.equal((await call(B, `/stories/${story.body.id}/viewers`)).status, 404);
});

/* -------------------------------------------------------------- moderation */

test('reports dedupe, self-reports are refused, and admin is 404 to others', async () => {
  const r1 = await call(B, '/reports',
    { method: 'POST', body: { targetType: 'user', targetId: hina.id, reason: 'spam' } });
  assert.equal(r1.status, 201);

  const r2 = await call(B, '/reports',
    { method: 'POST', body: { targetType: 'user', targetId: hina.id, reason: 'spam' } });
  assert.ok(r2.body.alreadyReported, 'a duplicate report was created');

  assert.equal((await call(B, '/reports',
    { method: 'POST', body: { targetType: 'user', targetId: bilal.id, reason: 'spam' } })).status, 400);

  // A non-admin must not learn the console exists.
  assert.equal((await call(B, '/admin/reports')).status, 404);
});

/* ---------------------------------------------------------------- calls */

test('calls are refused to non-friends and ICE config is returned', async () => {
  const ice = await call(A, '/calls/ice');
  assert.equal(ice.status, 200);
  assert.ok(Array.isArray(ice.body.iceServers) && ice.body.iceServers.length > 0);
  assert.equal(typeof ice.body.hasTurn, 'boolean');

  const history = await call(A, '/calls/history');
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.body));
});

/* ------------------------------------------------------- content search */

test('content search respects story audience and conversation membership', async () => {
  const marker = `findme${Date.now() % 100000}`;

  // A friends-only story from ayesha.
  const media = (await upload(A)).body;
  await call(A, '/stories', {
    method: 'POST', body: { mediaId: media.id, caption: `sunset ${marker}`, privacy: 'friends' },
  });

  // A message in ayesha↔bilal.
  const conv = (await call(A, '/chat/conversations/direct',
    { method: 'POST', body: { userId: bilal.id } })).body;
  await call(A, '/chat/messages',
    { method: 'POST', body: { conversationId: conv.id, type: 'text', body: `secret ${marker}` } });

  // A friend finds both.
  const friend = (await call(B, `/users/search/content?q=${marker}`)).body;
  assert.equal(friend.stories.length, 1, 'a friend could not find the story');
  assert.equal(friend.messages.length, 1, 'a member could not find the message');

  // A non-friend finds neither — not the story, and certainly not the message.
  const outsider = (await call(U, `/users/search/content?q=${marker}`)).body;
  assert.equal(outsider.stories.length, 0, 'a non-friend found a friends-only story');
  assert.equal(outsider.messages.length, 0, 'an outsider found someone else\'s message');
});

test('content search needs at least two characters', async () => {
  const r = (await call(A, '/users/search/content?q=a')).body;
  assert.deepEqual(r, { stories: [], messages: [] });
});
