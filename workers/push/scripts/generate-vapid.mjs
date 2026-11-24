#!/usr/bin/env node
// Generate a VAPID key pair for Magic City Nights push alerts (Node 18+, no dependencies).
// The PUBLIC key is safe to share (it goes in wrangler.toml and index.html).
// The PRIVATE key is a secret: store it ONLY with `wrangler secret put VAPID_PRIVATE_KEY`. Never commit it.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, "base64url"), Buffer.from(pubJwk.y, "base64url")]);

const pub = b64u(raw);
const priv = privJwk.d; // already base64url, 32 bytes

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ publicKey: pub, privateKey: priv }));
} else {
  console.log(`
VAPID keys generated.

PUBLIC key (safe to share; paste into wrangler.toml VAPID_PUBLIC_KEY and index.html PUSH_CONFIG.vapidPublicKey):
${pub}

PRIVATE key (SECRET; do NOT commit, do NOT paste into any file):
${priv}

Next, from workers/push/ run:
  npx wrangler secret put VAPID_PRIVATE_KEY     # paste the PRIVATE key above when prompted
  npx wrangler secret put ADMIN_TOKEN           # paste a long random password you make up
`);
}
