// Real transactions, trimmed to what the reader needs. Each one was labelled "Wallet" on the page
// before this: a liquidity pool and a launch contract are not people, and a swap is not someone
// sending you money. The fixtures keep the shape the node answers with, log order included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { netMovements, swapOf, swapUsd } from "./swaps.mjs";

const ME = "0x779dda42ca2c5de2aaf98c68a2211f1443cf8960";
const POOL = "0xbdbae060cbab0e9cfe802a7513dd5ecb36cda6c3";
const ROUTER = "0xf5307745c61de69bf033edfe6a8771256275a323";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const LAUNCH = "0xf2e4a05c6faaec17bc999ceeb77b81cf4de5d473";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

const topic = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const data = (n) => "0x" + n.toString(16).padStart(64, "0");
const xfer = (token, from, to, amount) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: data(amount) });
const meta = { [USDG]: { symbol: "USDG", decimals: 6 }, [LAUNCH]: { symbol: "SPACEX", decimals: 18 } };

// 0.05 ETH into the router, 121.12847 USDG back out of the pool
const BUY = {
  tx: { from: ME, to: ROUTER, value: data(50000000000000000n) },
  receipt: { logs: [xfer(USDG, "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", POOL, 121128470n), xfer(USDG, POOL, ME, 121128470n)] },
};

// a USDG sale where the pool hands back a few units of change in the same token
const CHANGE = {
  tx: { from: ME, to: ROUTER, value: "0x0" },
  receipt: { logs: [xfer(USDG, ME, POOL, 9738451n), xfer(LAUNCH, POOL, ME, 20100000000000000000n), xfer(USDG, POOL, ME, 1n)] },
};

// 0.0555 ETH into a launch contract: the token is minted and part of the supply lands here
const LAUNCH_BUY = {
  tx: { from: ME, to: "0xe33e9e479df8802cb0866d5d05258bec4cf62948", value: data(55500000000000000n) },
  receipt: { logs: [xfer(LAUNCH, ZERO, "0x85cc34d574acf5736792b6ded74f653300140d68", 10n ** 27n), xfer(LAUNCH, "0x85cc34d574acf5736792b6ded74f653300140d68", ME, 30470914127423824000000000n)] },
};

// 96.39 USDG into the pool; the ETH comes back from inside the contract, where we cannot see it
const ONE_SIDED = { tx: { from: ME, to: ROUTER, value: "0x0" }, receipt: { logs: [xfer(USDG, ME, POOL, 96390020n)] } };

test("a buy nets out as ETH in, token out", () => {
  const nets = netMovements(ME, BUY.tx, BUY.receipt);
  assert.equal(nets.get("native"), -50000000000000000n);
  assert.equal(nets.get(USDG), 121128470n);
});

test("transfers that do not touch this address are ignored", () => {
  assert.equal(netMovements(ME, BUY.tx, BUY.receipt).size, 2);
});

test("a buy becomes one swap leg", () => {
  assert.deepEqual(swapOf(ME, BUY.tx, BUY.receipt, meta), { in: "ETH", amountIn: "0.05", out: "USDG", amountOut: "121.12847" });
});

test("change in the token being sold does not become the swap's output", () => {
  assert.deepEqual(swapOf(ME, CHANGE.tx, CHANGE.receipt, meta), { in: "USDG", amountIn: "9.73845", out: "SPACEX", amountOut: "20.1" });
});

test("buying at a launch reads as a swap, the mint to someone else ignored", () => {
  assert.deepEqual(swapOf(ME, LAUNCH_BUY.tx, LAUNCH_BUY.receipt, meta), { in: "ETH", amountIn: "0.0555", out: "SPACEX", amountOut: "30470914.127423824" });
});

test("a one-sided transfer is not called a swap", () => {
  assert.equal(swapOf(ME, ONE_SIDED.tx, ONE_SIDED.receipt, meta), null);
});

test("a token whose decimals we could not read is left alone, not guessed at", () => {
  assert.equal(swapOf(ME, BUY.tx, BUY.receipt, {}), null);
});

test("a token with no symbol is named by its address, once its decimals are known", () => {
  const s = swapOf(ME, BUY.tx, BUY.receipt, { [USDG]: { decimals: 6 } });
  assert.equal(s.out, "0x5fc5…d168");
  assert.equal(s.amountOut, "121.12847");
});

test("the tracer's price survives only when the swap still has the side it priced", () => {
  const swap = { in: "USDG", amountIn: "9.73845", out: "CREDIT", amountOut: "0.1" };
  // it priced the dust that came back, which is no longer either side of the trade
  assert.equal(swapUsd({ in: "USDG", amountIn: "0.000001", usd: 0 }, swap), null);
  assert.equal(swapUsd({ in: "USDG", amountIn: "9.73845", usd: 9.74 }, swap), 9.74);
  // priced from the other side of the same trade: still the trade's value
  assert.equal(swapUsd({ in: "CREDIT", amountIn: "0.1", usd: 9.7 }, swap), 9.7);
  assert.equal(swapUsd(undefined, swap), null);
});

// Selling a token for ETH pays out from inside the contract. Ethereum publishes those internal
// transfers, so there the sale can be completed; on Robinhood Chain nobody does, and the leg stays
// half a story — which is what the page says.
const SALE = {
  tx: { from: ME, to: ROUTER, value: "0x0" },
  receipt: { logs: [xfer(USDG, ME, POOL, 96390020n)] },
};

test("without the internal payout a sale is not a swap", () => {
  assert.equal(swapOf(ME, SALE.tx, SALE.receipt, meta), null);
});

test("the internal payout completes the sale", () => {
  assert.deepEqual(swapOf(ME, SALE.tx, SALE.receipt, meta, "ETH", 39355168432422890n), {
    in: "USDG",
    amountIn: "96.39002",
    out: "ETH",
    amountOut: "0.03935516843242289",
  });
});

test("an internal payout on a transfer that moved nothing else is left alone", () => {
  const plain = { tx: { from: "0x1111111111111111111111111111111111111111", to: ME, value: "0x0" }, receipt: { logs: [] } };
  assert.equal(swapOf(ME, plain.tx, plain.receipt, meta, "ETH", 1000n), null);
});
