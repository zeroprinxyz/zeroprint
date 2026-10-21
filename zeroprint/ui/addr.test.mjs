// A withdrawal to another chain cannot be taken back, so these checks are the last thing between
// a typo and a permanent loss. Every "good" address below is a published test vector.
import assert from "node:assert/strict";
import { test } from "node:test";
import { VALIDATE, bech32, validBitcoin, validSolana, validZcash } from "./addr.mjs";

// BIP-173 / BIP-350 vectors and the Bitcoin genesis address
const GOOD_BTC = [
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", // P2PKH, the genesis coinbase
  "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", // P2SH
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // P2WPKH
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", // P2TR (BIP-350)
];
const GOOD_ZEC = ["t1Kfc7Tk3RPJY93VmVLGZfncrnRfLctCNoM"];
const GOOD_SOL = ["vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg", "11111111111111111111111111111111", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"];

/** Change one character to something else valid in the same alphabet. */
const typo = (a) => {
  const i = a.length - 3;
  const alt = a[i] === "q" ? "p" : "q";
  return a.slice(0, i) + (/[a-z0-9]/.test(a[i]) ? alt : "X") + a.slice(i + 1);
};

test("real Bitcoin addresses pass, in every common format", () => {
  for (const a of GOOD_BTC) assert.ok(validBitcoin(a), a);
});

test("a Bitcoin address with one character changed is rejected", () => {
  for (const a of GOOD_BTC) assert.ok(!validBitcoin(typo(a)), `typo of ${a}`);
});

test("Bitcoin rejects an address for another chain or another network", () => {
  for (const a of [
    "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // testnet
    "t1Kfc7Tk3RPJY93VmVLGZfncrnRfLctCNoM", // Zcash
    "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e", // EVM
    "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg", // Solana
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // bad checksum
    "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx", // v1 with the old bech32 checksum, invalid under BIP-350
    "",
  ])
    assert.ok(!validBitcoin(a), a || "(empty)");
});

test("bech32 rejects mixed case and the wrong prefix", () => {
  assert.equal(bech32("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc"), 0);
  assert.equal(bech32("bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc"), null);
  assert.equal(bech32("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "tb"), null);
});

test("a transparent Zcash address passes and a typo of it does not", () => {
  for (const a of GOOD_ZEC) {
    assert.ok(validZcash(a), a);
    assert.ok(!validZcash(typo(a)), `typo of ${a}`);
  }
});

test("Zcash rejects Bitcoin addresses, which share the alphabet", () => {
  for (const a of GOOD_BTC) assert.ok(!validZcash(a), a);
});

test("Solana accepts 32-byte keys and rejects anything shorter or longer", () => {
  for (const a of GOOD_SOL) assert.ok(validSolana(a), a);
  for (const a of ["1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa", "abc", "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e", `${GOOD_SOL[0]}x`, ""])
    assert.ok(!validSolana(a), a || "(empty)");
});

test("EVM addresses are accepted in either case, and nothing else is", () => {
  const a = "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e";
  assert.ok(VALIDATE.evm(a));
  assert.ok(VALIDATE.evm(a.toLowerCase()));
  for (const x of [a.slice(0, -1), `${a}0`, a.replace("0x", ""), ""]) assert.ok(!VALIDATE.evm(x), x || "(empty)");
});

test("no address is valid for two different chains at once", () => {
  for (const a of [...GOOD_BTC, ...GOOD_ZEC, ...GOOD_SOL, "0x1fa0DB7e584fc84F31a56F711aB5466123cF836e"]) {
    const hits = Object.entries(VALIDATE).filter(([, f]) => f(a)).map(([k]) => k);
    assert.equal(hits.length, 1, `${a} matched ${hits.join(", ")}`);
  }
});
