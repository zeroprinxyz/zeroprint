// ZeroPrint end-to-end on the LOCAL Anvil chain with the ZeroPrintASP contract and real proofs:
//   1. keeper on: deposit -> keeper queues -> keeper denies a blocklisted depositor -> keeper
//      approves after the window -> private withdraw via the relayer -> ragequit of the denied one
//   2. keeper off: deposit -> the depositor queues and approves from its own wallet -> withdraw
//   3. restore from the Zero Key
// Expects a fresh DeployZeroPrint deployment (ASP_WINDOW=60) in deployments/zeroprint-31337.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert/strict";
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createShade, settle } from "../ui/src/core.js";

const HOME = process.env.HOME;
const ROOT = `${HOME}/shadepool`;
const RPC = "http://127.0.0.1:8923";
const NODE = process.execPath;
const deployment = JSON.parse(fs.readFileSync(`${ROOT}/packages/contracts/deployments/zeroprint-31337.json`, "utf8"));
const keys = Object.fromEntries(
  fs.readFileSync(`${ROOT}/shade/local/anvil-keys.txt`, "utf8").trim().split("\n").map((l) => {
    const [i, a, pk] = l.split(" ");
    return [i, { a, pk }];
  }),
);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a relayer and a keeper for this deployment
const work = `${ROOT}/shade/e2e/zp-work`;
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(
  `${work}/relayer.json`,
  JSON.stringify({
    defaults: { fee_receiver_address: keys["2"].a, signer_private_key: keys["2"].pk, entrypoint_address: deployment.entrypoint },
    chains: [
      {
        chain_id: "31337",
        chain_name: "zp-e2e",
        rpc_url: RPC,
        max_gas_price: "100000000000",
        native_currency: { name: "Ether", symbol: "ETH", decimals: 18 },
        supported_assets: [{ asset_address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", asset_name: "Ether", fee_bps: "0", min_withdraw_amount: "500000000000000" }],
      },
    ],
    sqlite_db_path: `${work}/relayer.sqlite`,
    cors_allow_all: true,
    allowed_domains: [],
  }),
);
fs.writeFileSync(`${work}/blocklist.json`, JSON.stringify([{ address: keys["5"].a, reason: "e2e blocklisted wallet" }]));
const children = [];
const start = (file, env, cwd) => {
  const c = spawn(NODE, [file], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (b) => process.env.VERBOSE && process.stdout.write(`  · ${b}`));
  c.stderr.on("data", (b) => process.env.VERBOSE && process.stdout.write(`  ! ${b}`));
  children.push(c);
  return c;
};
start("start.mjs", { CONFIG_PATH: `${work}/relayer.json`, SHADE_RELAYER_PORT: "8925" }, `${ROOT}/shade/relayer`);
let keeper = start(
  "keeper.mjs",
  {
    RPC_URL: RPC,
    DEPLOYMENT: `${ROOT}/packages/contracts/deployments/zeroprint-31337.json`,
    DATA_DIR: `${work}/keeper`,
    KEEPER_PK: keys["1"].pk,
    EXTRA_BLOCKLIST_PATH: `${work}/blocklist.json`,
    POLL_SEC: "4",
    PORT: "8926",
  },
  `${ROOT}/shade/asp`,
);
process.on("exit", () => children.forEach((c) => c.kill()));
await sleep(4000);

const shade = createShade({
  rpcUrl: RPC,
  deployment,
  aspUrl: "http://127.0.0.1:8926",
  relayerUrl: "http://127.0.0.1:8925/relayer",
  circuits: { browser: false },
});
assert.ok(shade.onchainAsp, "deployment must have an ASP contract");
const { pub, chain } = shade;
const wallet = (pk) => createWalletClient({ chain, account: privateKeyToAccount(pk), transport: http(RPC) });
async function send(w, tx) {
  const hash = await w.sendTransaction(tx);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `tx failed ${hash}`);
  await settle();
  return r;
}
async function waitFor(what, fn, ms = 4 * 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(3000);
    await pub.request({ method: "evm_mine", params: [] }); // Anvil only makes blocks on transactions
  }
}
const noteOf = async (key) => (await shade.notes(await shade.loadAccount(key)))[0];

