// ShadePool ASP: watches deposits, waits DELAY_SEC, screens depositors against OFAC + our
// blocklist, and posts the association-set root on-chain with the postman key.
// The UI downloads the whole set and checks its own labels locally, so we never learn
// which deposit a visitor owns.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, http as viemHttp, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aspRoot, cidV1Raw, decide, parseAddressList, setDocument } from "./lib.mjs";

const env = (k, d) => process.env[k] ?? d;
const RPC_URL = env("RPC_URL");
const DEPLOYMENT = JSON.parse(fs.readFileSync(env("DEPLOYMENT"), "utf8"));
const DATA_DIR = env("DATA_DIR");
const DELAY_SEC = Number(env("DELAY_SEC", "3600"));
const POLL_SEC = Number(env("POLL_SEC", "60"));
const PORT = Number(env("PORT", "8922"));
const HOST = env("HOST", "127.0.0.1");
const LOG_CHUNK = BigInt(env("LOG_CHUNK", "5000"));
const OFAC_URL = env(
  "OFAC_URL",
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt",
);
const BLOCKLIST_PATH = env("BLOCKLIST_PATH", path.join(import.meta.dirname, "blocklist.json"));
const EXTRA_BLOCKLIST_PATH = env("EXTRA_BLOCKLIST_PATH", "");

fs.mkdirSync(path.join(DATA_DIR, "sets"), { recursive: true });
const STATE_PATH = path.join(DATA_DIR, "state.json");
const OFAC_CACHE = path.join(DATA_DIR, "ofac-eth.txt");

