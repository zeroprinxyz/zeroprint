// The tracer runs as a separate service, so every Footprint scan crosses a process boundary. What
// that service is told about the visitor is decided here: never the IP itself, and — while the
// per-visitor scan limit is off — nothing that ties two scans to each other. These helpers once
// went missing with an unrelated edit and every scan answered "visitorId is not defined", so the
// cases below also keep them in place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { visitorId, visitorIp } from "./visitor.mjs";

const PROXY = "203.0.113.7"; // a documentation address: the real edge's is configuration, not a test fixture
const req = (peer, fwd) => ({ socket: { remoteAddress: peer }, headers: fwd ? { "x-forwarded-for": fwd } : {} });

test("behind the trusted edge the visitor's own IP is read from X-Forwarded-For", () => {
  assert.equal(visitorIp(req(PROXY, "198.51.100.22, 10.0.0.1"), PROXY), "198.51.100.22");
  assert.equal(visitorIp(req(`::ffff:${PROXY}`, "198.51.100.22"), PROXY), "198.51.100.22");
});

test("an X-Forwarded-For from anyone else is ignored", () => {
  assert.equal(visitorIp(req("198.51.100.9", "198.51.100.22"), PROXY), "198.51.100.9");
});

test("a request with no address at all still has a key", () => {
  assert.equal(visitorIp(req("", ""), PROXY), "visitor");
});

test("the limit is off unless FOOTPRINT_LIMIT=on: every scan gets its own id", () => {
  const r = req(PROXY, "198.51.100.22");
  assert.notEqual(visitorId(r, PROXY), visitorId(r, PROXY));
  assert.equal(new Set(Array.from({ length: 20 }, () => visitorId(r, PROXY, "off"))).size, 20);
});

test("the id never carries the IP", () => {
  const id = visitorId(req(PROXY, "198.51.100.22"), PROXY, "on");
  assert.ok(!id.includes("198.51.100.22"));
  assert.match(id, /^v-[0-9a-f]{16}$/);
});

test("with the limit on, one visitor keeps one id and two visitors differ", () => {
  const mine = visitorId(req(PROXY, "198.51.100.22"), PROXY, "on");
  assert.equal(visitorId(req(PROXY, "198.51.100.22"), PROXY, "on"), mine);
  assert.notEqual(visitorId(req(PROXY, "198.51.100.9"), PROXY, "on"), mine);
});
