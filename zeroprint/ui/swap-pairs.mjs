// The pairs a swap may be quoted for. A probe asks both providers for every combination and writes
// the ones that fill, with what each needs at a minimum; this file is how the server reads that
// answer. An empty or missing list means nothing has been probed yet — a test network, where the
// echo route stands in for a provider — and then everything is offered.
import fs from "node:fs";

const key = (p) => `${p.origin}:${p.originToken}>${p.dest}:${p.destToken}`;

// A quote asks with the bridge's words: `route` and `token` for the far end, and nothing at all
// for the near one when it starts here. The probe writes a pair with both ends named. Same thing,
// two vocabularies, so everything is read through this before it is compared.
const asPair = (w) => ({
  origin: w.origin ?? "hood",
  originToken: w.originToken ?? "ETH",
  dest: w.dest ?? w.route,
  destToken: w.destToken ?? w.token,
});
const pasted = (v) => /^0x[0-9a-fA-F]{40}$/.test(v ?? "") || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v ?? "");

/** The probe's file, or null when there is none to read. */
export function loadPairs(path) {
  try {
    const list = JSON.parse(fs.readFileSync(path, "utf8"));
    return Array.isArray(list?.pairs) && list.pairs.length ? list : null;
  } catch {
    return null;
  }
}

/** The pair's entry (with its minimum), `{}` when nothing has been probed, or null when refused. */
export function allowed(list, want) {
  if (!list?.pairs?.length) return {};
  // A token somebody pasted is on no list of ours by definition. Nothing is hidden from them and
  // nothing is promised either: the quote is what says whether it can be filled.
  const want_ = asPair(want);
  if (pasted(want_.originToken) || pasted(want_.destToken)) return {};
  return list.pairs.find((p) => key(p) === key(want_)) ?? null;
}

/** Every pair as "origin:ASSET>dest:ASSET", for the page to filter its own pickers with. */
export const pairKeys = (list) => list?.pairs?.map(key) ?? null;

/** The chains and assets some pair actually uses, in the order the routes are declared. */
export function offered(list, routes) {
  if (!list?.pairs?.length) return { origins: routes, destinations: routes };
  const keep = (side) => {
    const seen = new Map(); // route id -> Set of symbols
    for (const p of list.pairs) {
      const [id, sym] = side === "origin" ? [p.origin, p.originToken] : [p.dest, p.destToken];
      (seen.get(id) ?? seen.set(id, new Set()).get(id)).add(sym);
    }
    return routes
      .filter((r) => seen.has(r.id))
      .map((r) => ({ ...r, tokens: r.tokens.filter((t) => seen.get(r.id).has(t.symbol)) }));
  };
  return { origins: keep("origin"), destinations: keep("dest") };
}
