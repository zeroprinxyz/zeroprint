// Bundle pattern on Solana: when two or more wallets around a hub (the hub itself and the
// wallets it sent to or got money from) traded the same pump.fun token, that token and its
// creator are linked to the hub. This is how a dev's bundle wallets, which never launch
// anything themselves, still point at the launch and its deployer.
import { PUMP, bs58, disc, programData } from "./sol.mjs";
import { createSolRpc } from "./solrpc.mjs";

const D_TRADE = disc("TradeEvent");
const D_CREATE = disc("CreateEvent");
const SIGS_PER_WALLET = 30;
// A bundle buys at launch: at least two linked wallets buying within this many seconds of it.
// Later co-buying is just trading and is not reported.
const BUNDLE_SECONDS = 60;
const HUB_SIGS = 300;
const MAX_WALLETS = 24;
const SYSTEM = "11111111111111111111111111111111";

/** @param sol a shared client from createSolRpc(), or an RPC URL */
export function createBundleScanner(sol) {
  const solRpc = typeof sol === "string" ? createSolRpc(sol) : sol;
  const one = (method, params) => solRpc.call(method, params);
  const txs = (sigs) => solRpc.transactions(sigs).then((l) => l.filter(Boolean));

  /** The token's creation: its oldest transaction carries the CreateEvent. */
  async function creation(mint) {
    let before;
    let oldest;
    for (let i = 0; i < 4; i++) {
      const s = await one("getSignaturesForAddress", [mint, { limit: 1000, before }]);
      if (!s?.length) break;
      oldest = s[s.length - 1].signature;
      before = oldest;
      if (s.length < 1000) break;
    }
    if (!oldest) return null;
    const [tx] = await solRpc.transactions([oldest]);
    for (const [prog, b64] of programData(tx?.meta?.logMessages)) {
      const b = Buffer.from(b64, "base64");
      if (prog !== PUMP || b.subarray(0, 8).toString("hex") !== D_CREATE) continue;
      let o = 8;
      const str = () => {
        const n = b.readUInt32LE(o);
        o += 4;
        const s = b.subarray(o, o + n).toString("utf8");
        o += n;
        return s;
      };
      const name = str();
      const symbol = str();
      str();
      o += 32 * 3; // mint, bonding curve, user
      const creator = bs58(b.subarray(o, o + 32));
      return { name, symbol, creator, ts: tx.blockTime ?? null };
    }
    return null; // created before the history we read, or not a pump.fun token
  }

  /**
   * Every wallet that sent SOL to the hub or got SOL from it, read from the chain (not the
   * tracer's top-N list, which drops small transfers such as a deployer's top-up).
   */
  async function neighborsOf(hub) {
    const sigs = (await solRpc.signatures(hub, HUB_SIGS)).map((s) => s.signature);
    const res = await txs(sigs);
    const flows = new Map(); // wallet -> { sentToHub, gotFromHub, n }
    for (const tx of res) {
      const ixs = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
      for (const ix of ixs) {
        if (ix.programId !== SYSTEM || ix.parsed?.type !== "transfer") continue;
        const { source, destination, lamports } = ix.parsed.info;
        const other = source === hub ? destination : destination === hub ? source : null;
        if (!other || other === hub) continue;
        const f = flows.get(other) ?? { sentToHub: 0, gotFromHub: 0, n: 0 };
        if (destination === hub) f.sentToHub += lamports / 1e9;
        else f.gotFromHub += lamports / 1e9;
        f.n++;
        flows.set(other, f);
      }
    }
    return flows;
  }

  /** @param hub a Solana wallet at the centre (a collector, a bridge counterpart, the scanned wallet) */
  async function scan(hub) {
    const flows = await neighborsOf(hub);
    const wallets = [hub, ...[...flows.entries()].sort((a, b) => b[1].n - a[1].n).map(([w]) => w)].slice(0, MAX_WALLETS);
    const byMint = new Map();
    await Promise.all(
      wallets.map(async (w) => {
        const sigs = (await solRpc.signatures(w, SIGS_PER_WALLET)).map((s) => s.signature);
        for (const tx of await txs(sigs)) {
          for (const [prog, b64] of programData(tx.meta?.logMessages)) {
            const b = Buffer.from(b64, "base64");
            if (prog !== PUMP || b.subarray(0, 8).toString("hex") !== D_TRADE) continue;
            const mint = bs58(b.subarray(8, 40));
            const isBuy = b[8 + 32 + 16] === 1;
            const m = byMint.get(mint) ?? { mint, wallets: new Set(), firstBuy: new Map(), buys: 0, sells: 0, firstTs: Infinity };
            m.wallets.add(w);
            isBuy ? m.buys++ : m.sells++;
            if (tx.blockTime) m.firstTs = Math.min(m.firstTs, tx.blockTime);
            if (isBuy && tx.blockTime) m.firstBuy.set(w, Math.min(m.firstBuy.get(w) ?? Infinity, tx.blockTime));
            byMint.set(mint, m);
          }
        }
      }),
    );
    const shared = [...byMint.values()].filter((m) => m.wallets.size >= 2).sort((a, b) => b.wallets.size - a.wallets.size).slice(0, 6);
    const out = [];
    for (const m of shared) {
      const c = await creation(m.mint).catch(() => null);
      if (!c?.ts) continue; // launch time unknown: cannot tell a bundle from trading
      const early = [...m.firstBuy.values()].filter((t) => t - c.ts >= 0 && t - c.ts <= BUNDLE_SECONDS);
      if (early.length < 2) continue;
      out.push({
        chain: "solana",
        token: m.mint,
        name: c.name,
        symbol: c.symbol,
        launchpad: "pump.fun",
        ts: c.ts,
        creator: c.creator,
        bundleWallets: early.length,
        buys: m.buys,
        sells: m.sells,
        secondsAfterLaunch: Math.min(...early) - c.ts,
        // the deployer itself moved SOL to or from the hub
        deployerFlow: c.creator && flows.has(c.creator) ? flows.get(c.creator) : c.creator === hub ? { self: true } : null,
      });
    }
    return { hub, neighbors: flows.size, scannedWallets: wallets.length, bundles: out };
  }
  scan.neighborsOf = neighborsOf;
  return scan;
}