// ---------- 1. keeper on ----------
const aliceKey = generateMnemonic(english);
const daveKey = generateMnemonic(english);
const A = wallet(keys["3"].pk);
const Dv = wallet(keys["5"].pk);
await send(A, shade.depositTx(await shade.loadAccount(aliceKey), parseEther("0.1")));
await send(Dv, shade.depositTx(await shade.loadAccount(daveKey), parseEther("0.01")));
log("deposits sent");

await waitFor("dave denied by the keeper (guardian)", async () => (await noteOf(daveKey)).state === "denied");
log("dave denied OK:", (await noteOf(daveKey)).reason);
let aNote = await waitFor("alice approved by the keeper", async () => {
  const n = await noteOf(aliceKey);
  return n.state === "approved" && n;
});
log("alice approved OK (on-chain set)");

const B = privateKeyToAccount(generatePrivateKey()).address;
const alice = await shade.loadAccount(aliceKey);
[aNote] = await shade.notes(alice);
const w1 = await shade.withdraw(alice, aNote, parseEther("0.04"), B);
await pub.waitForTransactionReceipt({ hash: w1.txHash });
await settle();
assert.ok((await pub.getBalance({ address: B })) > 0n);
assert.equal(await pub.getTransactionCount({ address: B }), 0);
log(`private withdraw OK: B got ${formatEther(await pub.getBalance({ address: B }))} ETH, B sent no tx`);

const dNote = await noteOf(daveKey);
const before = await pub.getBalance({ address: Dv.account.address });
const rq = await send(Dv, await shade.ragequitTx(dNote));
assert.equal((await pub.getBalance({ address: Dv.account.address })) - before + rq.gasUsed * rq.effectiveGasPrice, parseEther("0.01"));
log("ragequit of the denied deposit OK");

// ---------- 2. keeper off: the depositor does it ----------
keeper.kill();
await sleep(1000);
log("keeper stopped");
const bobKey = generateMnemonic(english);
const Bo = wallet(keys["4"].pk);
await send(Bo, shade.depositTx(await shade.loadAccount(bobKey), parseEther("0.05")));
let bNote = await noteOf(bobKey);
assert.equal(bNote.state, "unqueued");
const q = await shade.aspActionTx([bNote], Bo.account.address);
assert.equal(q.kind, "queue");
await send(Bo, q);
bNote = await noteOf(bobKey);
assert.equal(bNote.state, "pending");
log("bob queued his own deposit from his deposit wallet; waiting for the window");
const ap = await waitFor("bob's window", async () => {
  const n = await noteOf(bobKey);
  return shade.aspActionTx([n], Bo.account.address).then((t) => t?.kind === "approve" && t);
});
await send(Bo, ap);
bNote = await noteOf(bobKey);
assert.equal(bNote.state, "approved");
log("bob approved his own deposit (no keeper, no server)");
// a fresh wallet must never be the one that approves
assert.equal(await shade.aspActionTx([bNote], privateKeyToAccount(generatePrivateKey()).address), null);

const C = privateKeyToAccount(generatePrivateKey()).address;
const bob = await shade.loadAccount(bobKey);
[bNote] = await shade.notes(bob);
const w2 = await shade.withdraw(bob, bNote, parseEther("0.05"), C);
await pub.waitForTransactionReceipt({ hash: w2.txHash });
log(`private withdraw without keeper OK: C got ${formatEther(await pub.getBalance({ address: C }))} ETH`);

// ---------- 3. restore ----------
await settle();
assert.equal((await noteOf(aliceKey)).withdrawals, 1);
assert.equal((await noteOf(daveKey)).state, "ragequit");
log("restore from Zero Key OK");
log("E2E ZEROPRINT PASSED");
process.exit(0);
