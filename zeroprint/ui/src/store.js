// Your split plans and bridge withdrawals. They link a deposit to its recipients, so they stay in
// this browser only, encrypted with a key derived from the Zero Key (unreadable while locked).
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyOf(mnemonic) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`zeroprint-local-v1:${mnemonic}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
// one store per Zero Key and pool, under a name that doesn't reveal the key
async function slot(mnemonic, scope) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`zeroprint-slot:${scope}:${mnemonic}`)));
  return `zeroprint.local.v1.${b64(h.slice(0, 9)).replace(/[+/=]/g, "")}`;
}

export async function loadLocal(mnemonic, scope) {
  const empty = { plans: [], bridges: [] };
  try {
    const s = JSON.parse(localStorage.getItem(await slot(mnemonic, scope)));
    if (!s) return empty;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, await keyOf(mnemonic), unb64(s.ct));
    return { ...empty, ...JSON.parse(dec.decode(pt)) };
  } catch {
    return empty;
  }
}

export async function saveLocal(mnemonic, scope, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(mnemonic), enc.encode(JSON.stringify(data))));
  try {
    localStorage.setItem(await slot(mnemonic, scope), JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }));
  } catch {
    /* storage blocked: plans then live only while the tab is open */
  }
}
