// ZeroPrint UI server: serves the static build and proxies /rpc, /asp, /relayer on the same
// origin so the page's CSP can be connect-src 'self'. No analytics, no third parties, no logs of bodies.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBridges } from "./bridges.mjs";
import { allowed, loadPairs, offered, pairKeys } from "./swap-pairs.mjs";
import { createBundleScanner } from "./launches/bundles.mjs";
import { createEthScanner } from "./launches/eth.mjs";
import { createInvestigator } from "./launches/investigate.mjs";
import { createPeakFinder } from "./launches/peak.mjs";
import { createSolScanner } from "./launches/sol.mjs";
import { createSolRpc } from "./launches/solrpc.mjs";
import { swapOf, swapUsd } from "./swaps.mjs";
import { visitorId } from "./visitor.mjs";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8920);
const DIST = path.resolve(import.meta.dirname, process.env.DIST_DIR ?? "dist");
const CONFIG = JSON.parse(fs.readFileSync(process.env.UI_CONFIG, "utf8"));
const RPC_URL = process.env.RPC_URL;
const ASP_URL = process.env.ASP_URL ?? "http://127.0.0.1:8922";
const RELAYER_URL = process.env.RELAYER_URL ?? "http://127.0.0.1:8921";
const TRUSTED_PROXY = process.env.TRUSTED_PROXY ?? ""; // address of the public reverse proxy, if any
const bridges = createBridges({ chainId: CONFIG.deployment.chainId, test: process.env.BRIDGE_TEST === "1" });
// Swaps use the same two providers, from any origin the probe found a filling pair for. No list
// yet (a test network) means nothing is held back.
const SWAP_PAIRS = loadPairs(process.env.SWAP_PAIRS ?? path.join(import.meta.dirname, `swap-pairs.${CONFIG.deployment.chainId}.json`));
// Footprint reads a wallet-tracer service (read-only)
const TRACER_URL = process.env.TRACER_URL ?? "http://127.0.0.1:8810";
// Robinhood Chain token launches, from a local launch index (read-only)
const LAUNCH_DB = process.env.LAUNCH_DB ?? "data/intel.db";
let launchQ = null;
let rhDb = null;
const getRhDb = () => (rhDb ??= new DatabaseSync(LAUNCH_DB, { readOnly: true }));
function launchesFor(addrs) {
  if (!launchQ) {
    const db = getRhDb();
    launchQ = {
      rows: db.prepare(
        "select creator, token, name, symbol, coalesce(launchpad, '') launchpad, ts, block, peak_mc_usd, 'robinhood' chain from launches where creator = ? and hidden = 0 order by block desc limit 12",
      ),
      count: db.prepare("select count(*) n from launches where creator = ?"),
    };
  }
  const out = {};
  for (const a of addrs) {
    const n = launchQ.count.get(a).n;
    if (n) out[a] = { total: n, recent: launchQ.rows.all(a) };
  }
  return out;
}

// Other chains: Solana launchpads by reading the creator's transactions, Ethereum deploys via
// Etherscan. Slow (seconds per wallet), so cached for 6 h and asked for separately.
// one cached Solana client shared by every scanner (transactions are read once)
const solRpc = process.env.SOL_RPC ? createSolRpc(process.env.SOL_RPC) : null;
const scanSol = solRpc ? createSolScanner(solRpc) : null;
const scanEth = process.env.ETHERSCAN_API_KEY
  ? createEthScanner({ apiKey: process.env.ETHERSCAN_API_KEY, rpcUrl: process.env.ETH_RPC ?? "https://ethereum-rpc.publicnode.com" })
  : null;
const scanBundles = solRpc ? createBundleScanner(solRpc) : null;
const peakOf = createPeakFinder();

