import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMerkleProof } from "@0xbow/privacy-pools-core-sdk";
import { aspRoot, cidV1Raw, decide, parseAddressList } from "./lib.mjs";

test("CIDv1 raw matches the IPFS vector for empty input", () => {
  assert.equal(cidV1Raw(Buffer.alloc(0)), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
});

test("CID fits Entrypoint.updateRoot length check (32..64)", () => {
  const cid = cidV1Raw("anything");
  assert.ok(cid.length >= 32 && cid.length <= 64);
});

test("ASP root matches the SDK proof root for the same labels", () => {
  const labels = [11n, 22n, 33n, 44n, 55n];
  const proof = generateMerkleProof(labels, 33n);
  assert.equal(aspRoot(labels), proof.root);
});

test("empty set has root 0 (never posted)", () => {
  assert.equal(aspRoot([]), 0n);
});

test("decide: waits, then approves", () => {
  const blocked = new Map();
  assert.deepEqual(decide({ depositor: "0xAa", ts: 1000 }, 1500, 3600, blocked), { status: "pending", eta: 4600 });
  assert.deepEqual(decide({ depositor: "0xAa", ts: 1000 }, 4600, 3600, blocked), { status: "approved" });
});

test("decide: blocked depositor is denied right away, case-insensitive", () => {
  const blocked = new Map([["0xabc", "OFAC sanctioned address"]]);
  assert.deepEqual(decide({ depositor: "0xABC", ts: 1000 }, 1001, 3600, blocked), {
    status: "denied",
    reason: "OFAC sanctioned address",
  });
});

test("parseAddressList lowercases and dedupes", () => {
  const s = parseAddressList("0x8589427373D6D84E98730D7795D8f6f8731FDA16\n0x8589427373d6d84e98730d7795d8f6f8731fda16 junk");
  assert.deepEqual([...s], ["0x8589427373d6d84e98730d7795d8f6f8731fda16"]);
});
