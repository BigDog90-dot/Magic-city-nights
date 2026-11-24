// Run with: npm test  (= node --test test/*.test.mjs, Node 18+; no dependencies)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { b64urlDecode, b64urlEncode, encryptPayload, createVapidJwt, importVapidKeys, hkdfExtract, hkdfExpand } from "../src/webpush.js";
import worker, { eventsTonight, formatAlert, localDate, runTonight, sha256Hex, validateSubscription, withArticle, formatTime } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const subtle = globalThis.crypto.subtle;

// ---------- helpers ----------
class MemoryKV {
  constructor() { this.map = new Map(); this.ttls = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v, opts = {}) { this.map.set(k, String(v)); if (opts.expirationTtl) this.ttls.set(k, opts.expirationTtl); }
  async delete(k) { this.map.delete(k); this.ttls.delete(k); }
  async list({ prefix = "", cursor } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + 2); // tiny pages to exercise cursor pagination
    const done = start + 2 >= keys.length;
    return { keys: page.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + 2) };
  }
}

function genVapid() {
  const out = execFileSync(process.execPath, [path.join(here, "../scripts/generate-vapid.mjs"), "--json"]).toString();
  return JSON.parse(out);
}

/** A fake browser subscription: real P-256 key pair + auth secret, so we can decrypt what the Worker sends. */
function fakeBrowser(host = "fcm.googleapis.com") {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: {
      endpoint: `https://${host}/fcm/send/${nodeCrypto.randomBytes(12).toString("hex")}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }
    }
  };
}

/** Independent RFC 8291 decryption using node:crypto (not our Web Crypto code). */
function decryptAes128gcm(body, ecdh, authSecret) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  // Strip padding: last non-zero byte must be the 0x02 delimiter.
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, "padding delimiter 0x02");
  return plain.subarray(0, end).toString("utf8");
}

function verifyJwt(jwt, publicKeyB64) {
  const [h, c, s] = jwt.split(".");
  const raw = Buffer.from(publicKeyB64, "base64url");
  const key = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = nodeCrypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(c, "base64url")) };
}

const EVENTS = [
  { id: "motown-christmas-2026", title: "Motown Christmas", venue: "Alabama Theatre", date: "2026-12-07", time: "19:30", url: "https://alabamatheatre.com/" },
  { id: "holiday-films", title: "Holiday Film Series", venue: "Alabama Theatre", dates: ["2026-12-11", "2026-12-12", "2026-12-13"], time: "7:00 PM" },
  { id: "chris-tomlin", title: "Chris Tomlin", venue: "Alabama Theatre", dates: [{ date: "2026-11-30", time: "7:00 PM" }, { date: "2026-12-01", time: "7:00 PM" }] },
  { id: "aso-messiah", title: "Handel's Messiah", venue: { name: "Alys Stephens Center" }, start: "2026-12-12T01:30:00Z" }, // 7:30 PM CST on Dec 11
  { id: "iron-city", title: "Late show", venue: "Iron City", start: "2026-12-07T23:30:00" },
  { id: "cancelled-one", title: "Called off", venue: "Iron City", date: "2026-12-07", cancelled: true }
];

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

function makeEnv(extra = {}) {
  const v = genVapid();
  return { env: { PUSH_SUBS: new MemoryKV(), VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, ADMIN_TOKEN: "test-admin-token-1234567890", EVENTS_URL: "https://magiccitynights.com/events.json", SITE_URL: "https://magiccitynights.com/", TIMEZONE: "America/Chicago", ...extra }, vapid: v };
}

/** Install a fetch mock: events.json served from `events`, push endpoints recorded, status per host. */
function mockFetch({ events = EVENTS, statusFor = () => 201 } = {}) {
  const pushes = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input && input.url || input);
    if (url.endsWith("/events.json")) return new Response(JSON.stringify(events), { status: 200, headers: { "Content-Type": "application/json" } });
    pushes.push({ url, headers: init.headers, body: new Uint8Array(init.body) });
    return new Response("", { status: statusFor(url) });
  };
  return pushes;
}

const req = (p, { method = "POST", body, token, origin = "https://magiccitynights.com" } = {}) =>
  new Request("https://mcn-push.example.workers.dev" + p, { method, headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });

// ---------- RFC 8291 ----------
test("RFC 8291 Appendix A test vector: exact intermediate values and ciphertext", async () => {
  const asPublic = b64urlDecode("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const asPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(asPublic.slice(1, 33)), y: b64urlEncode(asPublic.slice(33)), d: asPrivate };
  const privateKey = await subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const { body, intermediates } = await encryptPayload("When I grow up, I want to be a watermelon",
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { asKeyPair: { privateKey, publicKey }, salt: b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw") });
  assert.equal(b64urlEncode(intermediates.ecdhSecret), "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
  assert.equal(b64urlEncode(intermediates.prkKey), "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k");
  assert.equal(b64urlEncode(intermediates.ikm), "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg");
  assert.equal(b64urlEncode(intermediates.prk), "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc");
  assert.equal(b64urlEncode(intermediates.cek), "oIhVW04MRdy2XN9CiKLxTg");
  assert.equal(b64urlEncode(intermediates.nonce), "4h_95klXJ5E_qnoN");
  assert.equal(b64urlEncode(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("aes128gcm round trip: random keys, decrypted independently with node:crypto (incl. emoji/UTF-8)", async () => {
  for (let i = 0; i < 5; i++) {
    const b = fakeBrowser();
    const msg = JSON.stringify({ title: "Tonight in Birmingham", body: `Motown Christmas is tonight at the Alabama Theatre \u00b7 7:30 PM \ud83c\udf84 #${i}` });
    const { body } = await encryptPayload(msg, b.subscription.keys);
    assert.equal(decryptAes128gcm(body, b.ecdh, b.auth), msg);
  }
});