/** The scanned address as a token: a Robinhood launch from the index, or a Solana mint. */
let tokenQ = null;
const tokenCache = new Map(); // addr -> { at, value }
async function tokenInfo(addr) {
  if (/^0x[0-9a-f]{40}$/.test(addr)) {
    tokenQ ??= getRhDb().prepare(
      "select creator, token, name, symbol, coalesce(launchpad, '') launchpad, ts, block, peak_mc_usd, 'robinhood' chain from launches where token = ?",
    );
    return tokenQ.get(addr) ?? null;
  }
  if (!solRpc) return null;
  const hit = tokenCache.get(addr);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
  const asset = await solRpc.call("getAsset", { id: addr }).catch(() => null);
  let value = null;
  if (/^Fungible/.test(asset?.interface ?? "")) {
    // creator: whoever paid for the mint's first transaction, if it is within reach
    let before;
    let oldest;
    for (let i = 0; i < 60; i++) {
      const s = await solRpc.call("getSignaturesForAddress", [addr, { limit: 1000, ...(before && { before }) }]).catch(() => null);
      if (!s?.length) break;
      oldest = before = s[s.length - 1].signature;
      if (s.length < 1000) {
        before = null;
        break;
      }
    }
    const [tx] = oldest && !before ? await solRpc.transactions([oldest]) : [null];
    const meta = asset.content?.metadata ?? {};
    value = {
      chain: "solana",
      token: addr,
      name: meta.name ?? "",
      symbol: meta.symbol ?? "",
      launchpad: "",
      ts: tx?.blockTime ?? null,
      creator: tx?.transaction?.message?.accountKeys?.[0]?.pubkey ?? null,
    };
  }
  tokenCache.set(addr, { at: Date.now(), value });
  return value;
}
const bundleCache = new Map(); // hub -> { at, value }
const deepCache = new Map(); // addr -> { at, value }

// Busy counterparties (exchange hot wallets, bridge solvers, payment services) are not people:
// the scan marks them so the page can say the trail stops there.
const SERVICE_TX = 3000;
const serviceCache = new Map(); // "chain:addr" -> { at, n }
const ALCHEMY_KEY = process.env.SOL_RPC?.split("/").pop();
const EVM_SLUG = { 4663: "robinhood", 1: "eth", 8453: "base" };
async function batchRpc(url, calls) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c }))),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  return Array.isArray(j) ? j.sort((a, b) => a.id - b.id).map((x) => x.result) : [];
}
const CHAIN_NATIVE = { 4663: "ETH", 1: "ETH", 56: "BNB", 8453: "ETH" };

// Contracts are not wallets. The tracer reports every token transfer on its own, so a pool, a
// router or a launch contract arrives on the page looking like a person who sent money. Here each
// counterparty is asked whether it has code, and when it does the transaction is read back on our
// own node: if value moved both ways in it, the leg becomes the one swap it really was.
const OWN_RPC = { 4663: RPC_URL, ...(process.env.ETH_RPC ? { 1: process.env.ETH_RPC } : {}) };
const SWAP_LEGS = 20; // transactions re-read per scan
const codeCache = new Map(); // "chain:addr" -> boolean
const tokenMetaCache = new Map(); // "chain:addr" -> { symbol, decimals } | null

const abiString = (hex) => {
  if (!hex || hex === "0x") return "";
  const b = hex.slice(2);
  if (b.length === 64) return Buffer.from(b, "hex").toString("utf8").replace(/\0+$/g, "").trim();
  const len = parseInt(b.slice(64, 128), 16);
  return Number.isFinite(len) ? Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").trim() : "";
};

async function tokenMeta(chain, tokens) {
  const todo = tokens.filter((t) => !tokenMetaCache.has(`${chain}:${t}`));
  if (todo.length) {
    const res = await batchRpc(
      OWN_RPC[chain],
      todo.flatMap((to) => [
        { method: "eth_call", params: [{ to, data: "0x95d89b41" }, "latest"] },
        { method: "eth_call", params: [{ to, data: "0x313ce567" }, "latest"] },
      ]),
    ).catch(() => []);
    todo.forEach((t, i) => {
      const decimals = parseInt(res[i * 2 + 1] ?? "", 16);
      tokenMetaCache.set(`${chain}:${t}`, Number.isFinite(decimals) ? { symbol: abiString(res[i * 2]), decimals } : null);
    });
  }
  return Object.fromEntries(tokens.map((t) => [t, tokenMetaCache.get(`${chain}:${t}`)]).filter(([, m]) => m));
}

