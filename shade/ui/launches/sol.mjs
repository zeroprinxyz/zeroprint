// Solana launches by a creator: reads the wallet's recent transactions and decodes the same
// launch events: pump.fun CreateEvent, LaunchLab
// PoolCreateEvent and Meteora DBC pool initialisation.
import { createHash } from "node:crypto";
import { createSolRpc } from "./solrpc.mjs";

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const disc = (name) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8).toString("hex");
const D_CREATE = disc("CreateEvent");
const D_POOL_CREATE = disc("PoolCreateEvent");

const MAX_SIGS = Number(process.env.SOL_LAUNCH_SIGS ?? 600);

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function bs58(buf) {
  let n = BigInt(`0x${Buffer.from(buf).toString("hex") || "0"}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

class Reader {
  constructor(buf) {
    this.b = buf;
    this.o = 8;
  }
  pk() {
    const v = bs58(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return v;
  }
  u8() {
    return this.b[this.o++];
  }
  i64() {
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return Number(v);
  }
  str() {
    const n = this.b.readUInt32LE(this.o);
    this.o += 4;
    const s = this.b.subarray(this.o, this.o + n).toString("utf8");
    this.o += n;
    return s;
  }
}

/** [programId, base64 data] for every "Program data:" log line, attributed to the program on top of the stack. */
export function programData(logs) {
  const stack = [];
  const out = [];
  for (const line of logs ?? []) {
    let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith("Program data: ")) out.push([stack[stack.length - 1], line.slice(14)]);
  }
  return out;
}

const allIxs = (tx) => [
  ...(tx.transaction?.message?.instructions ?? []),
  ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
];

/** @param sol a shared client from createSolRpc(), or an RPC URL */
export function createSolScanner(sol) {
  const solRpc = typeof sol === "string" ? createSolRpc(sol) : sol;

  function decode(tx, sig, creator) {
    const found = [];
    const ts = tx.blockTime ?? null;
    for (const [prog, b64] of programData(tx.meta?.logMessages)) {
      const buf = Buffer.from(b64, "base64");
      const tag = buf.subarray(0, 8).toString("hex");
      try {
        if (prog === PUMP && tag === D_CREATE) {
          const r = new Reader(buf);
          const name = r.str();
          const symbol = r.str();
          r.str(); // uri
          const mint = r.pk();
          r.pk(); // bonding curve
          r.pk(); // user
          const who = r.pk();
          if (who === creator) found.push({ chain: "solana", token: mint, name, symbol, launchpad: "pump.fun", ts, tx: sig });
        } else if (prog === LAUNCHLAB && tag === D_POOL_CREATE) {
          const r = new Reader(buf);
          r.pk(); // pool
          const who = r.pk();
          r.pk(); // config
          r.u8(); // decimals
          const name = r.str();
          const symbol = r.str();
          if (who !== creator) continue;
          const init = allIxs(tx).find((i) => /^initializeMint2?$/.test(i.parsed?.type ?? ""));
          found.push({ chain: "solana", token: init?.parsed?.info?.mint ?? null, name, symbol, launchpad: "LaunchLab", ts, tx: sig });
        }
      } catch {
        /* an event layout we don't know: skip it */
      }
    }
    const dbc = allIxs(tx).find((i) => i.programId === DBC && i.accounts?.length >= 12);
    if (dbc && dbc.accounts[2] === creator) {
      const mint = dbc.accounts[3];
      const meta = allIxs(tx).find((i) => i.parsed?.type === "initializeTokenMetadata" && i.parsed.info?.mint === mint)?.parsed.info;
      found.push({ chain: "solana", token: mint, name: meta?.name ?? "", symbol: meta?.symbol ?? "", launchpad: "Meteora DBC", ts, tx: sig });
    }
    return found;
  }

  /** Launches created by `creator` among its most recent transactions. */
  return async function scan(creator, { maxSigs = MAX_SIGS } = {}) {
    const sigs = (await solRpc.signatures(creator, maxSigs)).map((s) => s.signature);
    const launches = [];
    const txs = await solRpc.transactions(sigs);
    txs.forEach((tx, i) => tx && launches.push(...decode(tx, sigs[i], creator)));
    const seen = new Set();
    return {
      scanned: sigs.length,
      partial: sigs.length >= maxSigs,
      launches: launches.filter((l) => !seen.has(l.token) && seen.add(l.token)),
    };
  };
}
