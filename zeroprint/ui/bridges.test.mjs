// The bridge layer decides where a withdrawal lands, so every answer from Relay or NEAR Intents
// is checked before the app can act on it. These tests drive that checking with a stubbed fetch.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ROUTES, createBridges } from "./bridges.mjs";

const EVM = "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e";
const SOL = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg";
const AMOUNT = "9000000000000000";
const DEPOSIT = "0x417b117377b1C28c8D68239aDA433287A0784d79";
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));

const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body });

/** A Relay /quote/v2 answer for `amount` of native ETH on chain 4663. */
const relayBody = (amount = AMOUNT, over = {}) => ({
  steps: [
    {
      requestId: `0x${"1".repeat(64)}`,
      depositAddress: DEPOSIT,
      items: [{ data: { to: DEPOSIT, value: amount, data: "0x", chainId: 4663, ...over } }],
    },
  ],
  details: { currencyOut: { amount: "228367379", minimumAmount: "223800032", amountUsd: "24.3" }, timeEstimate: 1 },
});
const nearBody = (amount = AMOUNT, recipient = SOL, out = "100") => ({
  quote: { depositAddress: DEPOSIT, amountIn: amount, amountOut: out, minAmountOut: out, amountOutUsd: "1", timeEstimate: 22 },
  quoteRequest: { recipient },
});

/** Routes each provider to its own body; an Error body makes that provider fail. */
function stub({ relay, near }) {
  globalThis.fetch = async (url) => {
    const body = String(url).includes("relay.link") ? relay : near;
    if (body === undefined) throw new Error("provider not used in this test");
    if (body instanceof Error) throw body;
    return reply(body);
  };
}

const svc = (chainId = 4663) => createBridges({ chainId });

test("routes are only offered on Robinhood Chain mainnet", () => {
  assert.equal(svc(4663).enabled, true);
  assert.deepEqual(svc(46630).routes(), []);
  assert.equal(svc(46630).enabled, false);
});

test("every route reaches at least one provider, and Bitcoin and Zcash are NEAR-only", () => {
  for (const r of ROUTES) assert.ok(r.relay || r.near, r.id);
  for (const id of ["btc", "zec"]) assert.ok(!ROUTES.find((r) => r.id === id).relay, id);
});

test("a recipient in the wrong format is refused before any request goes out", async () => {
  globalThis.fetch = async () => assert.fail("must not call a bridge");
  for (const [route, recipient] of [
    ["sol", EVM],
    ["base", SOL],
    ["btc", EVM],
    ["zec", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["sol", ""],
  ])
    await assert.rejects(() => svc().quote({ route, amount: AMOUNT, recipient, refundTo: EVM }), /not a valid/, `${route} ${recipient}`);
});

test("a bad amount or refund address is refused", async () => {
  globalThis.fetch = async () => assert.fail("must not call a bridge");
  await assert.rejects(() => svc().quote({ route: "sol", amount: "0", recipient: SOL, refundTo: EVM }), /bad amount/);
  await assert.rejects(() => svc().quote({ route: "sol", amount: "-1", recipient: SOL, refundTo: EVM }), /bad amount/);
  await assert.rejects(() => svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: SOL }), /bad refund/);
  await assert.rejects(() => svc().quote({ route: "nope", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /unknown destination/);
});

test("the better quote wins and the other is kept for display", async () => {
  stub({ relay: relayBody(), near: nearBody(AMOUNT, SOL, "999999999") });
  const q = await svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM });
  assert.equal(q.provider, "near");
  assert.equal(q.amountOut, "999999999");
  assert.deepEqual(q.others, [{ provider: "relay", amountOut: "228367379" }]);
  assert.equal(q.symbol, "SOL");
  assert.equal(q.decimals, 9);
});

test("one provider failing still returns the other", async () => {
  stub({ relay: new Error("down"), near: nearBody() });
  assert.equal((await svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM })).provider, "near");
  stub({ relay: relayBody(), near: new Error("down") });
  assert.equal((await svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM })).provider, "relay");
});

