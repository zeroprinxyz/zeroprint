// Chain marks, served from this site. Each file was fetched once and committed here; nothing is
// loaded from anyone else's server, because a logo pulled from a CDN at page load would tell that
// CDN who is about to move money and where to. A chain with no file of its own falls back to a
// quiet ring. Every mark is the same 64px circle, so a row of them reads as one set.
const svg = (body, extra = "") => `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${body}</svg>`;

const FILE = ["hood", "eth", "sol", "base", "arb", "bsc", "btc", "zec"];

// Assets, by lower-cased symbol. A token nobody publishes a picture of keeps its letters, which
// still tells it apart from its neighbours.
const TOKEN_FILE = ["ape", "bnb", "bonk", "btc", "cbbtc", "eth", "jup", "pengu", "pyusd", "ray", "sol", "trump", "usdc", "usde", "usdg", "usdt", "wif", "zec"];

const FALLBACK = svg('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/>');

/** The mark for a route id: this site's own file, else a quiet ring for a chain we have none for. */
export const markFor = (id) =>
  FILE.includes(id) ? `<img class="mark" src="/chains/${id}.png" alt="" width="20" height="20" decoding="async">` : FALLBACK;

/** A token's own picture, else its first letters, which is enough to tell them apart. */
export const tokenMark = (symbol) =>
  TOKEN_FILE.includes(String(symbol ?? "").toLowerCase())
    ? `<img class="mark" src="/tokens/${String(symbol).toLowerCase()}.png" alt="" width="20" height="20" decoding="async">`
    : svg(`<circle cx="12" cy="12" r="9" fill="currentColor" opacity=".12"/><text x="12" y="15.5" text-anchor="middle" font-size="9" fill="currentColor" font-family="inherit">${(symbol ?? "?").slice(0, 3).toUpperCase()}</text>`);
