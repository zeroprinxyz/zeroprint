// Reading a transaction the way its owner experienced it. The tracer sees each token transfer on
// its own, so a swap arrives as "a wallet sent you 121 USDG" — when in truth a pool gave it back
// for the ETH that left in the same transaction. Netting every move that touches the address turns
// the pieces into the one thing that happened: this much in, that much out.
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const party = (topic) => "0x" + topic.slice(26).toLowerCase();

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Whole-unit decimal string, trailing zeros trimmed: (121128470n, 6) -> "121.12847". */
export function units(v, decimals) {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${s.slice(0, s.length - decimals)}${frac ? `.${frac}` : ""}`;
}

/**
 * Net move per asset for one address in one transaction: negative left, positive arrived.
 * `internalIn` is native currency paid to the address from inside a contract. A chain that
 * publishes those transfers lets a sale be read in full; where none are published it stays 0.
 */
export function netMovements(me, tx, receipt, internalIn = 0n) {
  const self = me.toLowerCase();
  const nets = new Map();
  const add = (asset, v) => nets.set(asset, (nets.get(asset) ?? 0n) + v);
  const value = BigInt(tx.value ?? 0);
  if (value > 0n) {
    if (tx.from?.toLowerCase() === self) add("native", -value);
    else if (tx.to?.toLowerCase() === self) add("native", value);
  }
  for (const log of receipt.logs ?? []) {
    if (log.topics?.[0] !== TRANSFER || log.topics.length !== 3) continue;
    const [from, to] = [party(log.topics[1]), party(log.topics[2])];
    if (from !== self && to !== self) continue;
    const amount = BigInt(log.data);
    if (from === self) add(log.address.toLowerCase(), -amount);
    if (to === self) add(log.address.toLowerCase(), amount);
  }
  if (internalIn > 0n) add("native", internalIn);
  for (const [asset, v] of nets) if (v === 0n) nets.delete(asset);
  return nets;
}

const decimalsOf = (asset, meta) => (asset === "native" ? 18 : meta[asset]?.decimals);
const symbolOf = (asset, meta, native) => (asset === "native" ? native : (meta[asset]?.symbol || short(asset)));

/**
 * One asset out, at least one in: that is a swap, whatever contract stood in the middle. Change
 * handed back in the token being sold nets away on its own, so it never becomes the output; when
 * several assets arrive, the largest is the one worth naming. A token whose decimals we could not
 * read would only produce a wrong number, so it, and anything else, returns null and stays the
 * plain transfer the tracer reported.
 */
export function swapOf(me, tx, receipt, meta = {}, native = "ETH", internalIn = 0n) {
  const nets = netMovements(me, tx, receipt, internalIn);
  const sent = [...nets].filter(([, v]) => v < 0n);
  const received = [...nets].filter(([, v]) => v > 0n);
  if (sent.length !== 1 || !received.length) return null;
  if ([...nets.keys()].some((asset) => decimalsOf(asset, meta) == null)) return null;
  const biggest = received
    .map(([asset, v]) => [asset, v, Number(units(v, decimalsOf(asset, meta)))])
    .sort((a, b) => b[2] - a[2])[0];
  return {
    in: symbolOf(sent[0][0], meta, native),
    amountIn: units(-sent[0][1], decimalsOf(sent[0][0], meta)),
    out: symbolOf(biggest[0], meta, native),
    amountOut: units(biggest[1], decimalsOf(biggest[0], meta)),
  };
}

/**
 * The tracer priced the single transfer it saw. That price describes the trade only when the
 * amount it priced is still one of the two sides; otherwise (it priced the change, say) the leg
 * is better shown with no figure than with a wrong one.
 */
export const swapUsd = (asset, swap) =>
  [`${swap.amountIn} ${swap.in}`, `${swap.amountOut} ${swap.out}`].includes(`${asset?.amountIn} ${asset?.in}`) ? (asset?.usd ?? null) : null;
