// ZeroPrint keeper: drives the ZeroPrintASP contract so users never have to.
//   - queues every new deposit (starting its window),
//   - as guardian, denies deposits from OFAC-listed or blocklisted wallets inside the window,
//   - approves deposits whose window has passed, in batches (that posts the root).
// Nothing here is needed for funds or privacy: without the keeper anyone can queue and approve.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseAddressList } from "./lib.mjs";

const env = (k, d) => process.env[k] ?? d;
const RPC_URL = env("RPC_URL");
const D = JSON.parse(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const DATA_DIR = env("DATA_DIR");
const POLL_SEC = Number(env("POLL_SEC", "30"));
const PORT = Number(env("PORT", "8922"));
const HOST = env("HOST", "127.0.0.1");
const LOG_CHUNK = BigInt(env("LOG_CHUNK", "200000"));
const BATCH = Number(env("BATCH", "40"));
const OFAC_URL = env(
  "OFAC_URL",
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt",
);
const BLOCKLIST_PATH = env("BLOCKLIST_PATH", path.join(import.meta.dirname, "blocklist.json"));
const EXTRA_BLOCKLIST_PATH = env("EXTRA_BLOCKLIST_PATH", "");

fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_PATH = path.join(DATA_DIR, "keeper-state.json");
const OFAC_CACHE = path.join(DATA_DIR, "ofac-eth.txt");

const chain = defineChain({
  id: D.chainId,
  name: `zeroprint-${D.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: viemHttp(RPC_URL) });
const me = privateKeyToAccount(env("KEEPER_PK"));
const wallet = createWalletClient({ chain, account: me, transport: viemHttp(RPC_URL) });

const DEPOSITED = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);
const ASP = parseAbi([
  "event Queued(uint256 indexed _label, address indexed _depositor, uint256 _at)",
  "event Denied(uint256 indexed _label, string _reason)",
  "event Approved(uint256 indexed _label, uint256 _index)",
  "function WINDOW() view returns (uint256)",
  "function guardian() view returns (address)",
  "function size() view returns (uint256)",
  "function queueMany(uint256[] _labels)",
  "function deny(uint256 _label, string _reason)",
  "function approve(uint256[] _labels) returns (uint256)",
]);

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state: what the chain says, rebuilt from events ----------
function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastBlock: D.startBlock - 1, deposits: {} };
  }
}
const state = load();
const save = () => {
  fs.writeFileSync(STATE_PATH + ".tmp", JSON.stringify(state));
  fs.renameSync(STATE_PATH + ".tmp", STATE_PATH);
};
// label -> { depositor, value, queuedAt, denied, reason, approved }

// ---------- blocklist ----------
let blocked = new Map();
let ofacAt = 0;
async function refreshBlocklist() {
  const next = new Map();
  let text = "";
  if (Date.now() - ofacAt > 24 * 3600_000) {
    try {
      const r = await fetch(OFAC_URL, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        text = await r.text();
        fs.writeFileSync(OFAC_CACHE, text);
        ofacAt = Date.now();
      }
    } catch (e) {
      log("OFAC fetch failed, using cache:", e.message);
    }
  }
  if (!text) {
    try {
      text = fs.readFileSync(OFAC_CACHE, "utf8");
    } catch {}
  }
  for (const a of parseAddressList(text)) next.set(a, "OFAC sanctioned address");
  for (const f of [BLOCKLIST_PATH, EXTRA_BLOCKLIST_PATH].filter(Boolean)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(f, "utf8"))) next.set(e.address.toLowerCase(), `ZeroPrint blocklist: ${e.reason}`);
    } catch {}
  }
  blocked = next;
}

// ---------- sync ----------
async function sync(head) {
  for (let from = BigInt(state.lastBlock + 1); from <= head; ) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const [deps, queued, denied, approved] = await Promise.all([
      pub.getLogs({ address: D.pool, event: DEPOSITED, fromBlock: from, toBlock: to }),
      pub.getLogs({ address: D.asp, event: ASP[0], fromBlock: from, toBlock: to }),
      pub.getLogs({ address: D.asp, event: ASP[1], fromBlock: from, toBlock: to }),
      pub.getLogs({ address: D.asp, event: ASP[2], fromBlock: from, toBlock: to }),
    ]);
    for (const l of deps) {
      const k = l.args._label.toString();
      state.deposits[k] ??= { depositor: l.args._depositor.toLowerCase(), value: l.args._value.toString() };
    }
    for (const l of queued) (state.deposits[l.args._label.toString()] ??= {}).queuedAt = Number(l.args._at);
    for (const l of denied) Object.assign((state.deposits[l.args._label.toString()] ??= {}), { denied: true, reason: l.args._reason });
    for (const l of approved) (state.deposits[l.args._label.toString()] ??= {}).approved = true;
    state.lastBlock = Number(to);
    from = to + 1n;
  }
}

/** Simulate first: the contract is the judge (its clock, its rules). Returns null if it would revert. */
async function send(functionName, args) {
  try {
    const { request } = await pub.simulateContract({ address: D.asp, abi: ASP, functionName, args, account: me });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`reverted ${hash}`);
    return hash;
  } catch (e) {
    log(`${functionName} skipped:`, e.shortMessage?.split("\n")[0] ?? e.message);
    return null;
  }
}

let window = null;
let isGuardian = false;
let lastTick = { at: 0, ok: false, error: null };
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    window ??= Number(await pub.readContract({ address: D.asp, abi: ASP, functionName: "WINDOW" }));
    isGuardian = (await pub.readContract({ address: D.asp, abi: ASP, functionName: "guardian" })).toLowerCase() === me.address.toLowerCase();
    await refreshBlocklist();
    const block = await pub.getBlock();
    await sync(block.number);
    // chain time, which is what the contract judges windows by
    const now = Number(block.timestamp);
    const all = Object.entries(state.deposits).filter(([, d]) => d.depositor);

    // 1. queue new deposits
    const toQueue = all.filter(([, d]) => !d.queuedAt && !d.denied && !d.approved).map(([k]) => BigInt(k));
    for (let i = 0; i < toQueue.length; i += BATCH) {
      const h = await send("queueMany", [toQueue.slice(i, i + BATCH)]);
      if (h) log("queued", toQueue.slice(i, i + BATCH).length, h);
    }
    if (toQueue.length) await sync((await pub.getBlock()).number);

    // 2. deny blocklisted depositors while their window is open
    if (isGuardian) {
      for (const [k, d] of all) {
        const reason = blocked.get(d.depositor);
        if (!reason || d.denied || d.approved) continue;
        if (d.queuedAt && now >= d.queuedAt + window) continue; // too late: the contract would refuse
        const h = await send("deny", [BigInt(k), reason]);
        if (!h) continue;
        Object.assign(d, { denied: true, reason });
        log("denied", k.slice(0, 12), reason, h);
      }
    }

    // 3. approve deposits whose window has passed
    const ready = all.filter(([, d]) => d.queuedAt && !d.denied && !d.approved && now >= d.queuedAt + window).map(([k]) => BigInt(k));
    for (let i = 0; i < ready.length; i += BATCH) {
      const h = await send("approve", [ready.slice(i, i + BATCH)]);
      if (h) log("approved", ready.slice(i, i + BATCH).length, h);
    }
    if (ready.length) await sync((await pub.getBlock()).number);
    save();
    lastTick = { at: Date.now(), ok: true, error: null };
  } catch (e) {
    lastTick = { at: Date.now(), ok: false, error: e.shortMessage || e.message };
    log("tick failed:", lastTick.error);
  } finally {
    busy = false;
  }
}

// ---------- API: counts for the site (the app itself reads the contract) ----------
const counts = () => {
  const ds = Object.values(state.deposits).filter((d) => d.depositor);
  return {
    chainId: D.chainId,
    delaySec: window,
    deposits: ds.length,
    approved: ds.filter((d) => d.approved).length,
    pending: ds.filter((d) => !d.approved && !d.denied).length,
    denied: ds.filter((d) => d.denied).length,
    lastBlock: state.lastBlock,
    onchainAsp: true,
  };
};
const routes = {
  "/stats": counts,
  "/health": () => ({ ...lastTick, keeper: me.address, guardian: isGuardian }),
};
http
  .createServer((req, res) => {
    const route = routes[new URL(req.url, "http://x").pathname];
    if (req.method !== "GET" || !route) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(route()));
  })
  .listen(PORT, HOST, () => log(`ZeroPrint keeper on ${HOST}:${PORT} as ${me.address}`));

await tick();
setInterval(tick, POLL_SEC * 1000);
