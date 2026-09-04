# SNAPX

Camera-first social platform. Next.js + NestJS + PostgreSQL + Redis, built so
the same backend serves Android and iOS later.

Capture. Connect. Share.

**Status: 43 of 54 spec sections complete.** See `AUDIT.md` for the
section-by-section breakdown, including what is missing and why.

## Run it

Needs Node 20+, PostgreSQL 15+, Redis.

```bash
npm install
createdb snapx
cp .env.example apps/api/.env      # fill in the two JWT secrets
#   openssl rand -hex 32           # run twice, one for each
npm run db:reset
npm run dev                        # api :4000, web :3000
```

Open **http://localhost:3000**. Camera, microphone and calls need a secure
context — `localhost` counts, a bare LAN IP does not.

Demo accounts, password `snapx-demo-2026`:
`ayesha` · `bilal` · `hina` · `usman` · `zara`

ayesha–bilal and ayesha–hina are friends, zara has a pending request to ayesha,
hina has blocked usman. For the admin console at `/admin`:

```sql
UPDATE users SET is_admin = true WHERE username = 'ayesha';
```

## Verify it

```bash
npm run lint          # ESLint — expect 0 problems
npm run typecheck     # tsc --noEmit, strict, both apps
npm run build         # production build, both apps

# Integration suite (needs the API running in test mode):
npm run db:reset
npm --prefix apps/api run build
NODE_ENV=test node apps/api/dist/main.js &
npm --prefix apps/api test      # expect 41/41
```

CI runs all of the above against real Postgres and Redis services — see
`.github/workflows/ci.yml`.

## What is fully implemented

Auth and sessions · password reset with OTP · camera and editor (text, draw,
filters) · media pipeline with signed expiring URLs · snaps with
server-controlled expiry · real-time chat · voice messages · groups with roles
and ownership succession · stories · friends and blocking · search across users,
stories and messages · voice and video calling · moderation and admin ·
analytics and error monitoring · i18n architecture with RTL · CI/CD.

Every one of these is covered by the integration suite or the browser audit.

## What is not

**Missing** — push notifications, video transcoding and thumbnails, editor
crop/rotate/stickers, Profile and Memories screens, offline outbox, unit and
component test layers. Effort estimates in `AUDIT.md`.

**Needs external credentials** — SMTP for real password-reset delivery
(`SMTP_URL`); a TURN server for calls across restrictive networks
(`TURN_URL`, `TURN_SECRET`).

**Needs your physical devices** — cross-network calling
(`deploy/REAL-DEVICE-TEST.md`) and a screen-reader audit.

**Platform-limited, not deferrable** — contact discovery, photo-library
enumeration and screenshot detection are impossible in a browser; iOS
background push requires the site be installed to the home screen.

## Design decisions worth knowing

**Password reset cannot enumerate accounts.** The request endpoint returns a
byte-identical response whether or not the account exists. Codes are stored as
hashes, capped at five attempts, single-use, and completing a reset revokes
every session — if the account was taken over, the attacker's session dies with
the password change.

**Reset codes are never logged.** The dev delivery provider prints the
recipient and subject only. A code in a log is a code in whatever aggregates
that log.

**Snap expiry is decided by the server.** The signed URL lives exactly as long
as the snap has left, and expiry is enforced on read as well as by the worker,
so a dead worker degrades cleanup and never correctness. The honest limit: none
of this stops a recipient photographing their screen.

**Search visibility is enforced in SQL**, not filtered in the client — story
audience for stories, conversation membership for messages.

**Signalling and media are separate.** The server relays SDP and ICE and
nothing else; audio and video go peer-to-peer over DTLS-SRTP.

**TURN credentials are ephemeral**, derived per-user from a shared secret that
never leaves the server. Static credentials are extractable from any client.

**Telemetry has a forbidden-key scrubber.** Message bodies, emails, usernames
and tokens cannot reach an analytics endpoint even if a caller passes them.

**The access token lives in memory, never localStorage.**

## Before production

- **TURN server** — `deploy/coturn.conf`. Without it, calls fail on roughly
  10–20% of real networks.
- **HTTPS** — `deploy/nginx.conf`, including the socket.io upgrade with a
  3600s read timeout; the default 60s drops sockets mid-call.
- **Redis adapter for socket.io** — the gateway is single-instance, so with two
  API instances a call started on one never rings on the other.
- **S3 storage** — local disk is the development default and does not survive a
  restart.
