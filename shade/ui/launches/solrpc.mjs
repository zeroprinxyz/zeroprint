// One Solana RPC client for every Footprint scanner, with caches: the bundle scan, the creator
// scan and the neighbour lookup read many of the same transactions, and each read costs
// Alchemy compute units. Transactions never change, so they are cached for good (bounded);
// signature lists for 10 minutes.
const TX_MAX = 50_000;
const SIG_TTL = 10 * 60_000;
const BATCH = 40;

export function createSolRpc(url) {
  const txs = new Map(); // signature -> parsed transaction (null if not found)
  const sigs = new Map(); // `${addr}:${limit}` -> { at, value }
  const stats = { txFetched: 0, txCached: 0, sigFetched: 0, sigCached: 0 };

  async function post(body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`solana rpc ${r.status}`);
    return r.json();
  }

  async function call(method, params) {
    return (await post({ jsonrpc: "2.0", id: 1, method, params })).result;
  }

  /** Newest-first signatures of successful transactions, cached 10 min. */
  async function signatures(addr, limit) {
    const key = `${addr}:${limit}`;
    const hit = sigs.get(key);
    if (hit && Date.now() - hit.at < SIG_TTL) {
      stats.sigCached++;
      return hit.value;
    }
    stats.sigFetched++;
    const value = ((await call("getSignaturesForAddress", [addr, { limit: Math.min(1000, limit) }])) ?? []).filter((s) => !s.err);
    sigs.set(key, { at: Date.now(), value });
    return value;
  }

  /** Parsed transactions for these signatures, in order; only the ones not seen before are fetched. */
  async function transactions(list) {
    const missing = [...new Set(list.filter((s) => !txs.has(s)))];
    stats.txCached += list.length - missing.length;
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const res = await post(
        chunk.map((sig, k) => ({ jsonrpc: "2.0", id: k, method: "getTransaction", params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }] })),
      );
      stats.txFetched += chunk.length;
      for (const r of Array.isArray(res) ? res : []) txs.set(chunk[r.id], r.result ?? null);
    }
    if (txs.size > TX_MAX) for (const k of [...txs.keys()].slice(0, txs.size - TX_MAX)) txs.delete(k);
    return list.map((s) => txs.get(s) ?? null);
  }

  return { call, signatures, transactions, stats };
}
