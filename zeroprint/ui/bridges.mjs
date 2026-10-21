// Withdraw to another chain: quotes from Relay and NEAR Intents (1Click), both with a one-time
// deposit address on Robinhood Chain that the hop wallet pays with a plain transfer. The server
// only proxies: visitors' IPs never reach the bridge companies, and nothing here is logged.
const RELAY = "https://api.relay.link";
const NEAR = "https://1click.chaindefuser.com";
const NATIVE = "0x0000000000000000000000000000000000000000";

// Destinations from Robinhood Chain mainnet (4663). kind = recipient address format.
export const ROUTES = [
  { id: "sol", name: "Solana", symbol: "SOL", decimals: 9, kind: "solana", relay: { chainId: 792703809, currency: "11111111111111111111111111111111" }, near: "nep141:sol.omft.near" },
  { id: "base", name: "Base", symbol: "ETH", decimals: 18, kind: "evm", relay: { chainId: 8453, currency: NATIVE }, near: "nep141:base.omft.near" },
  { id: "arb", name: "Arbitrum", symbol: "ETH", decimals: 18, kind: "evm", relay: { chainId: 42161, currency: NATIVE }, near: "nep141:arb.omft.near" },
  { id: "eth", name: "Ethereum", symbol: "ETH", decimals: 18, kind: "evm", relay: { chainId: 1, currency: NATIVE }, near: "nep141:eth.omft.near" },
  { id: "bsc", name: "BNB Chain", symbol: "BNB", decimals: 18, kind: "evm", relay: { chainId: 56, currency: NATIVE }, near: "nep245:v2_1.omni.hot.tg:56_11111111111111111111" },
  { id: "btc", name: "Bitcoin", symbol: "BTC", decimals: 8, kind: "btc", near: "nep141:btc.omft.near" },
  { id: "zec", name: "Zcash", symbol: "ZEC", decimals: 8, kind: "zec", near: "nep141:zec.omft.near" },
];

const RECIPIENT = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  zec: /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/,
};

async function call(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
  return j;
}
const post = (url, body) => call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function relayQuote(route, amount, recipient, refundTo, chainId) {
  const j = await post(`${RELAY}/quote/v2`, {
    user: refundTo,
    originChainId: chainId,
    destinationChainId: route.relay.chainId,
    originCurrency: NATIVE,
    destinationCurrency: route.relay.currency,
    amount,
    tradeType: "EXACT_INPUT",
    recipient,
    useDepositAddress: true,
    refundTo,
    strict: true,
  });
  const step = j.steps?.[0];
  const item = step?.items?.[0]?.data;
  // the deposit must be exactly a plain transfer of `amount` on our chain
  if (!step?.depositAddress || !item || item.chainId !== chainId || BigInt(item.value) !== BigInt(amount) || item.to.toLowerCase() !== step.depositAddress.toLowerCase() || (item.data && item.data !== "0x"))
    throw new Error("unexpected Relay quote");
  const out = j.details?.currencyOut;
  return {
    provider: "relay",
    id: step.requestId,
    depositAddress: step.depositAddress,
    amountIn: amount,
    amountOut: out.amount,
    minOut: out.minimumAmount,
    usdOut: out.amountUsd,
    eta: j.details?.timeEstimate ?? null,
  };
}

