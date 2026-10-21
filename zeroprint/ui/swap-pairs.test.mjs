// What the swap endpoints offer. A pair that no provider fills is worse than a pair that was
// never shown: the person finds out after their money has left. So the probe's list is what the
// page is given to choose from. It is not a gate on the quote itself - the providers answer for
// themselves, which is what lets the probe discover the list in the first place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowed, offered, pairKeys } from "./swap-pairs.mjs";

const ROUTES = [
  { id: "hood", name: "Robinhood Chain", kind: "evm", tokens: [{ symbol: "ETH" }, { symbol: "USDG" }] },
  { id: "sol", name: "Solana", kind: "solana", tokens: [{ symbol: "SOL" }, { symbol: "USDC" }] },
  { id: "btc", name: "Bitcoin", kind: "btc", tokens: [{ symbol: "BTC" }] },
];
const PAIRS = {
  generatedAt: "2026-10-21T00:00:00.000Z",
  pairs: [
    { origin: "hood", originToken: "ETH", dest: "sol", destToken: "USDC", provider: "near", minIn: "1000000000000000" },
    { origin: "sol", originToken: "USDC", dest: "hood", destToken: "ETH", provider: "relay", minIn: "2000000" },
  ],
};

test("a pair the probe found is allowed, and carries its minimum", () => {
  assert.deepEqual(allowed(PAIRS, { origin: "hood", originToken: "ETH", dest: "sol", destToken: "USDC" }), PAIRS.pairs[0]);
});

test("a pair the probe never found is refused, whichever end is wrong", () => {
  assert.equal(allowed(PAIRS, { origin: "hood", originToken: "USDG", dest: "sol", destToken: "USDC" }), null);
  assert.equal(allowed(PAIRS, { origin: "hood", originToken: "ETH", dest: "btc", destToken: "BTC" }), null);
});

test("a pair is one-way: filling one direction says nothing about the other", () => {
  assert.equal(allowed(PAIRS, { origin: "sol", originToken: "SOL", dest: "hood", destToken: "ETH" }), null);
});

test("with no list at all every pair is allowed, which is the test network's case", () => {
  assert.deepEqual(allowed(null, { origin: "hood", originToken: "ETH", dest: "echo", destToken: "tETH" }), {});
  assert.deepEqual(allowed({ pairs: [] }, { origin: "hood", originToken: "ETH", dest: "sol", destToken: "USDC" }), {});
});

test("the page is offered only the chains and assets some pair uses", () => {
  const { origins, destinations } = offered(PAIRS, ROUTES);
  assert.deepEqual(origins.map((o) => [o.id, o.tokens.map((t) => t.symbol)]), [["hood", ["ETH"]], ["sol", ["USDC"]]]);
  assert.deepEqual(destinations.map((d) => [d.id, d.tokens.map((t) => t.symbol)]), [["hood", ["ETH"]], ["sol", ["USDC"]]]);
});

test("with no list the page is offered everything", () => {
  const { origins, destinations } = offered(null, ROUTES);
  assert.deepEqual(origins, ROUTES);
  assert.deepEqual(destinations, ROUTES);
});

test("the page is handed the pairs themselves, or nothing when none were probed", () => {
  assert.deepEqual(pairKeys(PAIRS), ["hood:ETH>sol:USDC", "sol:USDC>hood:ETH"]);
  assert.equal(pairKeys(null), null);
  assert.equal(pairKeys({ pairs: [] })?.length, 0);
});

test("a pasted token address is left to the quote, not to the list", () => {
  assert.deepEqual(allowed(PAIRS, { origin: "hood", originToken: "ETH", dest: "hood", destToken: "0x39dbed3a2bd333467115de45665cc57f813c4571" }), {});
  assert.deepEqual(allowed(PAIRS, { origin: "sol", originToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", dest: "hood", destToken: "ETH" }), {});
});

// The quote asks with the bridge's own words — `route` and `token` for the far end, because a
// withdrawal has always called them that. Reading only `dest`/`destToken` here turned every real
// quote into "that pair is not available", while the probe's own shape matched and the tests
// passed.
test("a quote is understood whichever words it uses for the far end", () => {
  assert.deepEqual(allowed(PAIRS, { origin: "hood", originToken: "ETH", route: "sol", token: "USDC" }), PAIRS.pairs[0]);
  assert.deepEqual(allowed(PAIRS, { origin: "hood", originToken: "ETH", dest: "sol", destToken: "USDC" }), PAIRS.pairs[0]);
  assert.equal(allowed(PAIRS, { origin: "hood", originToken: "ETH", route: "btc", token: "BTC" }), null);
});

test("a quote that names no origin is the withdrawal's own: this chain, in ETH", () => {
  assert.deepEqual(allowed(PAIRS, { route: "sol", token: "USDC" }), PAIRS.pairs[0]);
});
