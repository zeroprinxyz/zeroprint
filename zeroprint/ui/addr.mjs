// Recipient address checks. A withdrawal to another chain is final, so a mistyped address has to
// fail here rather than at the bridge: Bitcoin and Zcash addresses carry a checksum, and checking
// it catches a changed character that a shape-only test would wave through.
import { createHash } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest();
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58check -> payload without the 4-byte checksum, or null. */
export function base58check(s) {
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const body = Buffer.concat([Buffer.alloc(s.length - s.replace(/^1+/, "").length), Buffer.from(hexOf(n), "hex")]);
  if (body.length < 5) return null;
  const payload = body.subarray(0, -4);
  return sha256(sha256(payload)).subarray(0, 4).equals(body.subarray(-4)) ? payload : null;
}

// bech32 / bech32m, as used by native segwit Bitcoin addresses
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const polymod = (values) => {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
};
const expand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** The witness version of a valid bech32(m) address for `hrp`, or null. */
export function bech32(addr, hrp) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf("1");
  if (s.slice(0, pos) !== hrp || pos < 1 || pos + 7 > s.length || s.length > 90) return null;
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) return null;
    data.push(v);
  }
  const chk = polymod([...expand(hrp), ...data]);
  const version = data[0];
  // v0 is bech32, v1+ is bech32m
  if (chk !== (version === 0 ? 1 : 0x2bc830a3)) return null;
  return version <= 16 ? version : null;
}

export function validBitcoin(a) {
  if (/^(bc1|BC1)/.test(a)) return bech32(a, "bc") !== null;
  const p = base58check(a);
  return !!p && p.length === 21 && (p[0] === 0x00 || p[0] === 0x05); // P2PKH or P2SH
}

/** Transparent Zcash only: a shielded address cannot receive from these bridges. */
export function validZcash(a) {
  const p = base58check(a);
  return !!p && p.length === 22 && p[0] === 0x1c && (p[1] === 0xb8 || p[1] === 0xbd); // t1 / t3
}

/** A Solana address is a raw 32-byte key in base58: no checksum, but the length must be exact. */
export const validSolana = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && decodedLength(a) === 32;
function decodedLength(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  return s.length - s.replace(/^1+/, "").length + hexOf(n).length / 2;
}

/** Big-endian bytes of n as hex; zero is no bytes at all, not a zero byte. */
function hexOf(n) {
  if (n === 0n) return "";
  const h = n.toString(16);
  return h.length % 2 ? `0${h}` : h;
}

export const VALIDATE = {
  evm: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
  solana: validSolana,
  btc: validBitcoin,
  zec: validZcash,
};