test("hkdf helpers match node:crypto hkdfSync", async () => {
  const ikm = nodeCrypto.randomBytes(32), salt = nodeCrypto.randomBytes(16), info = Buffer.from("info\0");
  const ours = await hkdfExpand(await hkdfExtract(salt, ikm), info, 16);
  assert.deepEqual(Buffer.from(ours), Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, info, 16)));
});

// ---------- VAPID ----------
test("generate-vapid.mjs makes a valid P-256 pair and ES256 JWT verifies (RFC 8292)", async () => {
  const v = genVapid();
  assert.equal(b64urlDecode(v.publicKey).length, 65);
  assert.equal(b64urlDecode(v.publicKey)[0], 4);
  assert.equal(b64urlDecode(v.privateKey).length, 32);
  const keys = await importVapidKeys(v.publicKey, v.privateKey);
  const now = Date.now();
  const jwt = await createVapidJwt({ audience: "https://web.push.apple.com", subject: "https://magiccitynights.com/", privateKey: keys.privateKey, now });
  const { ok, header, claims } = verifyJwt(jwt, v.publicKey);
  assert.ok(ok, "signature verifies with the public key");
  assert.deepEqual(header, { typ: "JWT", alg: "ES256" });
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, "https://magiccitynights.com/");
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600, "exp within 24h");
  // A different key must not verify.
  assert.equal(verifyJwt(jwt, genVapid().publicKey).ok, false);
});

// ---------- same-night matcher ----------
test("Central-time matcher: Motown Christmas on 2026-12-07 at the Alabama Theatre", () => {
  const hits = eventsTonight(EVENTS, "2026-12-07");
  assert.deepEqual(hits.map((h) => h.id), ["motown-christmas-2026", "iron-city"]); // cancelled one skipped
  assert.equal(hits[0].time, "7:30 PM");
  const alert = formatAlert([hits[0]]);
  assert.equal(alert.title, "Tonight in Birmingham");
  assert.equal(alert.body, "Motown Christmas is tonight at the Alabama Theatre \u00b7 7:30 PM");
  assert.equal(alert.url, "https://magiccitynights.com/?view=events");
  assert.equal(alert.venue, "Alabama Theatre");
});