// Ethereum and Base publish the native currency a contract pays out from inside a transaction;
// Robinhood Chain does not. Where that list exists, a sale's proceeds can be read and the leg told
// in full instead of showing only what went in.
const INTERNAL_SLUG = { 1: "eth", 8453: "base" };
async function internalPayouts(chain, me) {
  if (!INTERNAL_SLUG[chain] || !ALCHEMY_KEY || !me) return new Map();
  const j = await fetch(`https://${INTERNAL_SLUG[chain]}-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ toAddress: me, category: ["internal"], order: "desc", maxCount: "0x3e8" }] }),
    signal: AbortSignal.timeout(20_000),
  })
    .then((r) => r.json())
    .catch(() => null);
  const paid = new Map(); // tx hash -> wei
  for (const t of j?.result?.transfers ?? []) {
    const wei = BigInt(t.rawContract?.value ?? 0);
    if (wei > 0n) paid.set(t.hash.toLowerCase(), (paid.get(t.hash.toLowerCase()) ?? 0n) + wei);
  }
  return paid;
}

async function markSwaps(trace) {
  if (!trace?.in) return trace;
  const side = (l) => (l.dir === "in" ? [l.from, l.to] : [l.to, l.from]); // [them, me]
  const legs = [...trace.in, ...trace.out]
    .filter((l) => l.kind === "wallet" && !l.self && l.from?.tx && l.from.tx === l.to?.tx && OWN_RPC[l.from.chain])
    .slice(0, SWAP_LEGS);
  if (!legs.length) return trace;

  const byChain = new Map();
  for (const l of legs) (byChain.get(l.from.chain) ?? byChain.set(l.from.chain, []).get(l.from.chain)).push(l);
  await Promise.all(
    [...byChain.entries()].map(async ([chain, list]) => {
      try {
        const url = OWN_RPC[chain];
        const addrs = [...new Set(list.map((l) => side(l)[0].address.toLowerCase()))].filter((a) => !codeCache.has(`${chain}:${a}`));
        if (addrs.length) {
          const res = await batchRpc(url, addrs.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })));
          addrs.forEach((a, i) => codeCache.set(`${chain}:${a}`, !!res[i] && res[i] !== "0x"));
        }
        const contractLegs = list.filter((l) => codeCache.get(`${chain}:${side(l)[0].address.toLowerCase()}`));
        for (const l of contractLegs) l.contract = true;
        const hashes = [...new Set(contractLegs.map((l) => l.from.tx))];
        if (!hashes.length) return;
        const res = await batchRpc(url, hashes.flatMap((h) => [
          { method: "eth_getTransactionByHash", params: [h] },
          { method: "eth_getTransactionReceipt", params: [h] },
        ]));
        const fetched = new Map(hashes.map((h, i) => [h, { tx: res[i * 2], receipt: res[i * 2 + 1] }]));
        const tokens = [...new Set([...fetched.values()].flatMap(({ receipt }) => (receipt?.logs ?? []).map((g) => g.address.toLowerCase())))];
        const [meta, paid] = await Promise.all([tokens.length ? tokenMeta(chain, tokens) : {}, internalPayouts(chain, trace.address)]);
        for (const l of contractLegs) {
          const { tx, receipt } = fetched.get(l.from.tx) ?? {};
          if (!tx || !receipt) continue;
          const swap = swapOf(side(l)[1].address, tx, receipt, meta, CHAIN_NATIVE[chain] ?? "ETH", paid.get(l.from.tx.toLowerCase()) ?? 0n);
          if (!swap) continue;
          l.kind = "dex";
          l.via = null;
          l.asset = { ...l.asset, ...swap, usd: swapUsd(l.asset, swap) };
          l.proof = { status: l.proof?.status ?? "verified", checks: [...(l.proof?.checks ?? []), { ok: true, text: `swap read from tx ${l.from.tx}: ${swap.amountIn} ${swap.in} -> ${swap.amountOut} ${swap.out}` }] };
        }
      } catch {
        /* a node that cannot answer leaves the legs exactly as the tracer sent them */
      }
    }),
  );
  return trace;
}

async function markServices(trace) {
  if (!ALCHEMY_KEY || !trace?.in) return trace;
  const legs = [...trace.in, ...trace.out].filter((l) => l.kind === "wallet" && !l.self);
  const want = new Map(); // key -> [chain, addr]
  for (const l of legs) {
    const o = l.dir === "in" ? l.from : l.to;
    if (o?.address) want.set(`${o.chain}:${o.address}`, [o.chain, o.address]);
  }
  const todo = [...want.entries()].filter(([k]) => !(serviceCache.get(k)?.at > Date.now() - DEEP_TTL)).slice(0, 40);
  const byChain = new Map();
  for (const [k, [chain, addr]] of todo) (byChain.get(chain) ?? byChain.set(chain, []).get(chain)).push([k, addr]);
  await Promise.all(
    [...byChain.entries()].map(async ([chain, list]) => {
      try {
        if (EVM_SLUG[chain]) {
          const res = await batchRpc(`https://${EVM_SLUG[chain]}-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, list.map(([, a]) => ({ method: "eth_getTransactionCount", params: [a, "latest"] })));
          list.forEach(([k], i) => serviceCache.set(k, { at: Date.now(), n: parseInt(res[i] ?? "0x0", 16) }));
        } else if (Number(chain) === 792703809 && process.env.SOL_RPC) {
          const res = await batchRpc(process.env.SOL_RPC, list.map(([, a]) => ({ method: "getSignaturesForAddress", params: [a, { limit: 1000 }] })));
          list.forEach(([k], i) => serviceCache.set(k, { at: Date.now(), n: (res[i] ?? []).length, atLeast: (res[i] ?? []).length >= 1000 }));
        }
      } catch {
        /* unknown: leave it a wallet */
      }
    }),
  );
  for (const l of legs) {
    const o = l.dir === "in" ? l.from : l.to;
    const hit = serviceCache.get(`${o?.chain}:${o?.address}`);
    if (hit && hit.n >= (Number(o.chain) === 792703809 ? 1000 : SERVICE_TX)) {
      l.service = true;
      l.serviceTx = hit.n;
      l.serviceTxAtLeast = !!hit.atLeast;
    }
  }
  if (trace.firstFunder) {
    const o = trace.firstFunder.from;
    const hit = serviceCache.get(`${o?.chain}:${o?.address}`);
    if (trace.firstFunder.kind === "wallet" && hit && hit.n >= SERVICE_TX) Object.assign(trace.firstFunder, { service: true, serviceTx: hit.n });
  }
  return trace;
}

