// The bridge layer decides where a withdrawal lands, so every answer from Relay or NEAR Intents
// is checked before the app can act on it. These tests drive that checking with a stubbed fetch.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ORIGINS, ROUTES, createBridges } from "./bridges.mjs";

const EVM = "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e";
const SOL = "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg";
const AMOUNT = "9000000000000000";
const DEPOSIT = "0x417b117377b1C28c8D68239aDA433287A0784d79";
const real = globalThis.fetch;
// Relay reserves a deposit address only for a caller it knows. Most cases here are about what it
// answers, not about that, so they run as a caller it knows; the case below runs as one it does not.
process.env.RELAY_API_KEY = "test-key";
afterEach(() => {
  globalThis.fetch = real;
  process.env.RELAY_API_KEY = "test-key";
});

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

test("every token reaches at least one provider, and Bitcoin and Zcash are NEAR-only", () => {
  for (const r of ROUTES) {
    assert.ok(r.tokens?.length, `${r.id} has tokens`);
    for (const t of r.tokens) assert.ok(t.relay || t.near, `${r.id}/${t.symbol}`);
    assert.ok(t_unique(r.tokens), `${r.id} has no duplicate symbols`);
  }
  for (const id of ["btc", "zec"]) for (const t of ROUTES.find((r) => r.id === id).tokens) assert.ok(!t.relay, id);
});
const t_unique = (ts) => new Set(ts.map((t) => t.symbol)).size === ts.length;

test("the same chain is offered too, so a withdrawal can arrive as a token on Robinhood Chain", () => {
  const hood = ROUTES.find((r) => r.id === "hood");
  assert.equal(hood.chainId, 4663);
  assert.ok(hood.tokens.some((t) => t.symbol === "USDG"), "a stablecoin is reachable");
  assert.equal(hood.tokens[0].symbol, "ETH", "ETH stays the default");
});

test("a token the destination does not carry is refused", async () => {
  globalThis.fetch = async () => assert.fail("must not call a bridge");
  await assert.rejects(() => svc().quote({ route: "sol", token: "PONS", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /not available on Solana/);
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
  await assert.rejects(() => svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: SOL }), /refund address/);
  await assert.rejects(() => svc().quote({ route: "nope", amount: AMOUNT, recipient: SOL, refundTo: EVM }), /unknown destination/);
});

