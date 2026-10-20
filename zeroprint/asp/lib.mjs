// Pure helpers for the ShadePool ASP. No I/O here so it can be unit-tested.
import { createHash } from "node:crypto";
import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";

// Same tree the withdraw circuit checks: LeanIMT over labels, Poseidon(2) nodes.
export function buildAspTree(labels) {
  const tree = new LeanIMT((a, b) => poseidon([a, b]));
  if (labels.length) tree.insertMany(labels.map((l) => BigInt(l)));
  return tree;
}

export function aspRoot(labels) {
  return labels.length ? buildAspTree(labels).root : 0n;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// CIDv1, raw codec, sha2-256: what `ipfs add --cid-version 1 --raw-leaves` gives for a small file.
export function cidV1Raw(data) {
  const digest = createHash("sha256").update(data).digest();
  return "b" + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]));
}

export function setDocument(root, labels) {
  return JSON.stringify({ v: 1, root: root.toString(), labels: labels.map(String) });
}

export function parseAddressList(text) {
  const out = new Set();
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0].toLowerCase());
  return out;
}

/**
 * @param dep      { depositor, ts }
 * @param now      unix seconds
 * @param delaySec how long a deposit waits before it can be approved
 * @param blocked  Map(lowercase address -> reason)
 * @returns { status: "pending" | "approved" | "denied", reason?, eta? }
 */
export function decide(dep, now, delaySec, blocked) {
  const reason = blocked.get(dep.depositor.toLowerCase());
  if (reason) return { status: "denied", reason };
  const eta = dep.ts + delaySec;
  if (now < eta) return { status: "pending", eta };
  return { status: "approved" };
}
