// Peak market cap of a Solana or Ethereum token from GeckoTerminal's public API (no key): the
// highest daily candle across the token's top pools, times its supply. Approximate: daily
// candles, today's supply, and GeckoTerminal's history can start after launch. Robinhood peaks
// come from the launch index instead. Calls are spaced well under the free rate limit.
const GT = "https://api.geckoterminal.com/api/v2";
const NET = { solana: "solana", ethereum: "eth" };
const GAP = 6000; // ms between calls (10/min)
const POOLS = 3;
const MIN_DAY_VOLUME = 100; // USD; quieter candles are ignored (one-trade wicks)
const TTL = 12 * 3600_000;
const ERR_TTL = 10 * 60_000;

export function createPeakFinder() {
  const cache = new Map(); // `${chain}:${token}` -> { at, ttl, value, promise }
  let next = 0;

  async function gt(path, tries = 3) {
    const wait = Math.max(0, next - Date.now());
    next = Math.max(next, Date.now()) + GAP;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const r = await fetch(GT + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 429 && tries > 1) {
      next = Math.max(next, Date.now() + 30_000);
      return gt(path, tries - 1);
    }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`geckoterminal ${r.status}`);
    return r.json();
  }

  async function compute(net, token) {
    const pools = (await gt(`/networks/${net}/tokens/${token}/pools?page=1`))?.data?.slice(0, POOLS) ?? [];
    if (!pools.length) return null;
    // supply = FDV / price, from a pool where this token is the base token
    const id = `${net}_${token}`.toLowerCase();
    const asBase = pools.find((p) => p.relationships?.base_token?.data?.id?.toLowerCase() === id);
    let supply = asBase ? Number(asBase.attributes.fdv_usd) / Number(asBase.attributes.base_token_price_usd) : 0;
    if (!(supply > 0)) supply = Number((await gt(`/networks/${net}/tokens/${token}`))?.data?.attributes?.normalized_total_supply);
    if (!(supply > 0)) return null;
    let best = null;
    let since = null;
    for (const p of pools) {
      const candles = (await gt(`/networks/${net}/pools/${p.attributes.address}/ohlcv/day?limit=1000&currency=usd&token=${token}`))?.data?.attributes?.ohlcv_list ?? [];
      for (const [ts, , high, , , volume] of candles) {
        if (since == null || ts < since) since = ts;
        if (volume >= MIN_DAY_VOLUME && (!best || high > best.high)) best = { high, ts };
      }
    }
    return best && { peakUsd: best.high * supply, at: best.ts, since };
  }

  /** { peakUsd, at, since } or null; resolves when GeckoTerminal has answered. */
  return function peak(chain, token) {
    const net = NET[chain];
    if (!net) return Promise.resolve(null);
    const key = `${chain}:${token}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
    const entry = { at: Date.now(), ttl: TTL };
    entry.promise = compute(net, token).catch(() => {
      entry.ttl = ERR_TTL;
      return null;
    });
    cache.set(key, entry);
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return entry.promise;
  };
}
