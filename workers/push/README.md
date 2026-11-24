# Magic City Nights: same-night event alerts (Web Push)

A free Cloudflare Worker that stores push subscriptions and, once a day, sends a heads-up like
**"A Motown Christmas is tonight at the Alabama Theatre · 7:00 PM"** to everyone who tapped **🔔 Get alerts**.

- **Cost:** $0 on Cloudflare's free plan (Workers + KV + Cron Triggers). No npm packages; Web Crypto only.
- **Schedule:** every day at 19:00 UTC (**1 PM Central** in winter, **2 PM Central** in summer). It reads
  `https://magiccitynights.com/events.json`, finds events dated today in `America/Chicago`
  (`date === today`, or `dates` includes today), and sends one alert per subscriber. Each event is only
  sent once per night (`sent:<date>:<eventId>` in KV, kept 48 hours), and dead subscriptions (404/410) are deleted.
- **Works with:** iPhone/iPad (iOS 16.4+, installed to the Home Screen), Android Chrome, desktop Chrome/Edge/Firefox.

| File | What it does |
| --- | --- |
| `src/index.js` | Routes, CORS, KV storage, same-night matcher, cron handler |
| `src/webpush.js` | VAPID ES256 JWT (RFC 8292) + `aes128gcm` payload encryption (RFC 8291) |
| `scripts/generate-vapid.mjs` | Makes your VAPID key pair |
| `test/worker.test.mjs` | `npm test`: RFC 8291 test vector, round-trip decryption, JWT, matcher, dedup, pruning, auth |
| `wrangler.toml` | Worker name, KV binding, cron, public settings |

## Deploy in about 5 minutes (one time, from a computer)

You need Node.js 18+ and a free Cloudflare account. From the repo:

```bash
cd workers/push
npm i -g wrangler                        # or use "npx wrangler" for each command below
wrangler login                           # opens a browser; sign in or sign up (free)

wrangler kv namespace create PUSH_SUBS   # copy the id it prints into wrangler.toml -> [[kv_namespaces]] id
node scripts/generate-vapid.mjs          # prints a PUBLIC key and a PRIVATE key
```

1. Paste the **PUBLIC** key into `wrangler.toml` → `VAPID_PUBLIC_KEY = "..."` (safe to commit).
2. Store the secrets (paste when prompted; **never put these in any file or commit them**):

```bash
wrangler secret put VAPID_PRIVATE_KEY    # the PRIVATE key from generate-vapid
wrangler secret put ADMIN_TOKEN          # make up a long random password (16+ characters)
wrangler deploy                          # prints your URL, e.g. https://mcn-push.<your-subdomain>.workers.dev
```

3. Check it: open `https://mcn-push.<your-subdomain>.workers.dev/health` → `{ "ok": true }`.
4. Turn it on for everyone: in `index.html`, near the bottom, fill in the two-line config and push to `main`:

```js
var PUSH_CONFIG = { workerUrl: "https://mcn-push.<your-subdomain>.workers.dev", vapidPublicKey: "<PUBLIC key>" };
```

`vapidPublicKey` can stay blank; the site will then fetch it from the Worker.

**Want to test before changing index.html?** Open this once on your phone (it's saved on that device only;
`?pushApi=off` clears it):
`https://magiccitynights.com/?pushApi=https://mcn-push.<your-subdomain>.workers.dev`

## Test from your phone

