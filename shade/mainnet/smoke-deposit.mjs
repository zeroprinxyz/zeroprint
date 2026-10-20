// Mainnet smoke: deposit 0.001 ETH from the deployer under a fresh Zero Key kept in
// mainnet/smoke-zero-key.txt (gitignored, 600). Prints only addresses and the tx hash.
import fs from "node:fs";
import { createWalletClient, http, parseEther } from "viem";
import { english, generateMnemonic, privateKeyToAccount } from "viem/accounts";
import { createShade, settle } from "../ui/src/core.js";

for (const k of ["info", "debug"]) console[k] = () => {};
const dir = new URL(".", import.meta.url).pathname;
const net = JSON.parse(fs.readFileSync(`${dir}../cli/networks.json`, "utf8")).mainnet;
const pk = fs.readFileSync(`${dir}secrets.env`, "utf8").match(/^DEPLOYER_PK=(0x[0-9a-fA-F]{64})/m)[1];
const keyFile = `${dir}smoke-zero-key.txt`;
if (fs.existsSync(keyFile)) throw new Error("smoke-zero-key.txt exists: a smoke deposit was already made");
const mnemonic = generateMnemonic(english);
fs.writeFileSync(keyFile, mnemonic + "\n", { mode: 0o600 });

const rpcUrl = "http://127.0.0.1:8547";
const shade = createShade({ rpcUrl, chainName: net.name, deployment: net.deployment, aspUrl: "", relayerUrl: net.relayer, circuits: { browser: false } });
const w = createWalletClient({ chain: shade.chain, account: privateKeyToAccount(pk), transport: http(rpcUrl) });
const acct = await shade.loadAccount(mnemonic);
const hash = await w.sendTransaction(shade.depositTx(acct, parseEther("0.001")));
const r = await shade.pub.waitForTransactionReceipt({ hash });
await settle();
console.log(`deposit from ${w.account.address}: ${hash} ${r.status}`);
