// Withdraw to another chain: quotes from Relay and NEAR Intents (1Click), both with a one-time
// deposit address on Robinhood Chain that the hop wallet pays with a plain transfer. The server
// only proxies: visitors' IPs never reach the bridge companies, and nothing here is logged.
import { VALIDATE } from "./addr.mjs";

const RELAY = "https://api.relay.link";
// Relay prices anything without a key, but refuses to reserve a deposit address without one
// ("this request is missing an api key"). With no key the swap it quoted cannot be paid, so it is
// asked for prices only and NEAR Intents is left to deliver.
const relayKey = () => process.env.RELAY_API_KEY || null;
const NEAR = "https://1click.chaindefuser.com";
const NATIVE = "0x0000000000000000000000000000000000000000";

// What a withdrawal can be received as. Each token carries the id each bridge needs: `relay` is
// the currency address on that chain, `near` the 1Click asset id. A token with only one of the two
// is simply quoted by that bridge alone.
const TOKENS = {
  sol: [
    { symbol: "SOL", name: "Solana", decimals: 9, relay: "11111111111111111111111111111111", near: "nep141:sol.omft.near" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, relay: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", near: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near" },
    { symbol: "USDT", name: "USDT", decimals: 6, relay: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", near: "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near" },
    { symbol: "PYUSD", name: "PayPal USD", decimals: 6, relay: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" },
    { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, relay: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij" },
    { symbol: "BONK", name: "Bonk", decimals: 5, relay: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
    { symbol: "JUP", name: "Jupiter", decimals: 6, relay: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
    { symbol: "RAY", name: "Raydium", decimals: 6, relay: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
    { symbol: "TRUMP", name: "OFFICIAL TRUMP", decimals: 6, relay: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", near: "nep141:sol-c58e6539c2f2e097c251f8edf11f9c03e581f8d4.omft.near" },
    { symbol: "PENGU", name: "Pudgy Penguins", decimals: 6, relay: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", near: "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near" },
    { symbol: "WIF", name: "$WIF", decimals: 6, near: "nep141:sol-b9c68f94ec8fd160137af8cdfe5e61cd68e2afba.omft.near" },
    { symbol: "USDe", name: "USDe", decimals: 9, relay: "DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT" },
  ],
  base: [
    { symbol: "ETH", name: "Ether", decimals: 18, relay: "0x0000000000000000000000000000000000000000", near: "nep141:base.omft.near" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, relay: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", near: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" },
    { symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, relay: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", near: "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near" },
  ],
  arb: [
    { symbol: "ETH", name: "Ether", decimals: 18, relay: "0x0000000000000000000000000000000000000000", near: "nep141:arb.omft.near" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, relay: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", near: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near" },
    { symbol: "USDT", name: "Tether USD", decimals: 6, relay: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
  ],
  eth: [
    { symbol: "ETH", name: "Ether", decimals: 18, relay: "0x0000000000000000000000000000000000000000", near: "nep141:eth.omft.near" },
    { symbol: "USDC", name: "USD Coin", decimals: 6, relay: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", near: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" },
    { symbol: "USDT", name: "Tether USD", decimals: 6, relay: "0xdac17f958d2ee523a2206206994597c13d831ec7", near: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near" },
    { symbol: "USDe", name: "USDe", decimals: 18, relay: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3" },
  ],
  bsc: [
    { symbol: "BNB", name: "Binance Coin", decimals: 18, relay: "0x0000000000000000000000000000000000000000", near: "nep245:v2_1.omni.hot.tg:56_11111111111111111111" },
    { symbol: "USDC", name: "USDCoin", decimals: 18, relay: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", near: "nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r" },
    { symbol: "USDT", name: "Tether USD", decimals: 18, relay: "0x55d398326f99059ff775485246999027b3197955", near: "nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g" },
  ],
  hood: [
    { symbol: "ETH", name: "Ether", decimals: 18, relay: "0x0000000000000000000000000000000000000000", near: "nep141:hood.omft.near" },
    { symbol: "USDG", name: "Global Dollar", decimals: 6, relay: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", near: "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near" },
    { symbol: "PONS", name: "PONS", decimals: 18, near: "nep141:hood-0x39dbed3a2bd333467115de45665cc57f813c4571.omft.near" },
    { symbol: "CASHCAT", name: "CASHCAT", decimals: 18, near: "nep141:hood-0x020bfc650a365f8bb26819deaabf3e21291018b4.omft.near" },
    { symbol: "APE", name: "ApeCoin", decimals: 18, relay: "0x8f86a15ec17cb3369d8b3e666dadbc11daa82b79" },
  ],  btc: [{ symbol: "BTC", name: "Bitcoin", decimals: 8, near: "nep141:btc.omft.near" }],
  zec: [{ symbol: "ZEC", name: "Zcash", decimals: 8, near: "nep141:zec.omft.near" }],
};

// Destinations from Robinhood Chain mainnet (4663). kind = recipient address format.
// "hood" is the same chain: a swap rather than a bridge, and ETH there needs no bridge at all.
export const ROUTES = [
  { id: "hood", name: "Robinhood Chain", kind: "evm", chainId: 4663, tokens: TOKENS.hood },
  { id: "sol", name: "Solana", kind: "solana", chainId: 792703809, tokens: TOKENS.sol },
  { id: "base", name: "Base", kind: "evm", chainId: 8453, tokens: TOKENS.base },
  { id: "arb", name: "Arbitrum", kind: "evm", chainId: 42161, tokens: TOKENS.arb },
  { id: "eth", name: "Ethereum", kind: "evm", chainId: 1, tokens: TOKENS.eth },
  { id: "bsc", name: "BNB Chain", kind: "evm", chainId: 56, tokens: TOKENS.bsc },
  { id: "btc", name: "Bitcoin", kind: "btc", tokens: TOKENS.btc },
  { id: "zec", name: "Zcash", kind: "zec", tokens: TOKENS.zec },
];

// Checksums are verified, not just the shape: see addr.mjs.
const RECIPIENT = { evm: { test: VALIDATE.evm }, solana: { test: VALIDATE.solana }, btc: { test: VALIDATE.btc }, zec: { test: VALIDATE.zec } };

async function call(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `HTTP ${r.status}`);
  return j;
}
const post = (url, body, headers = {}) => call(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function relayQuote(origin, originToken, route, token, amount, recipient, refundTo, dry) {
  if (!dry && !relayKey()) throw new Error("Relay needs an API key to reserve a deposit address");
  const j = await post(
    `${RELAY}/quote/v2`,
    {
      user: refundTo,
      originChainId: origin.chainId,
      destinationChainId: route.chainId,
      originCurrency: originToken.relay,
      destinationCurrency: token.relay,
      amount,
      tradeType: "EXACT_INPUT",
      recipient,
    // strict only holds a deposit-address quote to its word; asking for a price with it set is
    // refused outright, and a dry quote has no deposit address to be strict about.
      ...(dry ? {} : { useDepositAddress: true, strict: true }),
      refundTo,
    },
    relayKey() ? { "x-api-key": relayKey() } : {},
  );
  const step = j.steps?.[0];
  const item = step?.items?.[0]?.data;
  if (!dry && !step?.depositAddress) throw new Error("unexpected Relay quote");
  // Sending the chain's own coin from an EVM chain is a plain transfer, and we check it is exactly
  // that. A token, or a chain whose transactions we cannot read here, is sent by the person
  // themselves to the address the provider named, and that address is all we can check.
  const plain = !dry && origin.kind === "evm" && originToken.relay === NATIVE;
  if (plain && (!item || item.chainId !== origin.chainId || BigInt(item.value) !== BigInt(amount) || item.to.toLowerCase() !== step.depositAddress.toLowerCase() || (item.data && item.data !== "0x")))
    throw new Error("unexpected Relay quote");
  const out = j.details?.currencyOut;
  return {
    provider: "relay",
    id: step?.requestId ?? null,
    depositAddress: dry ? null : step.depositAddress,
    amountIn: amount,
    amountOut: out.amount,
    minOut: out.minimumAmount,
    usdOut: out.amountUsd,
    eta: j.details?.timeEstimate ?? null,
    expiresAt: null, // Relay does not say; the page then shows no countdown rather than inventing one
  };
}

async function nearQuote(origin, originToken, route, token, amount, recipient, refundTo, dry) {
  const j = await post(`${NEAR}/v0/quote`, {
    dry: !!dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: originToken.near,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: token.near,
    amount,
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
  const q = j.quote;
  if ((!dry && !q?.depositAddress) || BigInt(q?.amountIn ?? 0) !== BigInt(amount) || j.quoteRequest?.recipient !== recipient) throw new Error("unexpected NEAR quote");
  return {
    provider: "near",
    id: dry ? null : q.depositAddress,
    depositAddress: dry ? null : q.depositAddress,
    amountIn: amount,
    amountOut: q.amountOut,
    minOut: q.minAmountOut,
    usdOut: q.amountOutUsd,
    eta: q.timeEstimate ?? null,
    expiresAt: q.deadline ?? null,
  };
}

// Test networks have no bridges. With BRIDGE_TEST=1 they get an "echo" route whose deposit
// address is the recipient itself on the same chain, which exercises the whole hop flow.
// Test networks have no bridges, so "echo" stands in for one: it pays the recipient directly on
// the same chain. The second entry exists only so the token picker has something to pick.
const ECHO = {
  id: "echo",
  name: "Echo (test: same chain)",
  kind: "evm",
  tokens: [
    { symbol: "ETH", name: "Ether", decimals: 18 },
    { symbol: "tETH", name: "Echo test token", decimals: 18 },
  ],
};


// A token we never listed. The lists above are what the probe found fills, not the whole of what
// the providers route, so an address can be asked about directly: Relay searches its own
// currencies, NEAR publishes its asset ids. Whatever comes back is used exactly like a listed
// token, and the quote still has to fill for the swap to be offered.
const pastedCache = new Map(); // "chain:address" -> { at, token }
const PASTED_TTL = 10 * 60_000;

const looksLikeAddress = (kind, v) =>
  kind === "evm" ? /^0x[0-9a-fA-F]{40}$/.test(v ?? "") : kind === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v ?? "") : false;

// Enough to tell "someone pasted an address" from "someone named a token we do not carry", so
// each gets the answer that helps: which chain the address is wrong for, or that the symbol is
// not on the list.
const looksPasted = (v) => looksLikeAddress("evm", v) || looksLikeAddress("solana", v);

// An asset id carries the chain it lives on ("nep141:base-0x….omft.near"). A token can exist at
// the same address on several chains, so the chain has to match too: accepting an Ethereum asset
// for a Base origin would hand back a deposit address on Ethereum under an instruction to send
// on Base, and that is not recoverable.
const NEAR_CHAIN = { hood: "hood", sol: "sol", base: "base", arb: "arb", eth: "eth", bsc: "bsc", btc: "btc", zec: "zec" };

async function nearAssetFor(route, address) {
  const prefix = NEAR_CHAIN[route.id];
  if (!prefix) return null;
  const j = await call(`${NEAR}/v0/tokens`).catch(() => null);
  const rows = Array.isArray(j) ? j : (j?.tokens ?? []);
  const wanted = address.toLowerCase();
  const onThisChain = (t) => {
    const id = String(t.assetId ?? "").toLowerCase();
    return id.includes(`:${prefix}-`) || id.endsWith(`:${prefix}.omft.near`) || String(t.blockchain ?? "").toLowerCase() === prefix;
  };
  const hit = rows.find((t) => onThisChain(t) && (String(t.contractAddress ?? "").toLowerCase() === wanted || String(t.assetId ?? "").toLowerCase().includes(wanted)));
  return hit?.assetId ? { near: hit.assetId, symbol: hit.symbol, decimals: hit.decimals } : null;
}

async function relayCurrencyFor(route, address) {
  const rows = await post(`${RELAY}/currencies/v2`, { chainIds: [route.chainId], term: address, limit: 5 }).catch(() => []);
  const hit = (Array.isArray(rows) ? rows : []).find((c) => String(c.address ?? "").toLowerCase() === address.toLowerCase());
  return hit ? { relay: hit.address, symbol: hit.symbol, name: hit.name, decimals: hit.decimals } : null;
}

/** The token at `address` on `route`, as the token list would have described it. */
async function pastedToken(route, address) {
  const key = `${route.id}:${address.toLowerCase()}`;
  const hit = pastedCache.get(key);
  if (hit && Date.now() - hit.at < PASTED_TTL) return hit.token;
  if (!looksLikeAddress(route.kind, address)) throw new Error(`that is not a ${route.name} token address`);
  const [relay, near] = await Promise.all([route.chainId ? relayCurrencyFor(route, address) : null, nearAssetFor(route, address)]);
  if (!relay && !near) throw new Error(`neither Relay nor NEAR Intents routes that token on ${route.name}`);
  const token = {
    symbol: relay?.symbol ?? near?.symbol ?? "token",
    name: relay?.name ?? near?.symbol ?? address,
    decimals: relay?.decimals ?? near?.decimals ?? 18,
    relay: relay?.relay,
    near: near?.near,
    pasted: true,
  };
  pastedCache.set(key, { at: Date.now(), token });
  return token;
}

// Where a withdrawal starts, and so what `quote` assumes when a swap does not say otherwise.
const HOME = { id: "hood", token: "ETH" };

// Where a swap can start. A bridge works both ways, so this is the same list read from the other
// end: an origin asset carries the same provider ids a destination asset carries.
export const ORIGINS = ROUTES;

// The chain this site runs on, as an origin. A withdrawal starts here, and on a test network —
// where the real bridges serve nothing — it is the only origin there is.
const homeOrigin = (chainId) => ({
  id: "hood",
  name: "This chain",
  kind: "evm",
  chainId,
  tokens: [{ symbol: "ETH", name: "Ether", decimals: 18, relay: NATIVE, near: "nep141:hood.omft.near" }],
});

export function createBridges({ chainId, test = false }) {
  const enabled = chainId === 4663 || test; // the real bridges only serve Robinhood Chain mainnet
  const routes = chainId === 4663 ? ROUTES : test ? [ECHO] : [];
  const origins = chainId === 4663 ? ORIGINS : test ? [homeOrigin(chainId)] : [];

  // `dry` asks only what the price would be. A probe runs over every pair there is, and a real
  // quote would have each provider set aside a deposit address for every one of them.
  async function quote({ origin: originId = HOME.id, originToken: originSym = HOME.token, route: id, token: sym, amount, recipient, refundTo, dry = false }) {
    const route = routes.find((r) => r.id === id);
    if (!route) throw new Error("unknown destination");
    const token = route.tokens.find((t) => t.symbol === (sym ?? route.tokens[0].symbol)) ?? (looksPasted(sym) ? await pastedToken(route, sym) : null);
    if (!token) throw new Error(`${sym} is not available on ${route.name}`);
    const origin = origins.find((o) => o.id === originId);
    if (!origin) throw new Error(`${originId} is not an origin we can swap from`);
    const originToken = origin.tokens.find((t) => t.symbol === originSym) ?? (looksPasted(originSym) ? await pastedToken(origin, originSym) : null);
    if (!originToken) throw new Error(`${originSym} is not an origin asset on ${origin.name}`);
    if (!/^\d{1,30}$/.test(String(amount)) || BigInt(amount) <= 0n) throw new Error("bad amount");
    if (!RECIPIENT[route.kind].test(recipient ?? "")) throw new Error(`not a valid ${route.name} address`);
    if (!RECIPIENT[origin.kind].test(refundTo ?? "")) throw new Error(`the refund address must be a valid ${origin.name} address`);
    if (route === ECHO)
      return { provider: "echo", id: recipient, depositAddress: recipient, amountIn: String(amount), amountOut: String(amount), minOut: String(amount), eta: 0, route: id, token: token.symbol, symbol: token.symbol, decimals: 18, others: [] };
    const tries = [
      token.relay && originToken.relay && origin.chainId && relayQuote(origin, originToken, route, token, String(amount), recipient, refundTo, dry),
      token.near && originToken.near && nearQuote(origin, originToken, route, token, String(amount), recipient, refundTo, dry),
    ].filter(Boolean);
    if (!tries.length) throw new Error(`no provider swaps ${originToken.symbol} on ${origin.name} to ${token.symbol} on ${route.name}`);
    const got = await Promise.allSettled(tries);
    const ok = got.filter((g) => g.status === "fulfilled").map((g) => g.value);
    if (!ok.length) throw new Error(got.map((g) => g.reason?.message).filter(Boolean).join(" · ") || "no quote");
    ok.sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1));
    return {
      ...ok[0],
      route: id,
      token: token.symbol,
      symbol: token.symbol,
      decimals: token.decimals,
      origin: origin.id,
      originToken: originToken.symbol,
      ...(token.pasted || originToken.pasted ? { pasted: true } : {}),
      originKind: origin.kind,
      originDecimals: originToken.decimals,
      others: ok.slice(1).map((o) => ({ provider: o.provider, amountOut: o.amountOut })),
    };
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
      // The deposit address is on whichever chain the money starts from, so it is a Solana or a
      // Bitcoin address as often as an EVM one. Checking only for EVM meant a swap that began
      // anywhere else could never be asked about: the page said "waiting" for ever.
      if (!Object.values(RECIPIENT).some((k) => k.test(id ?? ""))) throw new Error("bad id");
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

  const offer = (list) =>
    list.map((r) => ({
      ...r,
      tokens: (r.tokens ?? []).map((t) => ({ symbol: t.symbol, name: t.name, decimals: t.decimals, providers: [t.relay && "relay", t.near && "near"].filter(Boolean) })),
    }));

  return {
    enabled,
    routes: () => offer(routes),
    origins: () => offer(origins),
    quote,
    lookup: (routeId, address) => {
      const route = [...routes, ...origins].find((r) => r.id === routeId);
      if (!route) throw new Error("unknown chain");
      return pastedToken(route, address);
    },
    submit,
    status,
    reach,
  };
}
