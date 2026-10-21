// Config for the IPFS copy: public RPC for reads, the main site for relayer/ASP/bridges.
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log(JSON.stringify({ ...cfg, ipfs: true, rpcUrl: cfg.walletRpc, api: cfg.origin }, null, 2));
