// Hop wallets carry a withdrawal from the pool to a bridge. A mistake here strands ETH on a hop,
// so these tests pin down the derivation and the gas arithmetic against a stubbed chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { DUST, HOP_GAS, hopAccount, hopReserve, hopScan, hopSend, nextHop } from "./hop.js";

const KEY = "test test test test test test test test test test test junk"; // the public Anvil phrase
const OTHER = generateMnemonic(english);
const TO = "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e";
const chain = { id: 4663 };

/** A chain where `state` gives each address its balance and nonce; everything else is empty. */
function stubChain(state = {}, { baseFee = 10_000_000n, tip = 0n, estimateGas = 21_000n } = {}) {
  const sent = [];
  const at = (a) => state[a.toLowerCase()] ?? { balance: 0n, nonce: 0 };
  return {
    sent,
    pub: {
      getBalance: async ({ address }) => at(address).balance,
      getTransactionCount: async ({ address }) => at(address).nonce,
      getBlock: async () => ({ baseFeePerGas: baseFee }),
      request: async () => `0x${tip.toString(16)}`,
      estimateGas: async () => estimateGas,
      sendRawTransaction: async ({ serializedTransaction }) => (sent.push(serializedTransaction), `0x${"a".repeat(64)}`),
      waitForTransactionReceipt: async () => ({ status: "success" }),
    },
  };
}
const have = (address, eth, nonce = 0) => ({ [address.toLowerCase()]: { balance: parseEther(eth), nonce } });

test("hops come from the Zero Key, are stable, and differ per index and per key", () => {
  assert.equal(hopAccount(KEY, 0).address, hopAccount(KEY, 0).address);
  assert.notEqual(hopAccount(KEY, 0).address, hopAccount(KEY, 1).address);
  assert.notEqual(hopAccount(KEY, 0).address, hopAccount(OTHER, 0).address);
});

test("hops live off the wallet path, so a hop is never the user's own account", () => {
  assert.notEqual(hopAccount(KEY, 0).address, mnemonicToAccount(KEY).address);
});

test("nextHop skips indexes that are used on chain or by a pending record", async () => {
  const { pub } = stubChain({ ...have(hopAccount(KEY, 0).address, "0"), ...have(hopAccount(KEY, 1).address, "0.1") });
  assert.equal(await nextHop(pub, KEY, []), 0, "0 is untouched");
  assert.equal(await nextHop(pub, KEY, [0]), 2, "0 is reserved, 1 holds ETH");
});

test("a hop that only ever sent is still counted as used", async () => {
  const { pub } = stubChain(have(hopAccount(KEY, 0).address, "0", 1));
  assert.equal(await nextHop(pub, KEY, []), 1);
});

test("hopScan reports the hops that hold ETH and stops after a run of empty ones", async () => {
  const { pub } = stubChain({ ...have(hopAccount(KEY, 0).address, "0.05"), ...have(hopAccount(KEY, 9).address, "1") });
  const hops = await hopScan(pub, KEY, []);
  assert.deepEqual(hops.map((h) => h.i), [0], "index 9 is past the gap and is not scanned");
  assert.equal(hops[0].balance, parseEther("0.05"));
});

test("the reserve covers one transfer at twice the current base fee", async () => {
  const { pub } = stubChain({}, { baseFee: 10_000_000n });
  assert.equal(await hopReserve(pub), HOP_GAS * 20_000_000n);
});

test("sending a fixed amount leaves the rest for gas", async () => {
  const hop = hopAccount(KEY, 0);
  const { pub, sent } = stubChain(have(hop.address, "0.01"));
  const r = await hopSend(pub, chain, hop, TO, parseEther("0.009"));
  assert.equal(r.value, parseEther("0.009"));
  assert.equal(sent.length, 1);
});

test('"all" sends the balance minus the gas it will cost', async () => {
  const hop = hopAccount(KEY, 0);
  const { pub } = stubChain(have(hop.address, "0.01"), { baseFee: 10_000_000n, estimateGas: 21_000n });
  const gas = (21_000n * 12n) / 10n;
  const r = await hopSend(pub, chain, hop, TO, "all");
  assert.equal(r.value, parseEther("0.01") - gas * 20_000_000n);
  assert.ok(r.value > 0n);
});

test("a transfer the balance cannot cover is refused instead of being broadcast", async () => {
  const hop = hopAccount(KEY, 0);
  const { pub, sent } = stubChain(have(hop.address, "0.001"));
  await assert.rejects(() => hopSend(pub, chain, hop, TO, parseEther("0.002")), /balance too low/);
  assert.equal(sent.length, 0, "nothing was broadcast");
});

test("an empty hop cannot send", async () => {
  const hop = hopAccount(KEY, 0);
  const { pub } = stubChain();
  await assert.rejects(() => hopSend(pub, chain, hop, TO, "all"), /balance too low/);
});

// The reserve is taken when the bridge is quoted and spent a moment later, so the base fee can
// move in between. It is HOP_GAS at twice the base fee, and the transfer needs ~25k gas, which
// leaves room for a rise of about 4x before the cap can no longer clear the base fee.
const RESERVE_AT = (baseFee) => HOP_GAS * 2n * baseFee;

test("a fee rise after the quote lowers the cap rather than stranding the ETH", async () => {
  const hop = hopAccount(KEY, 0);
  const value = parseEther("0.001");
  const { pub, sent } = stubChain({}, { baseFee: 30_000_000n }); // 3x the quote-time 10m
  pub.getBalance = async () => value + RESERVE_AT(10_000_000n);
  const r = await hopSend(pub, chain, hop, TO, value);
  assert.equal(r.value, value, "the bridge still gets exactly what it quoted");
  assert.equal(sent.length, 1, "it was broadcast, not abandoned");
});

test("a fee rise past what the reserve can cover is refused, leaving the ETH to sweep later", async () => {
  const hop = hopAccount(KEY, 0);
  const value = parseEther("0.001");
  const { pub, sent } = stubChain({}, { baseFee: 500_000_000n }); // 50x: nothing can be done now
  pub.getBalance = async () => value + RESERVE_AT(10_000_000n);
  await assert.rejects(() => hopSend(pub, chain, hop, TO, value), /balance too low/);
  assert.equal(sent.length, 0, "no transaction that would revert or underpay");
  // the ETH is still on the hop, and "Check hop wallets" can sweep or retry it once fees settle
  assert.equal(await pub.getBalance({ address: hop.address }), value + RESERVE_AT(10_000_000n));
});

test("a failed transaction is reported, not silently treated as sent", async () => {
  const hop = hopAccount(KEY, 0);
  const { pub } = stubChain(have(hop.address, "0.01"));
  pub.waitForTransactionReceipt = async () => ({ status: "reverted" });
  await assert.rejects(() => hopSend(pub, chain, hop, TO, parseEther("0.001")), /hop transfer failed/);
});

test("DUST is small enough to ignore and far below a usable balance", () => {
  assert.ok(DUST < parseEther("0.001"));
  assert.ok(DUST > 0n);
});
