// Zero Key storage: the 12 words are encrypted with the user's password (PBKDF2 -> AES-GCM)
// and kept in this browser only. The plain words live in memory while unlocked.
const STORE = "shadepool.key.v1";
const ITER = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function read() {
  try {
    return JSON.parse(localStorage.getItem(STORE));
  } catch {
    return null;
  }
}

export function hasStoredKey() {
  return !!read();
}

export async function saveKey(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(mnemonic)));
  localStorage.setItem(STORE, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

export async function unlockKey(password) {
  const s = read();
  if (!s) throw new Error("No Zero Key in this browser");
  const key = await deriveKey(password, unb64(s.salt));
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.ct));
    return dec.decode(pt);
  } catch {
    throw new Error("Wrong password");
  }
}

export function forgetKey() {
  localStorage.removeItem(STORE);
}
