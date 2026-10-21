// Bridge hop wallets. A bridge withdrawal goes pool -> hop -> bridge deposit address, because the
// bridges watch for plain transfers and the pool pays through a contract call. Each hop is derived
// from the Zero Key on its own path and used once, so two bridge withdrawals never share an
// address. The keys stay in this browser; the hop also receives bridge refunds.
import { mnemonicToAccount } from "viem/accounts";

const PATH = (i) => `m/44'/60'/7'/0/${i}`;
export const HOP_GAS = 60_000n;
export const DEPOSIT_GAS = 900_000n; // a pool deposit is a proof-sized call, not a transfer
export const DUST = 20_000_000_000_000n; // 0.00002 ETH: below this a hop counts as empty

export const hopAccount = (mnemonic, i) => mnemonicToAccount(mnemonic, { path: PATH(i) });

async function fees(pub) {
  const [block, tip] = await Promise.all([
    pub.getBlock(),
    pub.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt, () => 0n),
  ]);
  return { maxFeePerGas: block.baseFeePerGas * 2n + tip, maxPriorityFeePerGas: tip, baseFee: block.baseFeePerGas };
}

/** ETH to keep on the hop for its one transaction. */
export async function hopReserve(pub) {
  return HOP_GAS * (await fees(pub)).maxFeePerGas;
}

/** The same, for the pool deposit a Deep swap ends with. */
export async function depositReserve(pub) {
  return DEPOSIT_GAS * (await fees(pub)).maxFeePerGas;
}

/** Hops in use: balance or history. Stops after 3 untouched ones in a row. */
export async function hopScan(pub, mnemonic, used = []) {
  const out = [];
  for (let i = 0, empty = 0; empty < 3 && i < 200; i++) {
    const a = hopAccount(mnemonic, i);
    const [balance, nonce] = await Promise.all([pub.getBalance({ address: a.address }), pub.getTransactionCount({ address: a.address })]);
    const touched = balance > 0n || nonce > 0 || used.includes(i);
    empty = touched ? 0 : empty + 1;
    if (touched) out.push({ i, address: a.address, balance, nonce });
  }
  return out;
}

/** First hop that was never used (on chain or by a pending local record). */
export async function nextHop(pub, mnemonic, used = []) {
  for (let i = 0; i < 1000; i++) {
    if (used.includes(i)) continue;
    const a = hopAccount(mnemonic, i);
    const [balance, nonce] = await Promise.all([pub.getBalance({ address: a.address }), pub.getTransactionCount({ address: a.address })]);
    if (balance === 0n && nonce === 0) return i;
  }
  throw new Error("no free hop wallet");
}

/**
 * Signs and broadcasts a prepared call from a hop — the pool's own deposit, in practice. Without
 * a `value` the hop pays in everything `reserve` does not need, because what a swap delivered is
 * all it will ever hold: anything left behind stays on a wallet nobody has reason to open again.
 */
export async function hopDeposit(pub, chain, account, call, reserve, minimum = 0n) {
  const { baseFee, ...f } = await fees(pub);
  const balance = await pub.getBalance({ address: account.address });
  const value = call.value ?? balance - reserve;
  if (value <= 0n || balance < value + reserve) throw new Error("hop wallet balance too low for this deposit");
  // The pool refuses anything under its minimum, and finding that out on chain costs the gas and
  // tells the person nothing.
  if (minimum && value < minimum) throw new Error(`the pool's minimum deposit is ${minimum} wei and only ${value} arrived`);
  const est = await pub.estimateGas({ account: account.address, to: call.to, data: call.data, value }).catch(() => DEPOSIT_GAS);
  const gas = (est * 12n) / 10n > DEPOSIT_GAS ? DEPOSIT_GAS : (est * 12n) / 10n;
  // The reserve was measured a moment ago; if the base fee rose since, lower the cap rather than
  // let the node reject a transaction the wallet can no longer pay for.
  if (value + gas * f.maxFeePerGas > balance) {
    f.maxFeePerGas = (balance - value) / gas;
    if (f.maxPriorityFeePerGas > f.maxFeePerGas - baseFee) f.maxPriorityFeePerGas = 0n;
  }
  if (f.maxFeePerGas < baseFee) throw new Error("hop wallet balance too low for this deposit");
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const serializedTransaction = await account.signTransaction({ chainId: chain.id, type: "eip1559", to: call.to, data: call.data, value, gas, nonce, ...f });
  const hash = await pub.sendRawTransaction({ serializedTransaction });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`hop deposit failed ${hash}`);
  return { hash, value };
}

/** Signs here and broadcasts a plain transfer from a hop. value "all" sends everything but the gas. */
export async function hopSend(pub, chain, account, to, value) {
  const { baseFee, ...f } = await fees(pub);
  const balance = await pub.getBalance({ address: account.address });
  const est = await pub.estimateGas({ account: account.address, to, value: 1n }).catch(() => HOP_GAS);
  const gas = (est * 12n) / 10n < HOP_GAS ? (est * 12n) / 10n : HOP_GAS;
  const send = value === "all" ? balance - gas * f.maxFeePerGas : value;
  // the gas was reserved at quote time; if fees rose since, lower the cap as long as it still covers the base fee
  if (send > 0n && send + gas * f.maxFeePerGas > balance) {
    f.maxFeePerGas = (balance - send) / gas;
    if (f.maxPriorityFeePerGas > f.maxFeePerGas - baseFee) f.maxPriorityFeePerGas = 0n;
  }
  if (send <= 0n || f.maxFeePerGas < baseFee) throw new Error("hop wallet balance too low for this transfer");
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const serializedTransaction = await account.signTransaction({ chainId: chain.id, type: "eip1559", to, value: send, gas, nonce, ...f });
  const hash = await pub.sendRawTransaction({ serializedTransaction });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`hop transfer failed ${hash}`);
  return { hash, value: send };
}
