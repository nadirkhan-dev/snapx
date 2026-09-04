# Real-device call test — the runbook

This is the test I cannot run: it needs a public IP, a domain, a TURN server and
two phones on different networks. Everything below is what to do, in order.

Nothing here is optional. **Until this passes, calling is not production-ready.**

---

## 1. Provision (about 30 minutes)

A small VM (1 vCPU, 2GB) and a domain with two A records:

```
<YOUR_DOMAIN>       → <PUBLIC_IP>
api.<YOUR_DOMAIN>   → <PUBLIC_IP>
turn.<YOUR_DOMAIN>  → <PUBLIC_IP>
```

Firewall — **the UDP relay range is the one people forget**, and without it TURN
appears to work right up until media needs to flow:

| Port | Protocol | Why |
|---|---|---|
| 80, 443 | TCP | Web, API, certificate issuance |
| 3478 | TCP + UDP | TURN |
| 5349 | TCP + UDP | TURN over TLS |
| 49160–49200 | **UDP** | TURN relay range |

## 2. Certificates

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d <YOUR_DOMAIN> -d api.<YOUR_DOMAIN>
certbot certonly --standalone -d turn.<YOUR_DOMAIN>
```

## 3. TURN

```bash
apt install coturn
sed -i 's/#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn

openssl rand -hex 32        # this value is TURN_SECRET — you need it twice

cp deploy/coturn.conf /etc/turnserver.conf
# Replace: <PUBLIC_IP> <PRIVATE_IP> <YOUR_DOMAIN> <TURN_SECRET>
systemctl restart coturn && systemctl status coturn
```

**Verify TURN before touching the app.** Open
<https://icetest.info> or Google's Trickle ICE page, enter:

```
turn:turn.<YOUR_DOMAIN>:3478
```

with a username and credential from your API's `/api/calls/ice`. You must see a
candidate of type **`relay`**. No relay candidate means TURN is not working, and
no amount of application testing will tell you why.

## 4. Configure and deploy

`apps/api/.env`:

```bash
NODE_ENV=production
DATABASE_URL="postgres://..."
JWT_ACCESS_SECRET=<64 hex>
JWT_REFRESH_SECRET=<64 hex>
WEB_ORIGIN=https://<YOUR_DOMAIN>

TURN_URL=turn:turn.<YOUR_DOMAIN>:3478,turns:turn.<YOUR_DOMAIN>:5349
TURN_SECRET=<the same secret as coturn>
TURN_TTL_SEC=43200
```

`TURN_USERNAME` / `TURN_CREDENTIAL` are **not** set — with `TURN_SECRET` present
the API mints short-lived per-user credentials instead, and static ones are
extractable from any client.

Build. `NEXT_PUBLIC_API_URL` is inlined at build time, so it must be set for the
build command, not just the runtime environment:

```bash
npm --prefix apps/api run build
NEXT_PUBLIC_API_URL=https://api.<YOUR_DOMAIN> npm --prefix apps/web run build

cp deploy/nginx.conf /etc/nginx/sites-available/snapx   # replace <YOUR_DOMAIN>
ln -s /etc/nginx/sites-available/snapx /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 5. Confirm the wiring before you call anyone

```bash
# Ephemeral credentials, not static
curl -H "Authorization: Bearer <token>" https://api.<YOUR_DOMAIN>/api/calls/ice
# expect: "hasTurn": true, "ephemeral": true, and a username like 1735689600:<uuid>
```

On a phone, open the site and check DevTools → Network → WS shows
`wss://api.<YOUR_DOMAIN>/socket.io/…` with status **101**.

## 6. The test itself

**Device A on Wi-Fi. Device B on mobile data with Wi-Fi turned off.** Two
different networks is the entire point — same-Wi-Fi calls connect without TURN
and prove nothing.

Sign in as two different accounts that are already friends.

| # | Action | Pass condition |
|---|---|---|
| 1 | A: Chat → people icon → video icon next to B | B rings within ~2s |
| 2 | B: green accept | Both see the other's video within ~3s |
| 3 | Speak on both | Audio both ways |
| 4 | A: mic button | B stops hearing A; video continues |
| 5 | A: mic again | Audio returns |
| 6 | A: camera button | A's video freezes for B; audio continues |
| 7 | A: red button | Both return to normal within ~1s |
| 8 | A calls B, B declines | A returns to normal; logged `rejected` |
| 9 | A calls B, nobody answers 75s | Auto-marked `missed` |
| 10 | Mid-call: B toggles airplane mode 5s, back on | "Connecting…" then recovers, or fails with a message. **No silent freeze** |
| 11 | Voice-only call | Same as 1–7 without video |
| 12 | Call history | Every call above appears with correct status and duration |

**Confirm the relay was actually used.** During a cross-network call, open
`chrome://webrtc-internals` on the desktop side (or use the phone's remote
debugging) and find the selected candidate pair. Across Wi-Fi and mobile data it
will usually be `relay` — which proves TURN is doing its job. If it shows `host`
or `srflx`, you got lucky with permissive NAT and have **not** tested the path
most of your users will take.

## 7. If it fails

| Symptom | Cause | Fix |
|---|---|---|
| Stuck on "Connecting…" | No relay candidate | UDP 49160–49200 blocked, or `external-ip` wrong in coturn.conf |
| Callee never rings | Socket not connected | Check WS shows 101; check `WEB_ORIGIN` matches the site origin exactly |
| "hasTurn": false | `TURN_URL` unset in the API environment | Set it and restart |
| `ephemeral: false` in the ICE response | `TURN_SECRET` missing | Set it; remove `TURN_USERNAME`/`TURN_CREDENTIAL` |
| Works on Wi-Fi, fails cross-network | TURN not actually reachable | Test with Trickle ICE first, then retry |
| Media one way only | Renegotiation bug | Capture both sides' `chrome://webrtc-internals` and compare tracks |