// Footprint investigation jobs: follow the money two hops across chains, report launches.
const investigate = process.env.SOL_RPC
  ? createInvestigator({
      tracerUrl: TRACER_URL,
      alchemyKey: process.env.SOL_RPC.split("/").pop(),
      rhDb: (() => {
        try {
          return getRhDb();
        } catch {
          return null;
        }
      })(),
      scanSolCreator: scanSol,
      scanEth,
      bundleScanner: scanBundles,
      solRpc,
    })
  : null;
const jobs = new Map(); // addr -> { at, state }
const JOB_TTL = 10 * 60_000; // short: a wallet can launch a token minutes after a scan
function job(addr) {
  const j = jobs.get(addr);
  if (j && Date.now() - j.at < JOB_TTL) return j.state;
  const state = { findings: [], nodes: 1, done: false };
  jobs.set(addr, { at: Date.now(), state });
  investigate(addr, (u) => Object.assign(state, u)).catch((e) => Object.assign(state, { done: true, error: e.message }));
  if (jobs.size > 500) jobs.delete(jobs.keys().next().value);
  return state;
}
const DEEP_TTL = 6 * 3600_000;
async function deepLaunches(addr) {
  const hit = deepCache.get(addr);
  if (hit && Date.now() - hit.at < DEEP_TTL) return hit.value;
  const evm = /^0x[0-9a-f]{40}$/.test(addr);
  const scan = evm ? scanEth : scanSol;
  if (!scan) return null;
  const value = await scan(addr).catch((e) => ({ error: e.message, launches: [] }));
  deepCache.set(addr, { at: Date.now(), value });
  return value;
}

// Read-only methods the page needs; the user's wallet sends transactions itself.
const RPC_ALLOW = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_call",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_estimateGas",
  "eth_getCode",
  "eth_sendRawTransaction", // bridge hop wallets sign in the browser; the node only relays the signed tx
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zkey": "application/octet-stream",
  ".vkey": "application/json",
  ".png": "image/png",
};

