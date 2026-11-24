// Magic City Nights: same-night event push alerts on Cloudflare Workers (free tier).
// Storage: one KV namespace (PUSH_SUBS). Schedule: one daily Cron Trigger. No paid services.
import { importVapidKeys, sendWebPush, b64urlDecode } from "./webpush.js";

const SUB_PREFIX = "sub:";
const SENT_PREFIX = "sent:";
const SENT_TTL = 48 * 60 * 60; // dedup markers expire after 48h
const DEFAULT_ORIGINS = ["https://magiccitynights.com", "https://www.magiccitynights.com", "https://bigdog90-dot.github.io"];
// Only real browser push services may be stored as endpoints (keeps the Worker from being used to hit arbitrary URLs).
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

// ---------- helpers ----------
function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const extra = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if ([...DEFAULT_ORIGINS, ...extra].includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  const h = { "Vary": "Origin" };
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(request, env) }
  });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 8192) throw new Error("Body too large");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export function isAdmin(request, env) {
  const token = env.ADMIN_TOKEN;
  if (!token || String(token).length < 16) return false; // admin routes stay locked until a strong token is set
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return !!m && timingSafeEqual(m[1].trim(), token);
}

export function validateSubscription(sub) {
  if (!sub || typeof sub !== "object") return "Missing subscription";
  const { endpoint, keys } = sub;
  if (typeof endpoint !== "string" || endpoint.length > 2048) return "Bad endpoint";
  let url;
  try { url = new URL(endpoint); } catch { return "Bad endpoint"; }
  if (url.protocol !== "https:") return "Endpoint must be https";
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return "Unknown push service";
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return "Missing keys";
  try {
    const p = b64urlDecode(keys.p256dh), a = b64urlDecode(keys.auth);
    if (p.length !== 65 || p[0] !== 4) return "Bad p256dh key";
    if (a.length !== 16) return "Bad auth secret";
  } catch { return "Bad keys"; }
  return null;
}

async function getVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys are not configured (set VAPID_PUBLIC_KEY var and VAPID_PRIVATE_KEY secret)");
  return importVapidKeys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

async function listSubscriptions(env) {
  const subs = [];
  let cursor;
  do {
    const page = await env.PUSH_SUBS.list({ prefix: SUB_PREFIX, cursor });
    for (const k of page.keys) {
      const raw = await env.PUSH_SUBS.get(k.name);
      if (!raw) continue;
      try { subs.push({ key: k.name, ...JSON.parse(raw) }); } catch { /* skip corrupt */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return subs;
}

/** Deliver one payload to many subscriptions; prunes 404/410 subscriptions. */
export async function deliver(env, subs, payload, opts = {}) {
  const vapid = await getVapid(env);
  const subject = env.VAPID_SUBJECT || "https://magiccitynights.com/";
  const limit = Number(env.SEND_LIMIT || 45); // free plan allows 50 outbound fetches per invocation
  const stats = { attempted: 0, sent: 0, failed: 0, pruned: 0, skipped: 0, errors: [] };
  const batch = subs.slice(0, limit);
  stats.skipped = subs.length - batch.length;
  const CONCURRENCY = 6;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const chunk = batch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((s) =>
      sendWebPush({ endpoint: s.endpoint, keys: s.keys }, payload, { vapid, subject, topic: opts.topic, fetchImpl: opts.fetchImpl })
        .catch((e) => ({ ok: false, status: 0, gone: false, endpoint: s.endpoint, error: String(e && e.message || e) }))
    ));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      stats.attempted++;
      if (r.ok) { stats.sent++; continue; }
      stats.failed++;
      if (r.gone) {
        await env.PUSH_SUBS.delete(chunk[j].key || SUB_PREFIX + await sha256Hex(chunk[j].endpoint));
        stats.pruned++;
      } else if (stats.errors.length < 5) {
        stats.errors.push({ status: r.status, host: safeHost(r.endpoint), detail: r.detail || r.error });
      }
    }
  }
  return stats;
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return "?"; } }

// ---------- same-night event matching ----------
/** YYYY-MM-DD for `date` in the given IANA time zone (default America/Chicago). */
export function localDate(date = new Date(), timeZone = "America/Chicago") {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date).replace(/\u202f/g, " ");
}

/** "19:30" / "7:30pm" / "7:30 PM" -> "7:30 PM"; anything else is returned trimmed. */
export function formatTime(t) {
  if (!t) return "";
  const s = String(t).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m24) {
    let h = +m24[1]; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return `${h}:${m24[2]} ${ap}`;
  }
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (m12) return `${+m12[1]}:${m12[2] || "00"} ${m12[3].toUpperCase()}M`;
  return s;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every date (YYYY-MM-DD) an event runs, with its show time for that date if known. */