test("the better quote wins and the other is kept for display", async () => {
  stub({ relay: relayBody(), near: nearBody(AMOUNT, SOL, "999999999") });
  const q = await svc().quote({ route: "sol", amount: AMOUNT, recipient: SOL, refundTo: EVM });
  assert.equal(q.provider, "near");
  assert.equal(q.amountOut, "999999999");
  assert.deepEqual(q.others, [{ provider: "relay", amountOut: "228367379" }]);
  assert.equal(q.symbol, "SOL", "SOL is the default token on Solana");
  assert.equal(q.decimals, 9);
  // a token quote carries that token's symbol and decimals instead
  stub({ relay: relayBody(), near: nearBody(AMOUNT, SOL, "1000000") });
  const u = await svc().quote({ route: "sol", token: "USDC", amount: AMOUNT, recipient: SOL, refundTo: EVM });
  assert.equal(u.token, "USDC");
  assert.equal(u.decimals, 6);
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

// ---------- Privacy Swap: an origin that is not Robinhood ETH ----------
// A swap is a withdrawal with the near end unpinned, so the same checking has to hold at both
// ends: the asset we name as the origin is the one the provider is asked for, and an address that
// cannot exist on the chain it is meant for never reaches a provider at all.

/** Captures what was posted, so a test can read the body the provider would have received. */
function capture({ relay, near }) {
  const seen = {};
  globalThis.fetch = async (url, init = {}) => {
    const which = String(url).includes("relay.link") ? "relay" : "near";
    seen[which] = JSON.parse(init.body ?? "{}");
    const body = which === "relay" ? relay : near;
    if (body === undefined) throw new Error("provider not used in this test");
    if (body instanceof Error) throw body;
    return reply(body);
  };
  return seen;
}
const never = () => {
  globalThis.fetch = async () => {
    throw new Error("a provider was called");
  };
};

test("a swap from Solana USDC asks the provider for that asset, not Robinhood ETH", async () => {
  const seen = capture({ relay: new Error("relay out"), near: nearBody("1000000", EVM, "900000") });
  const b = createBridges({ chainId: 4663 });
  const q = await b.quote({ origin: "sol", originToken: "USDC", route: "base", token: "USDC", amount: "1000000", recipient: EVM, refundTo: SOL });
  assert.equal(seen.near.originAsset, "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near");
  assert.equal(seen.near.depositType, "ORIGIN_CHAIN");
  assert.equal(seen.near.amount, "1000000");
  assert.equal(q.origin, "sol");
  assert.equal(q.originToken, "USDC");
});

test("an origin nobody serves is refused before any provider is called", async () => {
  never();
  const b = createBridges({ chainId: 4663 });
  await assert.rejects(
    b.quote({ origin: "dogecoin", originToken: "DOGE", route: "sol", token: "SOL", amount: AMOUNT, recipient: SOL, refundTo: EVM }),
    /origin/i,
  );
});

test("a recipient that cannot exist on the destination is refused before any provider is called", async () => {
  never();
  const b = createBridges({ chainId: 4663 });
  await assert.rejects(
    b.quote({ origin: "hood", originToken: "ETH", route: "sol", token: "SOL", amount: AMOUNT, recipient: EVM, refundTo: EVM }),
    /Solana/,
  );
});

test("a refund address that cannot exist on the origin is refused before any provider is called", async () => {
  never();
  const b = createBridges({ chainId: 4663 });
  await assert.rejects(
    b.quote({ origin: "sol", originToken: "SOL", route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM }),
    /refund/i,
  );
});

test("a withdrawal still quotes Robinhood ETH when no origin is named", async () => {
  const seen = capture({ relay: relayBody(), near: new Error("near out") });
  const b = createBridges({ chainId: 4663 });
  await b.quote({ route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM });
  assert.equal(seen.relay.originChainId, 4663);
  assert.equal(seen.relay.originCurrency, "0x0000000000000000000000000000000000000000");
});

test("every origin is a chain we can also send to, so one list serves both ends", () => {
  assert.deepEqual(ORIGINS.map((o) => o.id), ROUTES.map((r) => r.id));
});

// A probe asks about a thousand pairs. Asking for real would have each provider set aside a
// deposit address for every one of them, so it asks for the price alone: no address, nothing held.
test("a dry quote asks for a price and nothing is set aside", async () => {
  const seen = capture({ relay: relayBody(), near: new Error("near out") });
  const b = createBridges({ chainId: 4663 });
  const q = await b.quote({ route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM, dry: true });
  assert.equal(seen.relay.useDepositAddress, undefined);
  assert.equal(seen.relay.strict, undefined); // Relay refuses strict without a deposit address
  assert.equal(q.depositAddress, null);
  assert.ok(BigInt(q.amountOut) > 0n);
});

test("a dry NEAR quote says so to the provider", async () => {
  const seen = capture({ relay: new Error("relay out"), near: { quote: { amountIn: AMOUNT, amountOut: "100", minAmountOut: "100", amountOutUsd: "1", timeEstimate: 9 }, quoteRequest: { recipient: SOL } } });
  const b = createBridges({ chainId: 4663 });
  const q = await b.quote({ route: "sol", token: "SOL", amount: AMOUNT, recipient: SOL, refundTo: EVM, dry: true });
  assert.equal(seen.near.dry, true);
  assert.equal(q.depositAddress, null);
});

test("a NEAR quote carries its deadline, and a Relay one says it has none", async () => {
  capture({ relay: new Error("relay out"), near: { quote: { depositAddress: DEPOSIT, amountIn: AMOUNT, amountOut: "100", minAmountOut: "100", amountOutUsd: "1", timeEstimate: 9, deadline: "2026-10-21T12:00:00.000Z" }, quoteRequest: { recipient: SOL } } });
  const near = await createBridges({ chainId: 4663 }).quote({ route: "sol", token: "SOL", amount: AMOUNT, recipient: SOL, refundTo: EVM });
  assert.equal(near.expiresAt, "2026-10-21T12:00:00.000Z");
  capture({ relay: relayBody(), near: new Error("near out") });
  const relay = await createBridges({ chainId: 4663 }).quote({ route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM });
  assert.equal(relay.expiresAt, null);
});

test("a real quote still has to come back with somewhere to send the money", async () => {
  const seen = capture({ relay: relayBody(), near: new Error("near out") });
  const b = createBridges({ chainId: 4663 });
  const q = await b.quote({ route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM });
  assert.equal(seen.relay.useDepositAddress, true);
  assert.equal(seen.relay.strict, true);
  assert.equal(q.depositAddress, DEPOSIT);
});

// A pasted token address. The lists we ship are what we know fills; they are not the whole of
// what the providers route, and someone holding a token we never listed should not be told no by
// a dropdown. The address is looked up with both providers and quoted as itself, or refused in
// words that say which part failed.
const CURRENCIES = (over = {}) => [{ chainId: 4663, address: "0x39dbed3a2bd333467115de45665cc57f813c4571", symbol: "PONS", name: "PONS", decimals: 18, metadata: { verified: true }, ...over }];

test("a pasted address is looked up and quoted as that token", async () => {
  const seen = {};
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("currencies")) return reply(CURRENCIES());
    if (u.includes("quote/v2")) {
      seen.relay = JSON.parse(init.body);
      return reply(relayBody());
    }
    throw new Error("near out");
  };
  const q = await createBridges({ chainId: 4663 }).quote({
    route: "hood",
    token: "0x39dbed3a2bd333467115de45665cc57f813c4571",
    amount: AMOUNT,
    recipient: EVM,
    refundTo: EVM,
  });
  assert.equal(seen.relay.destinationCurrency, "0x39dbed3a2bd333467115de45665cc57f813c4571");
  assert.equal(q.token, "PONS");
  assert.equal(q.pasted, true);
});

