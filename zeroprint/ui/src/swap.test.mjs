// The two things the Swap tab decides on its own: what state a swap is in when the page draws it,
// and what it tells someone before they send. Everything else is the provider's answer passed
// through. A quote that ran out while the address sat on screen must not look like a swap in
// progress, and must not quietly become a different address either.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exact, reachableFrom, sendAdvice, swapState, txUrl } from "./swap.js";

const NOW = 1_700_000_000_000;
const rec = (over = {}) => ({
  id: "a",
  at: NOW - 60_000,
  origin: "sol",
  originName: "Solana",
  originToken: "USDC",
  originDecimals: 6,
  dest: "hood",
  destName: "Robinhood Chain",
  destToken: "ETH",
  amountIn: "5000000",
  provider: "near",
  depositAddress: "9uHDETxuerKPzFMKgUm3Gc8164VHhxVHxCVaJtp3GgZd",
  recipient: "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e",
  refundTo: "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg",
  expiresAt: NOW + 300_000,
  state: "quoted",
  ...over,
});

test("a fresh quote waits to be paid", () => {
  assert.equal(swapState(rec(), NOW), "quoted");
});

test("a quote nobody paid runs out, and says so", () => {
  assert.equal(swapState(rec({ expiresAt: NOW - 1 }), NOW), "expired");
});

test("once the provider has seen the deposit the clock stops mattering", () => {
  assert.equal(swapState(rec({ expiresAt: NOW - 1, state: "processing" }), NOW), "processing");
});

// The provider says "waiting" from the moment it hands out the address — it means waiting FOR a
// deposit, not that one arrived. Treating it as progress hid the countdown a second after the
// quote and let the deadline pass in silence, with the address still on screen.
test("waiting is still waiting for the deposit, so it can run out", () => {
  assert.equal(swapState(rec({ state: "waiting" }), NOW), "waiting");
  assert.equal(swapState(rec({ expiresAt: NOW - 1, state: "waiting" }), NOW), "expired");
});

test("a swap that paid out is done however late we look at it", () => {
  assert.equal(swapState(rec({ expiresAt: NOW - 86_400_000, destTx: "0xdead" }), NOW), "done");
});

test("a refund and a failure are their own answers", () => {
  assert.equal(swapState(rec({ state: "refunded" }), NOW), "refunded");
  assert.equal(swapState(rec({ state: "failed" }), NOW), "failed");
});

test("a quote with no expiry is not treated as expired", () => {
  assert.equal(swapState(rec({ expiresAt: null }), NOW), "quoted");
});

test("before anything is sent, the advice names the refund address and what reaches it", () => {
  const said = sendAdvice(rec());
  assert.match(said, /vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg/);
  assert.match(said, /5 USDC/);
  assert.match(said, /refund/i);
});

test("the advice says the amount must be the one quoted, and names the chain it is sent on", () => {
  const said = sendAdvice(rec());
  assert.match(said, /Solana/);
  assert.match(said, /exact|exactly/i);
});

// A pair that cannot be filled is better missing from the picker than refused after someone has
// chosen it, picked an address and pressed the button.
const DESTS = [
  { id: "sol", name: "Solana", tokens: [{ symbol: "SOL" }, { symbol: "USDC" }] },
  { id: "btc", name: "Bitcoin", tokens: [{ symbol: "BTC" }] },
];
const KEYS = ["hood:ETH>sol:USDC", "hood:ETH>btc:BTC", "hood:USDG>sol:SOL"];

test("only what fills from this asset is offered", () => {
  const got = reachableFrom(KEYS, "hood", "ETH", DESTS);
  assert.deepEqual(got.map((d) => [d.id, d.tokens.map((t) => t.symbol)]), [["sol", ["USDC"]], ["btc", ["BTC"]]]);
});

test("a chain with nothing reachable on it drops out entirely", () => {
  const got = reachableFrom(KEYS, "hood", "USDG", DESTS);
  assert.deepEqual(got.map((d) => d.id), ["sol"]);
});

test("with no list at all nothing is hidden, which is the test network's case", () => {
  assert.deepEqual(reachableFrom(null, "hood", "ETH", DESTS), DESTS);
});

// Finishing a swap should end with something you can open. The provider sometimes gives the link
// itself; where it does not, the destination chain decides where the hash can be read.
test("a finished swap links to the chain it landed on", () => {
  assert.equal(txUrl("hood", "0xabc"), "https://robin.etherscan.io/tx/0xabc");
  assert.equal(txUrl("base", "0xabc"), "https://basescan.org/tx/0xabc");
  assert.equal(txUrl("sol", "5zxR9"), "https://solscan.io/tx/5zxR9");
  assert.equal(txUrl("btc", "abc"), "https://mempool.space/tx/abc");
});

test("the provider's own link wins, since it knows where it paid", () => {
  assert.equal(txUrl("hood", "0xabc", "https://example.org/tx/0xabc"), "https://example.org/tx/0xabc");
  assert.equal(txUrl("hood", "0xabc", ""), "https://robin.etherscan.io/tx/0xabc");
});

test("no hash is no link", () => {
  assert.equal(txUrl("hood", null), null);
  assert.equal(txUrl("nowhere", "0xabc"), null);
});

// The one sentence the whole flow rests on names an amount, and calls it exact. Rounding it to
// six places there told people to send 0.000456 BTC for a quote of 0.00045678 — a different
// amount, which by the page's own words is refunded rather than filled.
test("the amount to send is the amount quoted, to the last digit", () => {
  assert.equal(exact(45678n, 8), "0.00045678");
  assert.equal(exact(12345678900000000n, 18), "0.0123456789");
  assert.equal(exact(1999999n, 6), "1.999999");
  assert.equal(exact(10n ** 18n, 18), "1");
  assert.equal(exact(1n, 18), "0.000000000000000001");
});

test("the instruction carries that amount, not a rounded one", () => {
  const said = sendAdvice({ ...rec(), amountIn: "45678", originDecimals: 8, originToken: "BTC", originName: "Bitcoin" });
  assert.match(said, /exactly 0\.00045678 BTC/);
});

// A pasted token is on no pair list by construction, so filtering the destinations by it left
// none at all: the picker emptied, the labels threw, and the form stopped working on the one
// side the feature was meant to serve.
test("a pasted origin asset hides nothing: nobody has probed it", () => {
  const pasted = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  assert.deepEqual(reachableFrom(KEYS, "base", pasted, DESTS), DESTS);
  assert.deepEqual(reachableFrom(KEYS, "sol", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", DESTS), DESTS);
});
