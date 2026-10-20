// Footprint investigation: follow the money up to two hops from a wallet, across chains, and
// look for token launches anywhere on the way. Catches the usual escapes:
//   - a fresh deployer funded by the wallet (or funding it), directly or through one more wallet
//   - bridging to another chain and launching there
//   - bundle wallets that bought a launch in its first blocks and sent the money back
//   - siblings: a funder that paid both this wallet and a deployer
// Exchanges, DEXes and privacy pools end a path: on-chain there is no link through them.
const SOL_CHAIN = 792703809;
const isEvm = (a) => /^0x[0-9a-f]{40}$/.test(a ?? "");
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a ?? "") && !/^0x/.test(a);
const norm = (a) => (/^0x/i.test(a ?? "") ? a.toLowerCase() : a);

const LIMITS = {
  depth: 2,
  linksPerNode: [40, 30], // depth 0, depth 1: small transfers matter (a deployer's top-up)
  nodes: 160,
  traces: 8, // the tracer allows 20 uncached traces per 10 min per caller: keep most for visitors
  busyEvmTx: 3000, // more transactions than this: a service, don't expand it
  busySolSigs: 1000,
  ms: 150_000,
};

const ALCHEMY_SLUG = { 4663: "robinhood", 1: "eth", 8453: "base" };
const FUNDING_TOKENS = {
  4663: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"],
  1: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  8453: ["0x4200000000000000000000000000000000000006", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
};

export function createInvestigator({ tracerUrl, alchemyKey, rhDb, scanSolCreator, scanEth, bundleScanner, solRpc }) {
  const alchemy = (chain, method, params) =>
    fetch(`https://${ALCHEMY_SLUG[chain]}-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    })
      .then((r) => r.json())
      .then((j) => j.result);

  const traceCache = new Map();
  async function trace(addr) {
    if (traceCache.has(addr)) return traceCache.get(addr);
    const p = fetch(`${tracerUrl}/trace?addr=${encodeURIComponent(addr)}&chain=auto`, {
      // FOOTPRINT_LIMIT=off: a new ID per trace, so the tracer's per-visitor limit never applies
      headers: { "x-forwarded-for": process.env.FOOTPRINT_LIMIT === "off" ? `inv-${Math.random().toString(36).slice(2)}` : "shadepool-investigator" },
      signal: AbortSignal.timeout(120_000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    traceCache.set(addr, p);
    return p;
  }

  /** Every EVM wallet that sent funding money to addr or got it from addr on one chain (not just the biggest). */
  async function evmTransfers(chain, addr) {
    const out = [];
    for (const side of [{ toAddress: addr }, { fromAddress: addr }]) {
      for (const run of [{ category: ["external"] }, { category: ["erc20"], contractAddresses: FUNDING_TOKENS[chain] }]) {
        const r = await alchemy(chain, "alchemy_getAssetTransfers", [
          { fromBlock: "0x0", toBlock: "latest", ...side, ...run, excludeZeroValue: true, maxCount: "0x3e8", withMetadata: false },
        ]).catch(() => null);
        for (const t of r?.transfers ?? []) {
          const other = norm(side.toAddress ? t.from : t.to);
          if (other && other !== addr) out.push({ addr: other, dir: side.toAddress ? "in" : "out", value: Number(t.value ?? 0), asset: t.asset, chain });
        }
      }
    }
    return out;
  }

  const txCount = (chain, a) => alchemy(chain, "eth_getTransactionCount", [a, "latest"]).then((h) => parseInt(h ?? "0x0", 16)).catch(() => 0);
  const isContract = (chain, a) => alchemy(chain, "eth_getCode", [a, "latest"]).then((c) => !!c && c !== "0x" && !/^0xef0100/i.test(c)).catch(() => false);

  /** Links of one node: wallets and bridge counterparts, with how they connect. */
  async function linksOf(node, budget) {
    const links = new Map(); // addr -> { how, chain, value, asset }
    const add = (a, how, chain, value = 0, asset = "", extra = {}) => {
      a = norm(a);
      if (!a || a === node.addr || (!isEvm(a) && !isSol(a))) return;
      const cur = links.get(a);
      if (!cur || value > cur.value || extra.via) links.set(a, { how, chain, value, asset, ...extra });
    };
    const ends = new Set(); // exchanges, routers, pools: a path stops there
    // The tracer resolves bridges and labels exchanges; use it for the start, for Solana wallets
    // and for wallets reached over a bridge. Other wallets: direct transfers from Alchemy.
    let tr = null;
    const wantTrace = node.depth === 0 || isSol(node.addr) || node.path.at(-1)?.how?.startsWith("bridged");
    if (wantTrace && budget.traces > 0) {
      budget.traces--;
      tr = await trace(node.addr);
      if (tr?.error) tr = null; // rate-limited or failed: carry on with what we have
    }
    for (const l of [...(tr?.in ?? []), ...(tr?.out ?? [])]) {
      const other = l.dir === "in" ? l.from : l.to;
      if (l.kind === "wallet") add(other?.address, l.dir === "in" ? "got funds from" : "sent funds to", other?.chain, Number(l.asset?.usd ?? 0), l.asset?.in);
      else if (l.kind === "bridge" && !l.self)
        add(other?.address, l.dir === "in" ? "bridged from" : "bridged to", other?.chain, Number(l.asset?.usd ?? 0), l.asset?.in, { via: l.via, chainName: other?.chainName });
      else if (l.kind === "multisend") add(other?.address, l.dir === "in" ? "multisent from" : "multisent to", other?.chain);
      else if (other?.address) ends.add(norm(other.address));
    }
    if (isEvm(node.addr)) {
      const chains = (tr?.chains ?? [4663]).filter((c) => ALCHEMY_SLUG[c]);
      for (const chain of chains) {
        for (const t of await evmTransfers(chain, node.addr)) {
          if (ends.has(t.addr)) continue;
          add(t.addr, t.dir === "in" ? "got funds from" : "sent funds to", chain, t.value, t.asset);
        }
      }
    } else if (isSol(node.addr) && bundleScanner) {
      const flows = await bundleScanner.neighborsOf(node.addr).catch(() => new Map());
      for (const [a, f] of flows) {
        if (ends.has(a)) continue;
        add(a, f.sentToHub >= f.gotFromHub ? "got SOL from" : "sent SOL to", SOL_CHAIN, Math.max(f.sentToHub, f.gotFromHub), "SOL");
      }
    }
    return [...links.entries()].map(([addr, l]) => ({ addr, ...l }));
  }

  // ---------- checks ----------
  function rhLaunchesOf(addrs) {
    const evm = addrs.filter(isEvm);
    if (!evm.length || !rhDb) return {};
    const q = rhDb.prepare(
      `select creator, token, name, symbol, coalesce(launchpad,'') launchpad, ts, block, peak_mc_usd from launches where hidden = 0 and creator in (${evm.map(() => "?").join(",")}) order by block desc`,
    );
    const out = {};
    for (const r of q.all(...evm)) (out[r.creator] ??= []).push({ ...r, chain: "robinhood" });
    return out;
  }

  /** Robinhood tokens that two or more of these wallets bought within 3 blocks of launch. */
  function rhBundles(addrs) {
    const evm = addrs.filter(isEvm);
    if (evm.length < 2 || !rhDb) return [];
    const rows = rhDb
      .prepare(
        `select w.token, w.wallet, w.block - l.block delay, l.creator, l.name, l.symbol, l.block lblock, l.ts
         from wallet_buys w join launches l on l.token = w.token
         where w.wallet in (${evm.map(() => "?").join(",")}) and w.block - l.block between 0 and 3`,
      )
      .all(...evm);
    const by = new Map();
    for (const r of rows) {
      const b = by.get(r.token) ?? { token: r.token, name: r.name, symbol: r.symbol, creator: r.creator, ts: r.ts, block: r.lblock, wallets: new Set() };
      b.wallets.add(r.wallet);
      by.set(r.token, b);
    }
    return [...by.values()].filter((b) => b.wallets.size >= 2 || evm.includes(b.creator));
  }

  return async function investigate(start, onUpdate = () => {}) {
    const t0 = Date.now();
    const root = norm(start);
    const nodes = new Map([[root, { addr: root, depth: 0, path: [], busy: false }]]);
    const findings = [];
    const seenFinding = new Set();
    const budget = { traces: LIMITS.traces };
    const timeUp = () => Date.now() - t0 > LIMITS.ms;
    const pathOf = (n) => [...n.path, { addr: n.addr }];

    const report = (f) => {
      const key = `${f.kind}:${f.token ?? ""}:${f.addr ?? ""}`;
      if (seenFinding.has(key)) return;
      seenFinding.add(key);
      findings.push(f);
      onUpdate({ findings, nodes: nodes.size, done: false });
    };

    // BFS over money links
    let frontier = [nodes.get(root)];
    for (let depth = 0; depth < LIMITS.depth && frontier.length && !timeUp(); depth++) {
      const next = [];
      const queue = [...frontier];
      await Promise.all(
        [0, 1, 2].map(async () => {
          while (queue.length && !timeUp()) {
            const n = queue.shift();
            if (n.busy) continue;
            const links = (await linksOf(n, budget).catch(() => []))
              .sort((a, b) => (b.how.startsWith("bridged") ? 1e12 : b.value) - (a.how.startsWith("bridged") ? 1e12 : a.value))
              .slice(0, LIMITS.linksPerNode[depth]);
            for (const l of links) {
              if (nodes.has(l.addr) || nodes.size >= LIMITS.nodes) continue;
              const child = {
                addr: l.addr,
                depth: depth + 1,
                chain: l.chain,
                path: [...n.path, { addr: n.addr, how: l.how, via: l.via, chainName: l.chainName, chain: l.chain, value: l.value, asset: l.asset }],
                busy: false,
              };
              nodes.set(l.addr, child);
              next.push(child);
            }
          }
        }),
      );
      // services (exchanges' hot wallets, solvers) are not expanded further
      await Promise.all(
        next.map(async (c) => {
          if (isEvm(c.addr)) {
            const chain = ALCHEMY_SLUG[c.chain] ? c.chain : 4663;
            c.busy = (await isContract(chain, c.addr)) || (await txCount(chain, c.addr)) > LIMITS.busyEvmTx;
          }
        }),
      );
      frontier = next;
      onUpdate({ findings, nodes: nodes.size, done: false });
    }

    const all = [...nodes.values()];
    const addrs = all.map((n) => n.addr);

    // 1. Robinhood launches by any wallet on the trail
    const rh = rhLaunchesOf(addrs);
    for (const [a, list] of Object.entries(rh)) report({ kind: "launched", addr: a, path: pathOf(nodes.get(a)), total: list.length, launches: list.slice(0, 8) });

    // 2. Robinhood bundle pattern
    for (const b of rhBundles(addrs.filter((a) => !nodes.get(a).busy))) {
      const cn = nodes.get(b.creator);
      report({
        kind: "bundle",
        chain: "robinhood",
        token: b.token,
        name: b.name,
        symbol: b.symbol,
        creator: b.creator,
        ts: b.ts,
        block: b.block,
        wallets: [...b.wallets].map((w) => ({ addr: w, path: pathOf(nodes.get(w)) })),
        creatorPath: cn ? pathOf(cn) : null,
      });
    }

    // 3. Solana: bundle pattern around Solana wallets near the start, and quiet wallets that created tokens
    const solNodes = all.filter((n) => isSol(n.addr) && !n.busy);
    for (const n of solNodes.filter((x) => x.depth <= 1).slice(0, 4)) {
      if (timeUp()) break;
      const r = await bundleScanner?.(n.addr).catch(() => null);
      for (const b of r?.bundles ?? []) {
        const cn = b.creator ? nodes.get(b.creator) : null;
        report({ kind: "bundle", chain: "solana", ...b, hub: n.addr, hubPath: pathOf(n), creatorPath: cn ? pathOf(cn) : null });
      }
    }
    const solQueue = solNodes.slice(0, 40);
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (solQueue.length && !timeUp()) {
          const n = solQueue.shift();
          // The start wallet: its full recent history. Further out, the last 100 transactions:
          // a deployer's launch sits near its funding, and this keeps the scan cheap.
          const r = await scanSolCreator?.(n.addr, { maxSigs: n.depth === 0 ? 600 : 100 }).catch(() => null);
          if (r?.launches?.length) report({ kind: "launched", addr: n.addr, path: pathOf(n), total: r.launches.length, partial: r.partial, launches: r.launches.slice(0, 8) });
        }
      }),
    );

    // 4. Ethereum deploys for the start and its direct links
    for (const n of all.filter((x) => isEvm(x.addr) && x.depth <= 1 && !x.busy).slice(0, 8)) {
      if (timeUp() || !scanEth) break;
      const r = await scanEth(n.addr).catch(() => null);
      if (r?.launches?.length) report({ kind: "launched", addr: n.addr, path: pathOf(n), total: r.launches.length, launches: r.launches.slice(0, 8) });
    }

    const result = { findings, nodes: nodes.size, done: true, ms: Date.now() - t0, timedOut: timeUp(), sol: solRpc ? { ...solRpc.stats } : undefined };
    onUpdate(result);
    return result;
  };
}
