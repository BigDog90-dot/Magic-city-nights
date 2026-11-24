// Zero-dependency Web Push for Cloudflare Workers (Web Crypto only).
// - VAPID (RFC 8292): ES256 / P-256 JWT, sent as `Authorization: vapid t=<jwt>, k=<public key>`
// - Payload encryption (RFC 8291 + RFC 8188): "aes128gcm" with ECDH P-256, HKDF-SHA-256, AES-128-GCM
// Works with Apple (web.push.apple.com), Google FCM (fcm.googleapis.com), Mozilla Autopush and Microsoft WNS.

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = String(str).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(keyBytes, data) {
  const key = await subtle().importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, data));
}

// HKDF (RFC 5869) split into extract/expand so intermediate values match RFC 8291 Appendix A.
export const hkdfExtract = (salt, ikm) => hmac(salt, ikm);
export async function hkdfExpand(prk, info, length) {
  // length <= 32 for every Web Push use, so one HMAC block is enough.
  const t = await hmac(prk, concat(info, new Uint8Array([1])));
  return t.slice(0, length);
}

/** Import a VAPID key pair from base64url strings: public = 65-byte uncompressed point, private = 32-byte scalar. */
export async function importVapidKeys(publicKeyB64, privateKeyB64) {
  const pub = b64urlDecode(publicKeyB64);
  const d = b64urlDecode(privateKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
  if (d.length !== 32) throw new Error("VAPID private key must be 32 bytes");
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: b64urlEncode(d)
  };
  const privateKey = await subtle().importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey: publicKeyB64, privateKey };
}

/** Build a signed VAPID JWT (RFC 8292) for one push service origin. */
export async function createVapidJwt({ audience, subject, privateKey, expiresInSeconds = 12 * 60 * 60, now = Date.now() }) {
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp: Math.floor(now / 1000) + expiresInSeconds, sub: subject };
  const unsigned = b64urlEncode(enc.encode(JSON.stringify(header))) + "." + b64urlEncode(enc.encode(JSON.stringify(claims)));
  // Web Crypto returns the raw r||s (IEEE P1363) signature, which is exactly what JWS ES256 wants.
  const sig = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(unsigned)));
  return unsigned + "." + b64urlEncode(sig);
}

/**
 * Encrypt a payload for one subscription (RFC 8291, "aes128gcm").
 * `testing` lets the test suite inject the RFC's fixed server key pair and salt.
 */
export async function encryptPayload(payload, subscriptionKeys, testing = {}) {
  const uaPublic = b64urlDecode(subscriptionKeys.p256dh);
  const authSecret = b64urlDecode(subscriptionKeys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Bad p256dh key");
  if (authSecret.length !== 16) throw new Error("Bad auth secret");
  const plaintext = typeof payload === "string" ? enc.encode(payload) : new Uint8Array(payload);
  if (plaintext.length > 3993) throw new Error("Payload too large for one Web Push record (max 3993 bytes)");

  // Ephemeral application-server ECDH key pair (fresh for every message).
  const asKeys = testing.asKeyPair || await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await subtle().exportKey("raw", asKeys.publicKey));
  const uaKey = await subtle().importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // RFC 8291 §3.3: combine ECDH secret with the auth secret.
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188: content encryption key + nonce.
  const salt = testing.salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext + 0x02 padding delimiter (last record).
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await subtle().importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  // Header: salt(16) | rs(4, big-endian) | idlen(1) | keyid (= as_public, 65 bytes)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return { body: concat(header, ciphertext), salt, asPublic, intermediates: { ecdhSecret, prkKey, ikm, prk, cek, nonce } };
}

/**
 * Send one Web Push message. Returns { ok, status, gone, endpoint }.
 * `gone` is true for 404/410: the subscription expired and should be deleted.
 */
export async function sendWebPush(subscription, payload, { vapid, subject, ttl = 12 * 60 * 60, urgency = "high", topic, fetchImpl } = {}) {
  const endpoint = subscription.endpoint;
  const audience = new URL(endpoint).origin;
  const jwt = await createVapidJwt({ audience, subject, privateKey: vapid.privateKey });
  const { body } = await encryptPayload(typeof payload === "string" ? payload : JSON.stringify(payload), subscription.keys);
  const headers = {
    "Authorization": `vapid t=${jwt}, k=${vapid.publicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    "TTL": String(ttl),
    "Urgency": urgency
  };
  if (topic) headers["Topic"] = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const doFetch = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(endpoint, { method: "POST", headers, body });
  } catch (err) {
    return { ok: false, status: 0, gone: false, endpoint, error: String(err && err.message || err) };
  }
  const status = res.status;
  let detail;
  if (!(status >= 200 && status < 300)) {
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
  }
  return { ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410, endpoint, detail };
}