async function nearQuote(route, amount, recipient, refundTo) {
  const j = await post(`${NEAR}/v0/quote`, {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: "nep141:hood.omft.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: route.near,
    amount,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
  const q = j.quote;
  if (!q?.depositAddress || BigInt(q.amountIn) !== BigInt(amount) || j.quoteRequest?.recipient !== recipient) throw new Error("unexpected NEAR quote");
  return {
    provider: "near",
    id: q.depositAddress,
    depositAddress: q.depositAddress,
    amountIn: amount,
    amountOut: q.amountOut,
    minOut: q.minAmountOut,
    usdOut: q.amountOutUsd,
    eta: q.timeEstimate ?? null,
  };
}

// Test networks have no bridges. With BRIDGE_TEST=1 they get an "echo" route whose deposit
// address is the recipient itself on the same chain, which exercises the whole hop flow.
const ECHO = { id: "echo", name: "Echo (test: same chain)", symbol: "ETH", decimals: 18, kind: "evm" };

export function createBridges({ chainId, test = false }) {
  const enabled = chainId === 4663 || test; // the real bridges only serve Robinhood Chain mainnet
  const routes = chainId === 4663 ? ROUTES : test ? [ECHO] : [];

  async function quote({ route: id, amount, recipient, refundTo }) {
    const route = routes.find((r) => r.id === id);
    if (!route) throw new Error("unknown destination");
    if (!/^\d{1,30}$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error("bad amount");
    if (!RECIPIENT[route.kind].test(recipient ?? "")) throw new Error(`not a valid ${route.name} address`);
    if (!RECIPIENT.evm.test(refundTo ?? "")) throw new Error("bad refund address");
    if (route === ECHO)
      return { provider: "echo", id: recipient, depositAddress: recipient, amountIn: String(amount), amountOut: String(amount), minOut: String(amount), eta: 0, route: id, symbol: "ETH", decimals: 18, others: [] };
    const tries = [route.relay && relayQuote(route, String(amount), recipient, refundTo, chainId), route.near && nearQuote(route, String(amount), recipient, refundTo)].filter(Boolean);
    const got = await Promise.allSettled(tries);
    const ok = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
    if (!ok.length) throw new Error(got.map((g) => g.reason?.message).filter(Boolean).join(" · ") || "no quote");
    ok.sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1));
    return { ...ok[0], route: id, symbol: route.symbol, decimals: route.decimals, others: ok.slice(1).map((o) => ({ provider: o.provider, amountOut: o.amountOut })) };
  }

  // tells NEAR which transaction paid, so it doesn't wait for its own indexer
  async function submit({ provider, depositAddress, txHash }) {
    if (provider !== "near") return { ok: true };
    if (!RECIPIENT.evm.test(depositAddress ?? "") || !/^0x[0-9a-f]{64}$/i.test(txHash ?? "")) throw new Error("bad submit");
    await post(`${NEAR}/v0/deposit/submit`, { txHash, depositAddress });
    return { ok: true };
  }

  /** Normalized: waiting | processing | done | refunded | failed, plus the destination tx. */
  async function status({ provider, id }) {
    if (provider === "echo" && test) return { state: "done", raw: "echo", destTx: null };
    if (provider === "relay") {
      if (!/^0x[0-9a-f]{64}$/i.test(id ?? "")) throw new Error("bad id");
      const j = await call(`${RELAY}/intents/status/v3?requestId=${id}`);
      const map = { waiting: "waiting", pending: "processing", submitted: "processing", success: "done", refund: "refunded", refunded: "refunded", failure: "failed", failed: "failed" };
      return { state: map[j.status] ?? "processing", raw: j.status, destTx: j.txHashes?.[0] ?? null };
    }
    if (provider === "near") {
      if (!RECIPIENT.evm.test(id ?? "")) throw new Error("bad id");
      const j = await call(`${NEAR}/v0/status?depositAddress=${id}`);
      const map = { PENDING_DEPOSIT: "waiting", KNOWN_DEPOSIT_TX: "processing", PROCESSING: "processing", SUCCESS: "done", INCOMPLETE_DEPOSIT: "failed", REFUNDED: "refunded", FAILED: "failed" };
      const dt = j.swapDetails?.destinationChainTxHashes?.[0];
      return { state: map[j.status] ?? "processing", raw: j.status, destTx: dt?.hash ?? null, destTxUrl: dt?.explorerUrl ?? null };
    }
    throw new Error("unknown provider");
  }

  // reachability for the status page, cached 5 min
  let health = { at: 0, value: null };
  async function reach() {
    if (Date.now() - health.at < 300_000 && health.value) return health.value;
    const probe = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
    const [relay, near] = await Promise.all([probe(`${RELAY}/chains`), probe(`${NEAR}/v0/tokens`)]);
    health = { at: Date.now(), value: { relay, near } };
    return health.value;
  }

  return { enabled, routes: () => routes.map(({ relay, near, ...r }) => ({ ...r, providers: [relay && "relay", near && "near"].filter(Boolean) })), quote, submit, status, reach };
}