Set these once in a terminal (Mac/Linux; on Windows use PowerShell's `Invoke-RestMethod` or any API app):

```bash
W=https://mcn-push.<your-subdomain>.workers.dev
T=<your ADMIN_TOKEN>
```

### iPhone / iPad (iOS 16.4 or newer)
1. Open **magiccitynights.com in Safari** → **Share** → **Add to Home Screen** → **Add**.
2. Open Magic City Nights **from the new Home Screen icon** (alerts never work in a Safari tab; Apple's rule).
3. Tap **🔔 Get alerts** under the headline → **Allow**. The pill flips to **🔔 Alerts ON**.
4. Send yourself a test:

```bash
curl -X POST $W/admin/send-test -H "Authorization: Bearer $T"
```

   You should see **Tonight in Birmingham — A Motown Christmas is tonight at the Alabama Theatre · 7:00 PM**.
   Tapping it opens the app on Events.

### Android (Chrome)
1. Open magiccitynights.com in Chrome (installing with **Install App** is optional on Android).
2. Tap **🔔 Get alerts** → **Allow**, then run the same `send-test` command.

### Test the real "tonight" matcher on any date

```bash
# Preview only, sends nothing (try Motown Christmas night):
curl -X POST $W/admin/trigger-tonight -H "Authorization: Bearer $T" -d '{"date":"2026-12-07","dryRun":true}'
# Actually send that night's alert (each event only once per date; add "force":true to resend):
curl -X POST $W/admin/trigger-tonight -H "Authorization: Bearer $T" -d '{"date":"2026-12-07"}'
# Custom message, or only to one phone ("endpoint" is optional):
curl -X POST $W/admin/send-test -H "Authorization: Bearer $T" -d '{"body":"Hey Houston, push works!"}'
# How many people are subscribed:
curl -X POST $W/admin/stats -H "Authorization: Bearer $T"
```

## Logs and the daily cron
- **Live logs:** `wrangler tail` (from `workers/push`), then trigger a test; every cron run logs a
  `same-night alerts {...}` line with matches and delivery stats.
- **Cron:** Cloudflare dashboard → Workers & Pages → **mcn-push** → **Settings → Triggers** shows `0 19 * * *`;
  past runs are under **Logs**. To change the time, edit `crons` in `wrangler.toml` and `wrangler deploy`.
- **Local dev:** `wrangler dev --test-scheduled`, then open `http://localhost:8787/__scheduled` to fire the cron.

## API

| Route | Auth | Body | Result |
| --- | --- | --- | --- |
| `GET /health` | – | – | `{ ok: true }` |
| `GET /vapid-public-key` | – | – | `{ publicKey }` |
| `POST /subscribe` | – | `PushSubscription` JSON (or `{ subscription, platform }`) | stores it (201) |
| `POST /unsubscribe` | – | `{ endpoint }` | deletes it |
| `POST /admin/send-test` | Bearer | optional `title`, `body`, `url`, `endpoint` | delivery stats |
| `POST /admin/trigger-tonight` | Bearer | optional `date` (YYYY-MM-DD), `dryRun`, `force` | matches + stats |
| `POST /admin/stats` | Bearer | – | subscriber counts by push service |

**events.json** can be a plain array or `{ "events": [...] }`. Each event needs a title (`title`/`name`), a
`venue` (text or `{ name }`), and a date: `date: "2026-12-07"`, `dates: ["2026-12-11", ...]`
(strings or `{ date, time }`), or an ISO `start` timestamp. `startTime`/`time` like `"19:00"` or `"7:30 PM"` is optional;
`id` is used for dedup (otherwise built from title + venue). `cancelled` and `soldOut` events are skipped, and
multi-night runs (`date` + `endDate`, like Broadway weeks) alert on opening night only.

## Good to know
- **Free plan limit:** a Worker run can make 50 outbound requests, so each run sends to up to
  `SEND_LIMIT` (45) subscribers, one combined alert each. Past ~45 subscribers, move to Workers Paid
  ($5/mo, raise `SEND_LIMIT`) or split sends across runs.
- **Security:** only real browser push services (Apple, Google, Mozilla, Microsoft) are accepted as endpoints,
  CORS only allows magiccitynights.com (and localhost), and `/admin/*` stays locked until `ADMIN_TOKEN`
  (16+ characters) is set. Private keys live only in Cloudflare secrets.
- **Run the tests:** `npm test` (Node 18+, no installs).
