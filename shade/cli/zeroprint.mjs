#!/usr/bin/env node
// ZeroPrint CLI: your deposits, private withdrawals, approvals and ragequit, straight against the
// chain. No website, no ZeroPrint server, no keeper needed. Proofs are made on this computer.
//
//   zeroprint status                         list your deposits (asks for your Zero Key)
//   zeroprint approve                        queue/approve your deposits yourself (asks for the
//                                            DEPOSIT wallet's key; never use a fresh wallet)
//   zeroprint withdraw <eth> --to <0x…>      private withdraw through a relayer
//   zeroprint withdraw <eth> --direct        no relayer: the wallet whose key you give pays the gas
//                                            and receives the ETH
//   zeroprint ragequit [--deposit N]         public exit back to the depositing wallet
//
// Options: --network mainnet|testnet|local (default mainnet), --rpc <url>, --relayer <url>
// Secrets can also come from ZEROPRINT_KEY (12 words) and WALLET_KEY (0x… private key).
import fs from "node:fs";
import readline from "node:readline";
import { createWalletClient, formatEther, getAddress, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createShade, settle } from "../ui/src/core.js";

// quiet the SDK's info logs ("… [Account::INFO] …"): this is a terminal tool
for (const k of ["info", "debug"]) console[k] = () => {};
const print = console.log.bind(console);
console.log = (...a) => {
  if (typeof a[0] === "string" && /\[(Account|Data|Withdrawal|Commitment|Circuits)::/.test(a[0])) return;
  print(...a);
};

const NETWORKS = JSON.parse(fs.readFileSync(new URL("./networks.json", import.meta.url), "utf8"));

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
        else rl.output.write("*");
      };
    }
    rl.question(question, (ans) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(ans.trim());
    });
  });
}

const eth = (wei) => formatEther(wei);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

const a = args(process.argv.slice(2));
const cmd = a._[0];
if (!cmd || a.help || !["status", "approve", "withdraw", "ragequit"].includes(cmd)) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(cmd ? 1 : 0);
}

const net = NETWORKS[a.network ?? "mainnet"];
if (!net) fail(`unknown network ${a.network}; use ${Object.keys(NETWORKS).join(", ")}`);
if (!net.deployment) fail(`ZeroPrint is not deployed on ${a.network ?? "mainnet"} yet`);
const rpcUrl = a.rpc ?? net.rpc;
const shade = createShade({
  rpcUrl,
  chainName: net.name,
  deployment: net.deployment,
  aspUrl: net.asp ?? "",
  relayerUrl: a.relayer ?? net.relayer,
  circuits: { browser: false },
});
const { pub, chain } = shade;
console.log(`ZeroPrint · ${net.name} · pool ${net.deployment.pool}`);

async function zeroKey() {
  const k = process.env.ZEROPRINT_KEY ?? (await ask("Zero Key (12 words): ", { hidden: true }));
  if (k.split(/\s+/).length !== 12) fail("a Zero Key is 12 words");
  return k.toLowerCase().split(/\s+/).join(" ");
}
async function walletKey(prompt) {
  const k = process.env.WALLET_KEY ?? (await ask(prompt, { hidden: true }));
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) fail("expected a 0x… private key");
  const account = privateKeyToAccount(k);
  return createWalletClient({ chain, account, transport: http(rpcUrl) });
}
async function sendTx(w, tx) {
  const hash = await w.sendTransaction(tx);
  process.stdout.write(`  tx ${hash} … `);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") fail("transaction reverted");
  console.log("confirmed");
  await settle();
  return hash;
}

console.log("Reading the chain…");
const key = await zeroKey();
const acct = await shade.loadAccount(key);
let notes = await shade.notes(acct);

function table() {
  if (!notes.length) return console.log("No deposits for this Zero Key.");
  const now = Math.floor(Date.now() / 1000);
  notes.forEach((n, i) => {
    const wait = n.state === "pending" && n.eta ? ` (window ends in ${Math.max(0, Math.ceil((n.eta - now) / 60))} min)` : "";
    const st = { approved: "approved", pending: "waiting", unqueued: "not queued", denied: `denied: ${n.reason}`, spent: "spent", ragequit: "ragequit" }[n.state] ?? n.state;
    console.log(`  #${i + 1}  ${eth(n.balance).padEnd(10)} ETH of ${eth(n.deposited)}  ${st}${wait}`);
  });
}

if (cmd === "status") {
  table();
  process.exit(0);
}

if (cmd === "approve") {
  if (!shade.onchainAsp) fail("this deployment's ASP is a server; there is nothing to approve yourself");
  const w = await walletKey("Key of the wallet that made the deposits: ");
  const tx = await shade.aspActionTx(notes, w.account.address);
  if (!tx) {
    table();
    console.log("Nothing to do for this wallet now (not its deposits, still waiting, or already approved).");
    process.exit(0);
  }
  console.log(`${tx.kind === "queue" ? "Queueing" : "Approving"} ${tx.count} deposit(s) from ${w.account.address}`);
  await sendTx(w, tx);
  notes = await shade.notes(await shade.loadAccount(key));
  table();
  process.exit(0);
}

const pick = async (filter, what) => {
  const ok = notes.map((n, i) => ({ n, i })).filter(({ n }) => filter(n));
  if (!ok.length) fail(`no deposit can ${what} right now`);
  if (a.deposit) {
    const n = notes[Number(a.deposit) - 1];
    if (!n || !filter(n)) fail(`deposit #${a.deposit} cannot ${what}`);
    return n;
  }
  if (ok.length === 1) return ok[0].n;
  table();
  const i = Number(await ask(`Which deposit (#)? `)) - 1;
  if (!notes[i] || !filter(notes[i])) fail("that deposit cannot do this");
  return notes[i];
};

if (cmd === "withdraw") {
  const amount = parseEther(String(a._[1] ?? "0"));
  if (amount <= 0n) fail("usage: zeroprint withdraw <eth> --to <0x…>  (or --direct)");
  const n = await pick((x) => x.state === "approved" && x.balance >= amount, "pay this amount");
  const step = (s) => console.log(`  … ${{ quote: "relayer quote", trees: "rebuilding the trees", prove: "making the proof (local)", relay: "relayer submits" }[s] ?? s}`);
  if (a.direct) {
    const w = await walletKey("Key of the wallet that pays the gas and receives the ETH: ");
    console.log(`Direct withdraw of ${eth(amount)} ETH to ${w.account.address} (it pays the gas)`);
    await sendTx(w, await shade.withdrawDirectTx(acct, n, amount, w.account.address, step));
  } else {
    if (!isAddress(a.to ?? "")) fail("--to <fresh address> is required (or use --direct)");
    if (!shade.chain || !(a.relayer ?? net.relayer)) fail("no relayer for this network: pass --relayer <url> or use --direct");
    const r = await shade.withdraw(acct, n, amount, getAddress(a.to), step);
    console.log(`  tx ${r.txHash}`);
    await pub.waitForTransactionReceipt({ hash: r.txHash });
    console.log(`✓ ${eth(amount)} ETH (minus ${Number(r.feeBPS) / 100}% gas fee) sent to ${a.to}`);
  }
  process.exit(0);
}

if (cmd === "ragequit") {
  const n = await pick((x) => x.balance > 0n && x.state !== "ragequit", "ragequit");
  const w = await walletKey("Key of the wallet that made this deposit: ");
  console.log(`Ragequit: ${eth(n.balance)} ETH back to ${w.account.address} (public)`);
  await sendTx(w, await shade.ragequitTx(n));
  process.exit(0);
}