function occurrences(ev, timeZone) {
  const out = [];
  const push = (d, time) => { if (d) out.push({ date: d, time: time || "" }); };
  const fromValue = (v, fallbackTime) => {
    if (!v) return;
    if (typeof v === "object") {
      fromValue(v.date || v.start || v.startDate, v.time || v.startTime || fallbackTime);
      return;
    }
    const s = String(v).trim();
    if (DATE_RE.test(s)) return push(s, fallbackTime);
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    if (m) {
      // Full timestamp. With an offset/Z, convert to the event's local day; without one it is already local.
      if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
        const d = new Date(s);
        if (!isNaN(d)) return push(localDate(d, timeZone), fallbackTime || localTime(d, timeZone));
      }
      return push(m[1], fallbackTime || formatTime(m[2]));
    }
  };
  const evTime = ev.time || ev.startTime || ev.showtime || "";
  fromValue(ev.date, evTime);
  if (!ev.date && ev.start) fromValue(ev.start, evTime);
  if (!ev.date && !ev.start && ev.startDate) fromValue(ev.startDate, evTime);
  if (Array.isArray(ev.dates)) ev.dates.forEach((d) => fromValue(d, evTime));
  if (Array.isArray(ev.showtimes)) ev.showtimes.forEach((d) => fromValue(d, evTime));
  return out;
}

export function eventId(ev) {
  if (ev.id != null && String(ev.id).trim()) return String(ev.id).trim().slice(0, 120);
  const base = `${ev.title || ev.name || "event"}-${ev.venue || ""}`;
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

function venueName(ev) {
  const v = ev.venue;
  if (v && typeof v === "object") return v.name || "";
  return v || ev.venueName || ev.location || "";
}

/** Normalize events.json: a bare array, or { events: [...] }. */
export function normalizeEvents(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.events)) return data.events;
  return [];
}

/** All events happening on `today` (YYYY-MM-DD, Central time). */
export function eventsTonight(events, today, timeZone = "America/Chicago") {
  const hits = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.cancelled || ev.canceled || ev.status === "cancelled" || ev.soldOut === true) continue; // no point alerting for a sold-out show
    // Spec shortcut first: ev.date === today or ev.dates includes today.
    let occ = occurrences(ev, timeZone).find((o) => o.date === today);
    if (!occ && Array.isArray(ev.dates) && ev.dates.includes(today)) occ = { date: today, time: ev.time || "" };
    if (!occ) continue;
    hits.push({
      id: eventId(ev),
      title: String(ev.title || ev.name || "Tonight's show").trim(),
      venue: String(venueName(ev)).trim(),
      time: formatTime(occ.time),
      url: ev.url || ev.link || ev.tickets || ""
    });
  }
  return hits;
}

// "the Alabama Theatre", but "Iron City" / "Saturn" stay bare.
const THE_VENUES = /^(alabama theatre|lyric theatre|bjcc|alys (robinson )?stephens|jemison|carver theatre|virginia samford theatre|steel city jazz|alabama jazz hall|sidewalk film|red mountain theatre|birmingham-jefferson|legacy arena|avondale brewing|protective stadium|boutwell|wright center|lyric)/i;
export function withArticle(venue) {
  const v = String(venue || "").trim();
  if (!v) return "";
  if (/^the\s/i.test(v)) return "the " + v.slice(4);
  return THE_VENUES.test(v) ? "the " + v : v;
}

export function formatAlert(hits, siteUrl = "https://magiccitynights.com/") {
  const eventsUrl = new URL("/?view=events", siteUrl).toString();
  const line = (h) => {
    const at = h.venue ? ` at ${withArticle(h.venue)}` : "";
    return `${h.title}${at}${h.time ? " \u00b7 " + h.time : ""}`;
  };
  if (hits.length === 1) {
    const h = hits[0];
    const at = h.venue ? ` at ${withArticle(h.venue)}` : "";
    return {
      title: "Tonight in Birmingham",
      body: `${h.title} is tonight${at}${h.time ? " \u00b7 " + h.time : ""}`,
      eventTitle: h.title, venue: h.venue, time: h.time,
      url: eventsUrl, tag: `mcn-${hits[0].id}`.slice(0, 64)
    };
  }
  const first = hits[0];
  return {
    title: `Tonight in Birmingham: ${hits.length} events`,
    body: `${line(first)} + ${hits.length - 1} more: ${hits.slice(1, 4).map((h) => h.title).join(", ")}${hits.length > 4 ? "\u2026" : ""}`,
    eventTitle: first.title, venue: first.venue, time: first.time,
    url: eventsUrl, tag: `mcn-tonight-${hits.length}`
  };
}