test("both providers failing reports why", async () => {
  stub({ relay: new Error("relay is down"), near: new Error("near is down") });
  await assert.rejects(() => svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /relay is down.*near is down/s);
});

test("a Relay quote that does not pay the deposit address exactly is refused", async () => {
  const cases = {
    "wrong amount": relayBody("1"),
    "wrong chain": relayBody(AMOUNT, { chainId: 1 }),
    "pays somewhere else": relayBody(AMOUNT, { to: EVM }),
    "is a contract call": relayBody(AMOUNT, { data: "0xdeadbeef" }),
  };
  for (const [name, relay] of Object.entries(cases)) {
    stub({ relay, near: new Error("skip") });
    await assert.rejects(() => svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /unexpected Relay quote/, name);
  }
});

test("a NEAR quote for a different recipient or amount is refused", async () => {
  for (const near of [nearBody(AMOUNT, "SomeOtherWalletAddress11111111111111111111"), nearBody("1")]) {
    stub({ relay: new Error("skip"), near });
    await assert.rejects(() => svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /unexpected NEAR quote/);
  }
});

test("only a NEAR deposit is submitted, and only with a well-formed transaction hash", async () => {
  let sent = 0;
  globalThis.fetch = async () => ((sent += 1), reply({}));
  const tx = `0x${"a".repeat(64)}`;
  await svc().submit({ provider: "relay", depositAddress: DEPOSIT, txHash: tx });
  assert.equal(sent, 0, "Relay watches the chain itself");
  await svc().submit({ provider: "near", depositAddress: DEPOSIT, txHash: tx });
  assert.equal(sent, 1);
  await assert.rejects(() => svc().submit({ provider: "near", depositAddress: DEPOSIT, txHash: "0xnope" }), /bad submit/);
  await assert.rejects(() => svc().submit({ provider: "near", depositAddress: SOL, txHash: tx }), /bad submit/);
});

test("provider states map onto one vocabulary the app can act on", async () => {
  const want = { relay: [["waiting", "waiting"], ["pending", "processing"], ["success", "done"], ["refund", "refunded"], ["failure", "failed"], ["???", "processing"]],
                 near: [["PENDING_DEPOSIT", "waiting"], ["PROCESSING", "processing"], ["SUCCESS", "done"], ["REFUNDED", "refunded"], ["FAILED", "failed"], ["???", "processing"]] };
  for (const [provider, pairs] of Object.entries(want))
    for (const [raw, state] of pairs) {
      globalThis.fetch = async () => reply(provider === "relay" ? { status: raw, txHashes: ["0xabc"] } : { status: raw, swapDetails: { destinationChainTxHashes: [{ hash: "sig" }] } });
      const id = provider === "relay" ? `0x${"1".repeat(64)}` : DEPOSIT;
      const s = await svc().status({ provider, id });
      assert.equal(s.state, state, `${provider} ${raw}`);
      assert.equal(s.raw, raw);
    }
});

test("a status lookup with a malformed id is refused", async () => {
  globalThis.fetch = async () => assert.fail("must not call a bridge");
  await assert.rejects(() => svc().status({ provider: "relay", id: "nope" }), /bad id/);
  await assert.rejects(() => svc().status({ provider: "near", id: "nope" }), /bad id/);
  await assert.rejects(() => svc().status({ provider: "ghost", id: DEPOSIT }), /unknown provider/);
});

test("the test-only echo route pays the recipient directly and never leaves the chain", async () => {
  const t = createBridges({ chainId: 31337, test: true });
  globalThis.fetch = async () => assert.fail("echo must not call a bridge");
  const q = await t.quote({ route: "echo", amount: AMOUNT, recipient: EVM, refundTo: EVM });
  assert.equal(q.depositAddress, EVM);
  assert.equal(q.amountOut, AMOUNT);
  assert.equal((await t.status(q)).state, "done");
  assert.deepEqual(svc(4663).routes().map((r) => r.id).includes("echo"), false, "never on mainnet");
});