const SECURITY = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; "),
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=31536000",
};

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function forward(res, url, init, timeoutMs = 60_000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = Buffer.from(await r.arrayBuffer());
  res.writeHead(r.status, { ...SECURITY, "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
  res.end(body);
}

// Health of every moving part, for /status. Public numbers only; cached 15 s.
let statusCache = { at: 0, value: null };
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const getJson = (u) => fetch(u, { signal: AbortSignal.timeout(8_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
const balanceOf = (a) => (a ? rpc("eth_getBalance", [a, "latest"]).then((h) => BigInt(h).toString(), () => null) : null);
async function statusReport() {
  if (Date.now() - statusCache.at < 15_000 && statusCache.value) return statusCache.value;
  const d = CONFIG.deployment;
  const [block, poolBalance, health, stats, relayerUp, relayerBalance, bridgeReach] = await Promise.all([
    rpc("eth_getBlockByNumber", ["latest", false]).catch(() => null),
    balanceOf(d.pool),
    getJson(`${ASP_URL}/health`).catch(() => null),
    getJson(`${ASP_URL}/stats`).catch(() => null),
    fetch(`${RELAYER_URL}/ping`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.ok, () => false),
    balanceOf(CONFIG.relayer),
    bridges.routes().length ? bridges.reach().catch(() => null) : null,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const value = {
    at: now,
    chain: block ? { name: CONFIG.chainName, chainId: d.chainId, block: Number(block.number), lagSec: now - Number(block.timestamp) } : null,
    pool: { address: d.pool, balance: poolBalance, ...(stats && { deposits: stats.deposits, approved: stats.approved, pending: stats.pending, denied: stats.denied, windowSec: stats.delaySec }) },
    screening: stats?.screening ?? null,
    keeper: health
      ? { up: true, ok: health.ok, lastTickSec: health.at ? Math.round((Date.now() - health.at) / 1000) : null, error: health.error ?? null, address: health.keeper ?? null, guardian: health.guardian ?? null }
      : { up: false },
    relayer: { up: relayerUp, address: CONFIG.relayer ?? null, balance: relayerBalance },
    bridges: bridgeReach,
  };
  statusCache = { at: Date.now(), value };
  return value;
}

const sendJson = (res, code, body) => {
  res.writeHead(code, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  // The IPFS copy of the site calls these from another origin (no cookies are involved anywhere).
  if (/^\/(relayer|asp|bridge-api|swap-api|status-api)(\/|$)/.test(p)) {
    res.setHeader("access-control-allow-origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
      return res.end();
    }
  }

  if (p === "/status-api") return sendJson(res, 200, await statusReport());

  if (p === "/bridge-api/routes") return sendJson(res, 200, { routes: bridges.routes() });
  if (p.startsWith("/bridge-api/")) {
    try {
      if (p === "/bridge-api/quote" && req.method === "POST") return sendJson(res, 200, await bridges.quote(JSON.parse(await readBody(req, 4096))));
      if (p === "/bridge-api/submit" && req.method === "POST") return sendJson(res, 200, await bridges.submit(JSON.parse(await readBody(req, 4096))));
      if (p === "/bridge-api/status") return sendJson(res, 200, await bridges.status(Object.fromEntries(url.searchParams)));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  if (p === "/swap-api/routes") {
    // ?all=1 answers with every chain and asset the bridges know, not only what the list offers.
    // The probe has to ask that way: reading the narrowed offer, it could only ever confirm it,
    // and a pair dropped once would never be looked at again.
    const list = url.searchParams.get("all") === "1" ? null : SWAP_PAIRS;
    return sendJson(res, 200, {
      origins: offered(list, bridges.origins()).origins,
      destinations: offered(list, bridges.routes()).destinations,
      // what fills, so the page can stop offering a destination it would only refuse later
      pairs: pairKeys(list),
    });
  }
  if (p.startsWith("/swap-api/")) {
    try {
      if (p === "/swap-api/quote" && req.method === "POST") {
        const want = JSON.parse(await readBody(req, 4096));
        // The list shapes what the page offers; it does not forbid. A pair that is not on it is
        // still quoted, and the providers answer for themselves - which is the only way the probe
        // can find out whether a pair belongs on the list, and the only answer that is true for a
        // token somebody pasted. Refusing here instead made the server a second opinion about
        // what exists, and it was wrong twice.
        const pair = allowed(SWAP_PAIRS, want);
        const q = await bridges.quote(want);
        return sendJson(res, 200, { ...q, ...(pair?.minIn ? { minIn: pair.minIn } : {}), ...(pair ? {} : { offlist: true }) });
      }
      if (p === "/swap-api/token") {
        const token = await bridges.lookup(url.searchParams.get("chain"), url.searchParams.get("address") ?? "");
        return sendJson(res, 200, { token: { symbol: token.symbol, name: token.name, decimals: token.decimals, providers: [token.relay && "relay", token.near && "near"].filter(Boolean) } });
      }
      if (p === "/swap-api/submit" && req.method === "POST") return sendJson(res, 200, await bridges.submit(JSON.parse(await readBody(req, 4096))));
      if (p === "/swap-api/status") return sendJson(res, 200, await bridges.status(Object.fromEntries(url.searchParams)));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  // The token, when there is one. Written by hand (not by this process) to a file beside
  // the build, and read per request so setting it needs no deploy: a wrong address here is the one
  // mistake nobody can take back, so it is one file, one writer, and no cache.
  if (p === "/token-api") {
    let token = null;
    try {
      const raw = JSON.parse(fs.readFileSync(process.env.TOKEN_FILE ?? path.join(import.meta.dirname, "token.json"), "utf8"));
      if (/^0x[0-9a-fA-F]{40}$/.test(raw.ca ?? "") && !/^0x0{40}$/.test(raw.ca)) token = { ca: raw.ca, symbol: raw.symbol ?? "ZERO", chain: raw.chain ?? CONFIG.chainName, at: raw.at ?? null };
    } catch {
      /* no file, or nothing readable in it: there is no token yet */
    }
    return sendJson(res, 200, { token });
  }

  if (p === "/config.json") {
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(CONFIG));
  }

  if (p === "/rpc" && req.method === "POST") {
    const body = await readBody(req);
    const msg = JSON.parse(body.toString());
    const calls = Array.isArray(msg) ? msg : [msg];
    if (!calls.every((c) => RPC_ALLOW.has(c.method))) {
      res.writeHead(403, { ...SECURITY, "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: calls[0]?.id ?? null, error: { code: -32601, message: "method not allowed" } }));
    }
    return forward(res, RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
  }

  if (p.startsWith("/asp/") && req.method === "GET") return forward(res, ASP_URL + p.slice(4));

  if (p === "/footprint-api/launches" && req.method === "GET") {
    const addrs = [...new Set((url.searchParams.get("addr") ?? "").toLowerCase().split(","))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, 80);
    let body;
    try {
      body = { chain: 4663, launches: launchesFor(addrs) };
    } catch (e) {
      body = { chain: 4663, launches: {}, error: "launch index unavailable" };
    }
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(body));
  }

  if (p === "/footprint-api/investigate" && req.method === "GET") {
    const raw = url.searchParams.get("addr") ?? "";
    const addr = raw.startsWith("0x") ? raw.toLowerCase() : raw;
    if (!investigate || !(/^0x[0-9a-f]{40}$/.test(addr) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))) {
      res.writeHead(400, { ...SECURITY, "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad address" }));
    }
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(job(addr)));
  }

  if (p === "/footprint-api/bundles" && req.method === "GET") {
    const hubs = [...new Set((url.searchParams.get("addr") ?? "").split(","))].filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).slice(0, 3);
    const out = {};
    if (scanBundles)
      await Promise.all(
        hubs.map(async (h) => {
          const hit = bundleCache.get(h);
          const v = hit && Date.now() - hit.at < DEEP_TTL ? hit.value : await scanBundles(h).catch(() => null);
          if (v && !hit) bundleCache.set(h, { at: Date.now(), value: v });
          if (v?.bundles?.length) out[h] = v.bundles;
        }),
      );
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ bundles: out }));
  }

  if (p === "/footprint-api/launches-deep" && req.method === "GET") {
    const addrs = [...new Set((url.searchParams.get("addr") ?? "").split(","))]
      .map((a) => (a.startsWith("0x") ? a.toLowerCase() : a))
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))
      .slice(0, 6);
    const out = {};
    await Promise.all(
      addrs.map(async (a) => {
        const v = await deepLaunches(a);
        if (v?.launches?.length) out[a] = { total: v.launches.length, partial: v.partial, recent: v.launches.slice(0, 12) };
      }),
    );
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ launches: out }));
  }

  if (p === "/footprint-api/token" && req.method === "GET") {
    const raw = url.searchParams.get("addr") ?? "";
    const addr = raw.startsWith("0x") ? raw.toLowerCase() : raw;
    const ok = /^0x[0-9a-f]{40}$/.test(addr) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    const token = ok ? await tokenInfo(addr).catch(() => null) : null;
    res.writeHead(ok ? 200 : 400, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(ok ? { token } : { error: "bad address" }));
  }

  if (p === "/footprint-api/peak" && req.method === "GET") {
    const chain = url.searchParams.get("chain");
    const raw = url.searchParams.get("token") ?? "";
    const token = chain === "ethereum" ? raw.toLowerCase() : raw;
    const ok = (chain === "ethereum" && /^0x[0-9a-f]{40}$/.test(token)) || (chain === "solana" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token));
    if (!ok) {
      res.writeHead(400, { ...SECURITY, "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad token" }));
    }
    // answer within 20 s; a slow lookup keeps running and the page asks again
    const pending = Symbol();
    const v = await Promise.race([peakOf(chain, token), new Promise((r) => setTimeout(() => r(pending), 20_000))]);
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(v === pending ? { pending: true } : { peak: v }));
  }

  if (p === "/footprint-api/trace" && req.method === "GET") {
    // The tracer limits traces per visitor; it gets a scrambled, daily-changing ID instead of
    // the IP, and the investigator's own background traces never use up a visitor's allowance.
    const r = await fetch(TRACER_URL + "/trace" + url.search, {
      headers: { "x-forwarded-for": visitorId(req, TRUSTED_PROXY) },
      signal: AbortSignal.timeout(180_000),
    });
    let body = await r.text();
    if (r.ok) {
      try {
        body = JSON.stringify(await markSwaps(await markServices(JSON.parse(body))));
      } catch {
        /* pass the tracer's answer through unchanged */
      }
    }
    res.writeHead(r.status, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store" });
    return res.end(body);
  }

  if (p === "/footprint-api/leg" && req.method === "GET")
    return forward(res, TRACER_URL + p.slice("/footprint-api".length) + url.search, {}, 180_000);

  if (p.startsWith("/relayer/")) {
    const init = { method: req.method, headers: { "content-type": "application/json", origin: CONFIG.origin } };
    if (req.method === "POST") init.body = await readBody(req);
    return forward(res, RELAYER_URL + p + url.search, init);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, SECURITY);
    return res.end();
  }
  let file = path.normalize(path.join(DIST, decodeURIComponent(p)));
  if (!file.startsWith(DIST)) {
    res.writeHead(403, SECURITY);
    return res.end();
  }
  if (p === "/app" || p === "/app/") file = path.join(DIST, "app.html");
  if (p === "/docs" || p === "/docs/") file = path.join(DIST, "docs.html");
  if (p === "/footprint" || p === "/footprint/") file = path.join(DIST, "footprint.html");
  if (p === "/status" || p === "/status/") file = path.join(DIST, "status.html");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  const ext = path.extname(file);
  const immutable = p.startsWith("/assets/") || p.startsWith("/artifacts/");
  res.writeHead(200, {
    ...SECURITY,
    "content-length": fs.statSync(file).size,
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

// HTTPS is required: the SDK hashes circuit files with crypto.subtle, which browsers only expose
// in a secure context.
const onRequest = (req, res) =>
  handle(req, res).catch((e) => {
    if (!res.headersSent) res.writeHead(502, { ...SECURITY, "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  });
const tls = process.env.TLS_CERT
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
  : null;
(tls ? https.createServer(tls, onRequest) : http.createServer(onRequest)).listen(PORT, HOST, () =>
  console.log(`ZeroPrint UI on ${tls ? "https" : "http"}://${HOST}:${PORT}`),
);

