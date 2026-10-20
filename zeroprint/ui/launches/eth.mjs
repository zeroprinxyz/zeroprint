// Ethereum launches by a creator: contracts the wallet deployed itself (Etherscan v2 txlist),
// kept when they answer ERC-20 name()/symbol().
const ETHERSCAN = "https://api.etherscan.io/v2/api";

function decodeString(hex) {
  if (!hex || hex === "0x") return "";
  const b = Buffer.from(hex.slice(2), "hex");
  if (b.length >= 64) {
    const off = Number(BigInt(`0x${b.subarray(0, 32).toString("hex")}`));
    const len = Number(BigInt(`0x${b.subarray(off, off + 32).toString("hex")}`));
    if (off + 32 + len <= b.length) return b.subarray(off + 32, off + 32 + len).toString("utf8");
  }
  return b.toString("utf8").replace(/\0+$/, ""); // bytes32 names
}

export function createEthScanner({ apiKey, rpcUrl }) {
  async function call(to, data) {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(15_000),
    });
    return (await r.json()).result;
  }

  return async function scan(creator) {
    const u = `${ETHERSCAN}?chainid=1&module=account&action=txlist&address=${creator}&startblock=0&endblock=99999999&page=1&offset=1000&sort=desc&apikey=${apiKey}`;
    const j = await fetch(u, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    if (j.status !== "1" && !/No transactions/i.test(j.message ?? "")) throw new Error(`etherscan: ${j.result ?? j.message}`);
    const created = (Array.isArray(j.result) ? j.result : [])
      .filter((t) => t.contractAddress && !t.to && t.from?.toLowerCase() === creator.toLowerCase() && t.isError === "0")
      .slice(0, 20);
    const launches = [];
    for (const t of created) {
      try {
        const [name, symbol] = await Promise.all([call(t.contractAddress, "0x06fdde03"), call(t.contractAddress, "0x95d89b41")]);
        const sym = decodeString(symbol);
        if (!sym) continue; // not a token
        launches.push({ chain: "ethereum", token: t.contractAddress, name: decodeString(name), symbol: sym, launchpad: "deployed", ts: Number(t.timeStamp), tx: t.hash });
      } catch {
        /* not a token */
      }
    }
    return { scanned: Array.isArray(j.result) ? j.result.length : 0, partial: (j.result?.length ?? 0) >= 1000, launches };
  };
}