test("multi-date events, object dates, and UTC timestamps that land on the Central-time day", () => {
  assert.deepEqual(eventsTonight(EVENTS, "2026-12-12").map((h) => h.id), ["holiday-films"]);
  const dec11 = eventsTonight(EVENTS, "2026-12-11");
  assert.deepEqual(dec11.map((h) => h.id), ["holiday-films", "aso-messiah"]); // 01:30Z Dec 12 = 7:30 PM CST Dec 11
  assert.equal(dec11[1].time, "7:30 PM");
  assert.equal(dec11[1].venue, "Alys Stephens Center");
  assert.deepEqual(eventsTonight(EVENTS, "2026-12-01").map((h) => h.id), ["chris-tomlin"]);
  assert.deepEqual(eventsTonight({ events: EVENTS }.events, "2026-12-25"), []);
  const multi = formatAlert(dec11);
  assert.match(multi.title, /2 events/);
  assert.match(multi.body, /^Holiday Film Series at the Alabama Theatre \u00b7 7:00 PM \+ 1 more: Handel's Messiah$/);
});

test("Central date math across DST and midnight UTC", () => {
  assert.equal(localDate(new Date("2026-12-08T04:30:00Z")), "2026-12-07"); // 10:30 PM CST
  assert.equal(localDate(new Date("2026-12-08T06:30:00Z")), "2026-12-08");
  assert.equal(localDate(new Date("2026-07-05T04:30:00Z")), "2026-07-04"); // CDT
  assert.equal(localDate(new Date("2026-12-07T19:00:00Z")), "2026-12-07"); // cron time
  assert.equal(formatTime("19:30"), "7:30 PM");
  assert.equal(formatTime("8pm"), "8:00 PM");
  assert.equal(withArticle("Iron City"), "Iron City");
  assert.equal(withArticle("The Nick"), "the Nick");
});

// ---------- cron + KV dedup + pruning ----------
test("scheduled run: delivers decryptable alert, dedups in KV with 48h TTL, prunes 410 subscriptions", async () => {
  const { env } = makeEnv();
  const alive = fakeBrowser("fcm.googleapis.com");
  const apple = fakeBrowser("web.push.apple.com");
  const gone = fakeBrowser("updates.push.services.mozilla.com");
  for (const b of [alive, apple, gone]) {
    const r = await worker.fetch(req("/subscribe", { body: b.subscription }), env, {});
    assert.equal(r.status, 201);
  }
  const pushes = mockFetch({ statusFor: (u) => (u.includes("mozilla") ? 410 : 201) });

  const r1 = await runTonight(env, { date: "2026-12-07" });
  assert.equal(r1.ok, true);
  assert.equal(r1.stats.sent, 2);
  assert.equal(r1.stats.pruned, 1);
  assert.equal(pushes.length, 3);
  // Gone subscription removed from KV.
  assert.equal(await env.PUSH_SUBS.get("sub:" + await sha256Hex(gone.subscription.endpoint)), null);
  // Headers + decryptable payload.
  const fcmPush = pushes.find((p) => p.url.startsWith("https://fcm.googleapis.com"));
  assert.equal(fcmPush.headers["Content-Encoding"], "aes128gcm");
  assert.match(fcmPush.headers["Authorization"], /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
  const jwt = fcmPush.headers["Authorization"].match(/t=([^,]+)/)[1];
  assert.equal(verifyJwt(jwt, env.VAPID_PUBLIC_KEY).claims.aud, "https://fcm.googleapis.com");
  const applePush = pushes.find((p) => p.url.startsWith("https://web.push.apple.com"));
  assert.equal(verifyJwt(applePush.headers["Authorization"].match(/t=([^,]+)/)[1], env.VAPID_PUBLIC_KEY).claims.aud, "https://web.push.apple.com");
  const payload = JSON.parse(decryptAes128gcm(applePush.body, apple.ecdh, apple.auth));
  assert.match(payload.body, /^Motown Christmas at the Alabama Theatre \u00b7 7:30 PM \+ 1 more: Late show$/);
  // Dedup markers with 48h TTL.
  assert.ok(await env.PUSH_SUBS.get("sent:2026-12-07:motown-christmas-2026"));
  assert.equal(env.PUSH_SUBS.ttls.get("sent:2026-12-07:motown-christmas-2026"), 172800);

  // Retry the same night: nothing sent again.
  const before = pushes.length;
  const r2 = await runTonight(env, { date: "2026-12-07" });
  assert.equal(r2.note, "Already sent tonight");
  assert.equal(pushes.length, before);
});

test("scheduled() handler uses today's Central date and waits on the job", async () => {
  const { env } = makeEnv();
  const today = localDate(new Date());
  const pushes = mockFetch({ events: [{ id: "tonight-x", title: "Test Show", venue: "Alabama Theatre", date: today, time: "7:30 PM" }] });
  const b = fakeBrowser();
  await worker.fetch(req("/subscribe", { body: b.subscription }), env, {});
  const waits = [];
  await worker.scheduled({ cron: "0 19 * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(pushes.length, 1);
  const payload = JSON.parse(decryptAes128gcm(pushes[0].body, b.ecdh, b.auth));
  assert.equal(payload.body, "Test Show is tonight at the Alabama Theatre \u00b7 7:30 PM");
  assert.ok(await env.PUSH_SUBS.get(`sent:${today}:tonight-x`));
});

// ---------- HTTP routes + auth ----------
test("routes: health, public key, CORS, subscribe validation, unsubscribe", async () => {
  const { env } = makeEnv();
  let r = await worker.fetch(req("/health", { method: "GET" }), env, {});
  assert.deepEqual((await r.json()).ok, true);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://magiccitynights.com");
  r = await worker.fetch(req("/vapid-public-key", { method: "GET", origin: "http://localhost:8080" }), env, {});
  assert.equal((await r.json()).publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:8080");
  r = await worker.fetch(req("/health", { method: "GET", origin: "https://evil.example" }), env, {});
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  r = await worker.fetch(req("/subscribe", { method: "OPTIONS" }), env, {});
  assert.equal(r.status, 204);

  const b = fakeBrowser();
  assert.equal(validateSubscription({ ...b.subscription, endpoint: "https://evil.example/x" }), "Unknown push service");
  assert.equal(validateSubscription({ ...b.subscription, endpoint: "http://fcm.googleapis.com/x" }), "Endpoint must be https");
  assert.equal(validateSubscription({ endpoint: b.subscription.endpoint, keys: { p256dh: "AAAA", auth: b.subscription.keys.auth } }), "Bad p256dh key");
  r = await worker.fetch(req("/subscribe", { body: { endpoint: "https://evil.example/x", keys: b.subscription.keys } }), env, {});
  assert.equal(r.status, 400);
  r = await worker.fetch(req("/subscribe", { body: { subscription: b.subscription, platform: "ios" } }), env, {});
  assert.equal(r.status, 201);
  const key = "sub:" + await sha256Hex(b.subscription.endpoint);
  assert.equal(JSON.parse(await env.PUSH_SUBS.get(key)).platform, "ios");
  r = await worker.fetch(req("/unsubscribe", { body: { endpoint: b.subscription.endpoint } }), env, {});
  assert.equal(r.status, 200);
  assert.equal(await env.PUSH_SUBS.get(key), null);
});

test("admin Bearer auth: 401 without/with wrong token, locked when ADMIN_TOKEN unset or weak", async () => {
  const { env } = makeEnv();
  mockFetch();
  for (const p of ["/admin/send-test", "/admin/trigger-tonight", "/admin/stats"]) {
    assert.equal((await worker.fetch(req(p, { body: {} }), env, {})).status, 401);
    assert.equal((await worker.fetch(req(p, { body: {}, token: "wrong-token-wrong-token" }), env, {})).status, 401);
  }
  const weak = { ...env, ADMIN_TOKEN: "short" };
  assert.equal((await worker.fetch(req("/admin/stats", { body: {}, token: "short" }), weak, {})).status, 401);
  const none = { ...env, ADMIN_TOKEN: undefined };
  assert.equal((await worker.fetch(req("/admin/stats", { body: {}, token: "undefined" }), none, {})).status, 401);
});

test("admin send-test (all or one endpoint) and trigger-tonight dryRun for 2026-12-07", async () => {
  const { env } = makeEnv();
  const a = fakeBrowser(), b = fakeBrowser("web.push.apple.com");
  await worker.fetch(req("/subscribe", { body: a.subscription }), env, {});
  await worker.fetch(req("/subscribe", { body: b.subscription }), env, {});
  const pushes = mockFetch();
  const token = env.ADMIN_TOKEN;

  let r = await worker.fetch(req("/admin/send-test", { body: {}, token }), env, {});
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.stats.sent, 2);
  const p = JSON.parse(decryptAes128gcm(pushes.find((x) => x.url === a.subscription.endpoint).body, a.ecdh, a.auth));
  assert.equal(p.body, "A Motown Christmas is tonight at the Alabama Theatre \u00b7 7:00 PM");
  assert.equal(p.url, "https://magiccitynights.com/?view=events");

  r = await worker.fetch(req("/admin/send-test", { body: { endpoint: b.subscription.endpoint, body: "Hello Houston" }, token }), env, {});
  j = await r.json();
  assert.equal(j.stats.sent, 1);
  assert.equal(JSON.parse(decryptAes128gcm(pushes.at(-1).body, b.ecdh, b.auth)).body, "Hello Houston");

  const n = pushes.length;
  r = await worker.fetch(req("/admin/trigger-tonight", { body: { date: "2026-12-07", dryRun: true }, token }), env, {});
  j = await r.json();
  assert.equal(j.dryRun, true);
  assert.deepEqual(j.toSend, ["motown-christmas-2026", "iron-city"]);
  assert.equal(pushes.length, n, "dry run sends nothing");
  assert.equal(await env.PUSH_SUBS.get("sent:2026-12-07:motown-christmas-2026"), null, "dry run writes no dedup marker");

  r = await worker.fetch(req("/admin/stats", { body: {}, token }), env, {});
  assert.equal((await r.json()).subscribers, 2);
});

test("real Magic City Nights events.json shape ({ events: [...] }, startTime, soldOut, endDate runs)", async () => {
  const real = { updated: "2026-11-24", timezone: "America/Chicago", events: [
    { id: "ev-motown-christmas-2026-12-07", title: "A Motown Christmas", venue: "Alabama Theatre", date: "2026-12-07", startTime: "19:00", endTime: "21:00", timeLabel: "Mon, Dec 7 \u00b7 7 PM", category: "concert", url: "https://alabamatheatre.com/events/" },
    { id: "ev-sold-out-2026-12-07", title: "Sold Out Show", venue: "Iron City", date: "2026-12-07", startTime: "20:00", soldOut: true },
    { id: "ev-sound-of-music-2027-02-02", title: "The Sound of Music", venue: "BJCC Concert Hall", date: "2027-02-02", endDate: "2027-02-07", startTime: null }
  ], calendars: [{ id: "cal-bbrtc", title: "BBRTC" }] };
  const { env } = makeEnv();
  const b = fakeBrowser("web.push.apple.com");
  await worker.fetch(req("/subscribe", { body: b.subscription }), env, {});
  const pushes = mockFetch({ events: real });
  const r = await runTonight(env, { date: "2026-12-07" });
  assert.deepEqual(r.toSend, ["ev-motown-christmas-2026-12-07"], "sold-out show skipped");
  const payload = JSON.parse(decryptAes128gcm(pushes[0].body, b.ecdh, b.auth));
  assert.equal(payload.body, "A Motown Christmas is tonight at the Alabama Theatre \u00b7 7:00 PM");
  assert.equal(payload.tag, "mcn-ev-motown-christmas-2026-12-07");
  const opening = eventsTonight(real.events, "2027-02-02");
  assert.equal(opening.length, 1);
  assert.equal(formatAlert(opening).body, "The Sound of Music is tonight at the BJCC Concert Hall");
  assert.deepEqual(eventsTonight(real.events, "2027-02-04"), [], "multi-night runs alert on opening night only");
});
