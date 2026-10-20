// ShadePool end-to-end on the LOCAL Anvil chain with real Groth16 proofs:
// deposit -> ASP approves after the delay -> private withdraw via relayer (partial, twice)
// -> blocklisted deposit is denied -> ragequit -> restore from the Shade Key.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { english, generateMnemonic, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createShade, settle } from "../ui/src/core.js";

const HOME = process.env.HOME;
const deployment = JSON.parse(fs.readFileSync(`${HOME}/shadepool/packages/contracts/deployments/shade-31337.json`, "utf8"));
const keys = Object.fromEntries(
  fs.readFileSync(`${HOME}/shadepool/shade/local/anvil-keys.txt`, "utf8").trim().split("\n").map((l) => {
    const [i, , pk] = l.split(" ");
    return [i, pk];
  }),
);
const shade = createShade({
  rpcUrl: "http://127.0.0.1:8923",
  deployment,
  aspUrl: "http://127.0.0.1:8922",
  relayerUrl: "http://127.0.0.1:8921/relayer",
  circuits: { browser: false },
});
const { pub, chain } = shade;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const wallet = (pk) => createWalletClient({ chain, account: privateKeyToAccount(pk), transport: http(chain.rpcUrls.default.http[0]) });

async function send(w, tx) {
  const hash = await w.sendTransaction(tx);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `tx failed ${hash}`);
  await settle();
  return r;
}

async function waitFor(label, fn, timeoutMs = 9 * 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// --- 1. Alice deposits 0.1 ETH from wallet A, Dave deposits 0.01 from the blocklisted wallet #5
const aliceKey = generateMnemonic(english);
const daveKey = generateMnemonic(english);
const A = wallet(keys["3"]);
const D = wallet(keys["5"]);

let alice = await shade.loadAccount(aliceKey);
await send(A, shade.depositTx(alice, parseEther("0.1")));
let dave = await shade.loadAccount(daveKey);
await send(D, shade.depositTx(dave, parseEther("0.01")));
log("deposits sent");

alice = await shade.loadAccount(aliceKey);
let [aNote] = await shade.notes(alice);
assert.equal(aNote.deposited, parseEther("0.1"));
log("alice note", aNote.state, "label", aNote.label.slice(0, 12));

// --- 2. ASP: Dave denied right away, Alice approved after the delay
await waitFor("dave denied", async () => (await shade.notes(await shade.loadAccount(daveKey)))[0].state === "denied");
log("dave denied OK");
aNote = await waitFor("alice approved", async () => {
  const [n] = await shade.notes(await shade.loadAccount(aliceKey));
  return n.state === "approved" && n;
});
log("alice approved OK");

// --- 3. Private withdraw 0.04 to a brand-new address B (no gas on B)
const B = privateKeyToAccount(generatePrivateKey()).address;
alice = await shade.loadAccount(aliceKey);
[aNote] = await shade.notes(alice);
const w1 = await shade.withdraw(alice, aNote, parseEther("0.04"), B, (s) => log("withdraw step", s));
await pub.waitForTransactionReceipt({ hash: w1.txHash });
await settle();
const balB = await pub.getBalance({ address: B });
assert.ok(balB > 0n && balB <= parseEther("0.04"));
assert.equal(await pub.getTransactionCount({ address: B }), 0, "B never sent a tx");
log(`B got ${formatEther(balB)} ETH, fee ${w1.feeBPS} bps, tx ${w1.txHash}`);

// --- 4. Partial again: the change note (same label) withdraws the rest to C
alice = await shade.loadAccount(aliceKey);
[aNote] = await shade.notes(alice);
assert.equal(aNote.balance, parseEther("0.06"), "change note holds the rest");
const C = privateKeyToAccount(generatePrivateKey()).address;
const w2 = await shade.withdraw(alice, aNote, aNote.balance, C);
await pub.waitForTransactionReceipt({ hash: w2.txHash });
await settle();
log(`C got ${formatEther(await pub.getBalance({ address: C }))} ETH`);

// --- 5. Dave ragequits back to wallet #5
dave = await shade.loadAccount(daveKey);
const [dNote] = await shade.notes(dave);
const before = await pub.getBalance({ address: D.account.address });
const rq = await send(D, await shade.ragequitTx(dNote));
const after = await pub.getBalance({ address: D.account.address });
assert.equal(after - before + rq.gasUsed * rq.effectiveGasPrice, parseEther("0.01"));
log("dave ragequit OK, 0.01 ETH back to", D.account.address);

// --- 6. Restore both from the 12 words only
const [ra] = await shade.notes(await shade.loadAccount(aliceKey));
const [rd] = await shade.notes(await shade.loadAccount(daveKey));
assert.equal(ra.state, "spent");
assert.equal(ra.withdrawals, 2);
assert.equal(rd.state, "ragequit");
log("restore from Shade Key OK");
log("E2E PASSED");
process.exit(0);