/** The cron job (also callable from /admin/trigger-tonight). */
export async function runTonight(env, { date, dryRun = false, force = false, fetchImpl } = {}) {
  const timeZone = env.TIMEZONE || "America/Chicago";
  const today = date && DATE_RE.test(date) ? date : localDate(new Date(), timeZone);
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(env.EVENTS_URL || "https://magiccitynights.com/events.json", { headers: { "Accept": "application/json" }, cf: { cacheTtl: 300 } });
  if (!res.ok) return { ok: false, today, error: `events.json returned ${res.status}` };
  const events = normalizeEvents(await res.json());
  const hits = eventsTonight(events, today, timeZone);

  // Dedup: one alert per event per night, even if the cron retries or the admin trigger runs again.
  const fresh = [];
  for (const h of hits) {
    if (force || dryRun) { fresh.push(h); continue; }
    if (!(await env.PUSH_SUBS.get(`${SENT_PREFIX}${today}:${h.id}`))) fresh.push(h);
  }
  const result = { ok: true, today, totalEvents: events.length, matched: hits, toSend: fresh.map((h) => h.id), dryRun: !!dryRun };
  if (!fresh.length) return { ...result, note: hits.length ? "Already sent tonight" : "No events tonight" };

  const payload = formatAlert(fresh, env.SITE_URL);
  result.payload = payload;
  if (dryRun) return result;

  const subs = await listSubscriptions(env);
  // One combined alert per subscriber keeps the free plan's per-run fetch budget (~45 subscribers) intact.
  result.stats = await deliver(env, subs, payload, { topic: payload.tag });
  for (const h of fresh) await env.PUSH_SUBS.put(`${SENT_PREFIX}${today}:${h.id}`, String(Date.now()), { expirationTtl: SENT_TTL });
  return result;
}

// ---------- routes ----------
async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  if (request.method === "GET" && (path === "/health" || path === "/")) return json({ ok: true, service: "magic-city-nights-push" }, 200, request, env);
  if (request.method === "GET" && path === "/vapid-public-key") {
    if (!env.VAPID_PUBLIC_KEY) return json({ error: "VAPID_PUBLIC_KEY not set" }, 503, request, env);
    return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, request, env);
  }

  if (request.method !== "POST") return json({ error: "Not found" }, 404, request, env);

  if (path === "/subscribe" || path === "/unsubscribe") {
    // Browsers on other sites can't use these (CORS), but non-browser clients still can; validation keeps it tidy.
    let body;
    try { body = await readJson(request); } catch { return json({ error: "Invalid JSON" }, 400, request, env); }
    const sub = body.subscription || body;
    if (path === "/unsubscribe") {
      if (typeof sub.endpoint !== "string" || !sub.endpoint) return json({ error: "Missing endpoint" }, 400, request, env);
      await env.PUSH_SUBS.delete(SUB_PREFIX + await sha256Hex(sub.endpoint));
      return json({ ok: true, unsubscribed: true }, 200, request, env);
    }
    const err = validateSubscription(sub);
    if (err) return json({ error: err }, 400, request, env);
    const key = SUB_PREFIX + await sha256Hex(sub.endpoint);
    const record = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: new Date().toISOString(), platform: String(body.platform || "").slice(0, 20) };
    await env.PUSH_SUBS.put(key, JSON.stringify(record));
    return json({ ok: true, subscribed: true }, 201, request, env);
  }

  if (path.startsWith("/admin/")) {
    if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401, request, env);
    let body;
    try { body = await readJson(request); } catch { return json({ error: "Invalid JSON" }, 400, request, env); }

    if (path === "/admin/send-test") {
      const payload = {
        title: body.title || "Tonight in Birmingham",
        body: body.body || "A Motown Christmas is tonight at the Alabama Theatre \u00b7 7:00 PM",
        eventTitle: body.eventTitle || "A Motown Christmas",
        venue: body.venue || "Alabama Theatre",
        time: body.time || "7:00 PM",
        url: body.url || new URL("/?view=events", env.SITE_URL || "https://magiccitynights.com/").toString(),
        tag: body.tag || "mcn-test"
      };
      let subs = await listSubscriptions(env);
      if (body.endpoint) subs = subs.filter((s) => s.endpoint === body.endpoint);
      const stats = await deliver(env, subs, payload, { topic: "mcn-test" });
      return json({ ok: true, subscribers: subs.length, payload, stats }, 200, request, env);
    }
    if (path === "/admin/trigger-tonight") {
      const result = await runTonight(env, { date: body.date, dryRun: !!body.dryRun, force: !!body.force });
      return json(result, result.ok ? 200 : 502, request, env);
    }
    if (path === "/admin/stats") {
      const subs = await listSubscriptions(env);
      const byHost = {};
      for (const s of subs) { const h = safeHost(s.endpoint); byHost[h] = (byHost[h] || 0) + 1; }
      return json({ ok: true, subscribers: subs.length, byHost }, 200, request, env);
    }
  }
  return json({ error: "Not found" }, 404, request, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error("push worker error", err && err.stack || err);
      return json({ error: "Server error", detail: String(err && err.message || err) }, 500, request, env);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runTonight(env).then((r) => console.log("same-night alerts", JSON.stringify({ today: r.today, matched: (r.matched || []).length, toSend: r.toSend, stats: r.stats, note: r.note, error: r.error }))));
  }
};
