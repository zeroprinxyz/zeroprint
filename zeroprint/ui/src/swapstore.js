// What this browser remembers about a swap. A Fast swap has no Zero Key behind it — not needing
// one is the point — so unlike a deposit's record this cannot be encrypted, and it sits in plain
// local storage. Keep that in mind on a shared browser: it holds the two addresses and the
// amounts, which is enough for someone else at the same screen to read what was sent where. It
// holds nothing that can move money, and the page offers to forget any of it.
//
// Storage can be absent, full, or forbidden (a private window, cleared site data). None of that
// may stop a swap: it only costs the history, so every access here is allowed to fail.
const KEY = "zeroprint.swaps.v1";

const read = () => {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
};

const write = (all) => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch {
    /* nothing kept: the swap itself is the provider's to finish, not ours */
  }
};

/** Newest first. */
export const listSwaps = () => read().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

/** Keeps one record per id; remembering the same swap again replaces what was there. */
export function rememberSwap(record) {
  if (!record?.id) return;
  write([record, ...read().filter((s) => s.id !== record.id)]);
}

/** Changes the fields named, for a swap we have. An unknown id changes nothing. */
export function updateSwap(id, patch) {
  const all = read();
  const at = all.findIndex((s) => s.id === id);
  if (at < 0) return;
  all[at] = { ...all[at], ...patch };
  write(all);
}

export const forgetSwap = (id) => write(read().filter((s) => s.id !== id));

export function forgetAllSwaps() {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* already gone, as far as anyone can tell */
  }
}

/**
 * Hop indexes any swap has used. The withdrawal path asks for a hop that is empty and untouched,
 * which is exactly what a hop awaiting a swap looks like, so these are named here to be skipped.
 */
export const swapHops = () => read().filter((s) => s.hop != null).map((s) => Number(s.hop));
