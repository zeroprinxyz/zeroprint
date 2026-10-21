// Who the tracer service is told is asking. A visitor's IP never leaves this process: with the
// per-visitor scan limit on, the tracer sees a salted hash whose salt is replaced every day, so
// yesterday's ids cannot be matched to today's. The limit is off unless FOOTPRINT_LIMIT=on, and
// then every scan gets its own id, so no per-visitor limit applies anywhere along the way.
import { createHash, randomBytes } from "node:crypto";

/** Behind the public edge every request comes from the proxy; only then trust its X-Forwarded-For. */
export function visitorIp(req, trustedProxy) {
  const peer = req.socket?.remoteAddress ?? "";
  if (peer.replace(/^::ffff:/, "") === trustedProxy) return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "visitor";
  return peer || "visitor";
}

let salt = { key: randomBytes(32), at: Date.now() };

export function visitorId(req, trustedProxy, limit = process.env.FOOTPRINT_LIMIT) {
  if (limit !== "on") return `v-${randomBytes(8).toString("hex")}`;
  if (Date.now() - salt.at > 86_400_000) salt = { key: randomBytes(32), at: Date.now() };
  return `v-${createHash("sha256").update(salt.key).update(visitorIp(req, trustedProxy)).digest("hex").slice(0, 16)}`;
}