test("an address no provider routes is refused, saying so", async () => {
  globalThis.fetch = async (url) => (String(url).includes("currencies") ? reply([]) : reply({ tokens: [] }));
  await assert.rejects(
    createBridges({ chainId: 4663 }).quote({ route: "hood", token: "0x1111111111111111111111111111111111111111", amount: AMOUNT, recipient: EVM, refundTo: EVM }),
    /neither Relay nor NEAR/i,
  );
});

test("an address that is not an address for that chain never reaches a provider", async () => {
  globalThis.fetch = async () => {
    throw new Error("a provider was called");
  };
  await assert.rejects(
    createBridges({ chainId: 4663 }).quote({ route: "sol", token: "0x39dbed3a2bd333467115de45665cc57f813c4571", amount: AMOUNT, recipient: SOL, refundTo: EVM }),
    /not a Solana token address/i,
  );
});

test("without a Relay key the swap goes to NEAR, rather than quoting what cannot be paid", async () => {
  delete process.env.RELAY_API_KEY;
  const seen = capture({ relay: relayBody(), near: nearBody(AMOUNT, SOL, "100") });
  const q = await createBridges({ chainId: 4663 }).quote({ route: "sol", token: "SOL", amount: AMOUNT, recipient: SOL, refundTo: EVM });
  assert.equal(q.provider, "near");
  assert.equal(seen.relay, undefined, "Relay was not asked for a quote it could not honour");
  assert.ok(q.depositAddress);
});

test("a price is still worth asking Relay for without a key: that is what the probe does", async () => {
  delete process.env.RELAY_API_KEY;
  const seen = capture({ relay: relayBody(), near: new Error("near out") });
  const q = await createBridges({ chainId: 4663 }).quote({ route: "base", token: "ETH", amount: AMOUNT, recipient: EVM, refundTo: EVM, dry: true });
  assert.equal(q.provider, "relay");
  assert.ok(seen.relay);
  assert.equal(q.depositAddress, null);
});

test("a swap that started on Solana can be asked about, not only an EVM one", async () => {
  globalThis.fetch = async (url) => {
    assert.ok(String(url).includes(encodeURIComponent(SOL)) || String(url).includes(SOL));
    return reply({ status: "PROCESSING", swapDetails: {} });
  };
  const st = await createBridges({ chainId: 4663 }).status({ provider: "near", id: SOL });
  assert.equal(st.state, "processing");
});

test("a deposit address that is no address at all is still refused", async () => {
  globalThis.fetch = async () => {
    throw new Error("should not be asked");
  };
  await assert.rejects(createBridges({ chainId: 4663 }).status({ provider: "near", id: "../../etc/passwd" }), /bad id/);
});

// An asset id names the chain it lives on. Matching a pasted address against NEAR's list without
// reading that chain accepted a token's Ethereum address as a Base one: the deposit address that
// came back was for Ethereum, under an instruction to send on Base.
test("a pasted address is only matched against assets of that chain", async () => {
  const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  globalThis.fetch = async (url) => {
    if (String(url).includes("currencies")) return reply([]); // Relay knows nothing on Base
    return reply([
      { assetId: `nep141:eth-${USDC_ETH}.omft.near`, symbol: "USDC", decimals: 6, blockchain: "eth", contractAddress: USDC_ETH },
    ]);
  };
  await assert.rejects(
    createBridges({ chainId: 4663 }).quote({ route: "base", token: USDC_ETH, amount: AMOUNT, recipient: EVM, refundTo: EVM }),
    /neither Relay nor NEAR/i,
  );
});

test("the same address on the chain it belongs to is accepted", async () => {
  const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const seen = {};
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("currencies")) return reply([]);
    if (String(url).includes("/v0/tokens"))
      return reply([{ assetId: `nep141:base-${USDC_BASE}.omft.near`, symbol: "USDC", decimals: 6, blockchain: "base", contractAddress: USDC_BASE }]);
    seen.near = JSON.parse(init.body);
    return reply(nearBody(AMOUNT, EVM, "900"));
  };
  const q = await createBridges({ chainId: 4663 }).quote({ route: "base", token: USDC_BASE, amount: AMOUNT, recipient: EVM, refundTo: EVM });
  assert.equal(seen.near.destinationAsset, `nep141:base-${USDC_BASE}.omft.near`);
  assert.equal(q.token, "USDC");
});