const chain = defineChain({
  id: DEPLOYMENT.chainId,
  name: `shadepool-${DEPLOYMENT.chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: viemHttp(RPC_URL) });
const postman = privateKeyToAccount(env("POSTMAN_PK"));
const wallet = createWalletClient({ chain, account: postman, transport: viemHttp(RPC_URL) });

const DEPOSITED = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);
const RAGEQUIT = parseAbiItem("event Ragequit(address indexed _ragequitter, uint256 _commitment, uint256 _label, uint256 _value)");
const ENTRYPOINT_ABI = [
  parseAbiItem("function latestRoot() view returns (uint256)"),
  parseAbiItem("function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)"),
];

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- state ----------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastBlock: DEPLOYMENT.startBlock - 1, deposits: {}, approved: [], posted: null };
  }
}
function saveState() {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_PATH);
}
const state = loadState();

// ---------- blocklist ----------
let blocked = new Map();
let ofacLoadedAt = 0;

async function refreshBlocklist() {
  const next = new Map();
  let ofacText = "";
  if (Date.now() - ofacLoadedAt > 24 * 3600 * 1000) {
    try {
      const r = await fetch(OFAC_URL, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ofacText = await r.text();
      fs.writeFileSync(OFAC_CACHE, ofacText);
      ofacLoadedAt = Date.now();
    } catch (e) {
      log("OFAC fetch failed, using cache:", e.message);
    }
  }
  if (!ofacText) {
    try {
      ofacText = fs.readFileSync(OFAC_CACHE, "utf8");
    } catch {}
  }
  for (const a of parseAddressList(ofacText)) next.set(a, "OFAC sanctioned address");
  for (const file of [BLOCKLIST_PATH, EXTRA_BLOCKLIST_PATH].filter(Boolean)) {
    try {
      for (const e of JSON.parse(fs.readFileSync(file, "utf8"))) {
        next.set(e.address.toLowerCase(), `ShadePool blocklist: ${e.reason}`);
      }
    } catch (e) {
      log(`blocklist ${file} unreadable:`, e.message);
    }
  }
  blocked = next;
}

// ---------- chain sync ----------
const blockTs = new Map();
async function timestampOf(blockNumber) {
  if (!blockTs.has(blockNumber)) {
    const b = await pub.getBlock({ blockNumber });
    blockTs.set(blockNumber, Number(b.timestamp));
  }
  return blockTs.get(blockNumber);
}

async function syncDeposits() {
  const head = await pub.getBlockNumber();
  let from = BigInt(state.lastBlock + 1);
  while (from <= head) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const [deps, rqs] = await Promise.all([
      pub.getLogs({ address: DEPLOYMENT.pool, event: DEPOSITED, fromBlock: from, toBlock: to }),
      pub.getLogs({ address: DEPLOYMENT.pool, event: RAGEQUIT, fromBlock: from, toBlock: to }),
    ]);
    for (const l of deps) {
      const label = l.args._label.toString();
      if (state.deposits[label]) continue;
      state.deposits[label] = {
        depositor: l.args._depositor,
        value: l.args._value.toString(),
        block: Number(l.blockNumber),
        ts: await timestampOf(l.blockNumber),
        tx: l.transactionHash,
        status: "pending",
      };
      log("deposit", label.slice(0, 12), l.args._depositor, l.args._value.toString());
    }
    for (const l of rqs) {
      const d = state.deposits[l.args._label.toString()];
      if (d) d.ragequit = true;
    }
    state.lastBlock = Number(to);
    from = to + 1n;
  }
}

function screen(now) {
  const approved = new Set(state.approved);
  for (const [label, d] of Object.entries(state.deposits)) {
    if (d.status === "denied") continue; // final
    const r = decide(d, now, DELAY_SEC, blocked);
    if (d.status === "approved") {
      if (r.status !== "denied") continue;
      // depositor got listed after approval: revoke so it can only ragequit
      approved.delete(label);
      Object.assign(d, { status: "denied", reason: `Revoked: ${r.reason}`, decidedAt: now });
      log("revoked", label.slice(0, 12), r.reason);
      continue;
    }
    Object.assign(d, { status: r.status, reason: r.reason, eta: r.eta });
    if (r.status === "pending") continue;
    d.decidedAt = now;
    if (r.status === "approved") approved.add(label);
    log(r.status, label.slice(0, 12), r.reason ?? "");
  }
  // keep approval order stable: existing order first, new labels appended
  state.approved = [...state.approved.filter((l) => approved.has(l)), ...[...approved].filter((l) => !state.approved.includes(l))];
}

async function publishRoot() {
  if (!state.approved.length) return;
  const root = aspRoot(state.approved);
  const doc = setDocument(root, state.approved);
  const cid = cidV1Raw(doc);
  fs.writeFileSync(path.join(DATA_DIR, "sets", `${cid}.json`), doc);

  let onchain = 0n;
  try {
    onchain = await pub.readContract({ address: DEPLOYMENT.entrypoint, abi: ENTRYPOINT_ABI, functionName: "latestRoot" });
  } catch {}
  if (onchain === root) {
    state.posted = { root: root.toString(), cid, labels: state.approved.length, at: state.posted?.at ?? Date.now() };
    return;
  }
  const hash = await wallet.writeContract({
    address: DEPLOYMENT.entrypoint,
    abi: ENTRYPOINT_ABI,
    functionName: "updateRoot",
    args: [root, cid],
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`updateRoot reverted ${hash}`);
  state.posted = { root: root.toString(), cid, labels: state.approved.length, at: Date.now(), tx: hash };
  log("root posted", root.toString().slice(0, 16), cid, `${state.approved.length} labels`, hash);
}

let lastTick = { at: 0, ok: false, error: null };
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshBlocklist();
    await syncDeposits();
    screen(Math.floor(Date.now() / 1000));
    await publishRoot();
    saveState();
    lastTick = { at: Date.now(), ok: true, error: null };
  } catch (e) {
    lastTick = { at: Date.now(), ok: false, error: e.shortMessage || e.message };
    log("tick failed:", lastTick.error);
  } finally {
    ticking = false;
  }
}

// ---------- API ----------
function setView() {
  // Only labels that are in the on-chain root are useful for proofs
  const posted = state.posted;
  return {
    root: posted?.root ?? null,
    cid: posted?.cid ?? null,
    labels: posted ? state.approved.slice(0, posted.labels) : [],
    updatedAt: posted?.at ?? null,
  };
}

const routes = {
  "/set": () => setView(),
  "/denied": () =>
    Object.entries(state.deposits)
      .filter(([, d]) => d.status === "denied")
      .map(([label, d]) => ({ label, reason: d.reason })),
  "/pending": () =>
    Object.entries(state.deposits)
      .filter(([, d]) => d.status === "pending")
      .map(([label, d]) => ({ label, eta: d.eta ?? d.ts + DELAY_SEC })),
  "/stats": () => {
    const all = Object.values(state.deposits);
    return {
      chainId: DEPLOYMENT.chainId,
      delaySec: DELAY_SEC,
      deposits: all.length,
      approved: state.approved.length,
      pending: all.filter((d) => d.status === "pending").length,
      denied: all.filter((d) => d.status === "denied").length,
      lastBlock: state.lastBlock,
    };
  },
  "/health": () => ({ ...lastTick, postman: postman.address }),
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const route = routes[url.pathname];
    if (req.method !== "GET" || !route) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(route()));
  })
  .listen(PORT, HOST, () => log(`ShadePool ASP on ${HOST}:${PORT}, delay ${DELAY_SEC}s, postman ${postman.address}`));

await tick();
setInterval(tick, POLL_SEC * 1000);
