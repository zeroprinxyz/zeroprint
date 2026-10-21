// Bridge client. Quotes go through this site's server so Relay and NEAR Intents never see your IP.
// The server picks the better of the two quotes; the deposit address it returns is checked here.
import { isAddress } from "viem";

export function createBridge(base) {
  const json = async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `bridge service error (${r.status})`);
    return j;
  };
  let routes;
  return {
    async routes() {
      routes ??= await fetch(`${base}/routes`, { cache: "no-store" }).then(json).then((j) => j.routes, () => []);
      return routes;
    },
    async quote({ route, amount, recipient, refundTo }) {
      const q = await fetch(`${base}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, amount: amount.toString(), recipient, refundTo }),
      }).then(json);
      if (!isAddress(q.depositAddress) || BigInt(q.amountIn) !== BigInt(amount)) throw new Error("bridge quote does not match the request");
      return q;
    },
    submit: (q, txHash) =>
      fetch(`${base}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: q.provider, depositAddress: q.depositAddress, txHash }),
      }).catch(() => {}),
    status: (q) => fetch(`${base}/status?provider=${q.provider}&id=${encodeURIComponent(q.id)}`, { cache: "no-store" }).then(json),
  };
}

/** Basic address shape per destination, so a typo is caught before any money moves. */
export function validRecipient(kind, a) {
  if (kind === "evm") return isAddress(a);
  if (kind === "solana") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
  if (kind === "btc") return /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a);
  if (kind === "zec") return /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a);
  return false;
}
