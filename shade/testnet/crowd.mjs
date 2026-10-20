// Testnet crowd: N fresh wallets, each funded by the FUNDER and making one small deposit at a
// random time inside WINDOW_MIN, so a tester's own deposit has company in the anonymity set.
// Keys + Shade Keys go to crowd.json (chmod 600, gitignored) so the funds can be withdrawn later.
// TESTNET ONLY.
import fs from "node:fs";
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createShade } from "../ui/src/core.js";

const N = Number(process.env.N ?? 60);
const AMOUNT = parseEther(process.env.AMOUNT ?? "0.001");
const GAS_BUFFER = parseEther(process.env.GAS_BUFFER ?? "0.00005");
const WINDOW_MIN = Number(process.env.WINDOW_MIN ?? 60);
const RPC = "https://rpc.testnet.chain.robinhood.com";
const DIR = import.meta.dirname;
const FILE = `${DIR}/crowd.json`;

const secrets = Object.fromEntries(
  fs.readFileSync(`${DIR}/secrets.env`, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
const deployment = JSON.parse(fs.readFileSync(`${process.env.HOME}/shadepool/packages/contracts/deployments/shade-46630.json`, "utf8"));
const shade = createShade({ rpcUrl: RPC, deployment, aspUrl: "http://127.0.0.1:8932", relayerUrl: "http://127.0.0.1:8931/relayer", circuits: { browser: false } });
const { pub, chain } = shade;
if ((await pub.getChainId()) !== 46630) throw new Error("not RH testnet");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const wallet = (pk) => createWalletClient({ chain, account: privateKeyToAccount(pk), transport: http(RPC) });
const save = (crowd) => fs.writeFileSync(FILE, JSON.stringify(crowd, null, 1), { mode: 0o600 });

// 1. wallets (resume-safe)
let crowd = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : [];
while (crowd.length < N) {
  const pk = generatePrivateKey();
  crowd.push({ address: privateKeyToAccount(pk).address, pk, shadeKey: generateMnemonic(english), funded: false, deposit: null });
}
save(crowd);

// 2. fund
const funder = wallet(secrets.FUNDER_PK);
const need = BigInt(crowd.filter((c) => !c.funded).length) * (AMOUNT + GAS_BUFFER);
const have = await pub.getBalance({ address: funder.account.address });
log(`funder ${funder.account.address} has ${formatEther(have)}, needs ${formatEther(need)}`);
if (have < need) throw new Error("funder balance too low");
let nonce = await pub.getTransactionCount({ address: funder.account.address });
const pending = [];
for (const c of crowd.filter((c) => !c.funded)) {
  pending.push({ c, hash: await funder.sendTransaction({ to: c.address, value: AMOUNT + GAS_BUFFER, nonce: nonce++ }) });
}
for (const { c, hash } of pending) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`fund failed ${hash}`);
  c.funded = true;
}
save(crowd);
log(`funded ${pending.length} wallets`);

// 3. deposits at random times across the window
const todo = crowd.filter((c) => !c.deposit);
const start = Date.now();
const plan = todo.map((c) => ({ c, at: start + Math.random() * WINDOW_MIN * 60_000 })).sort((a, b) => a.at - b.at);
log(`${plan.length} deposits over ${WINDOW_MIN} min`);
for (const [i, { c, at }] of plan.entries()) {
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    const acct = await shade.loadAccount(c.shadeKey);
    const hash = await wallet(c.pk).sendTransaction(shade.depositTx(acct, AMOUNT));
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error("reverted");
    c.deposit = { tx: hash, block: Number(r.blockNumber), at: new Date().toISOString() };
    save(crowd);
    log(`deposit ${i + 1}/${plan.length} ${c.address.slice(0, 8)} ${hash}`);
  } catch (e) {
    log(`deposit ${i + 1} FAILED ${c.address}: ${e.shortMessage || e.message}`);
  }
}
log(`done: ${crowd.filter((c) => c.deposit).length}/${crowd.length} deposited`);
process.exit(0);
