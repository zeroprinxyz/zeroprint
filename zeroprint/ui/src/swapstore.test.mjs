// A Fast swap has no key behind it — that is the point of it — so these records cannot be
// encrypted the way a deposit's are. They exist so the page can still say "waiting" after a
// refresh. Losing them costs the status view and nothing else: the solver pays the recipient
// whether or not this browser remembers asking. So every one of these cases is about the page
// surviving storage that is empty, full, or forbidden.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { forgetAllSwaps, forgetSwap, listSwaps, rememberSwap, swapHops, updateSwap } from "./swapstore.js";

const store = (impl = {}) => {
  let data = new Map();
  globalThis.localStorage = {
    getItem: impl.getItem ?? ((k) => data.get(k) ?? null),
    setItem: impl.setItem ?? ((k, v) => void data.set(k, String(v))),
    removeItem: impl.removeItem ?? ((k) => void data.delete(k)),
  };
};
const swap = (id, over = {}) => ({ id, at: 1000, origin: "sol", originToken: "USDC", dest: "hood", destToken: "ETH", amountIn: "5000000", provider: "near", depositAddress: "9uHD", recipient: "0x1", refundTo: "vine", state: "quoted", ...over });

beforeEach(() => store());

test("a swap comes back, and the newest is first", () => {
  rememberSwap(swap("a"));
  rememberSwap(swap("b", { at: 2000 }));
  assert.deepEqual(listSwaps().map((s) => s.id), ["b", "a"]);
});

test("remembering the same swap twice keeps one copy, the later one", () => {
  rememberSwap(swap("a"));
  rememberSwap(swap("a", { state: "waiting" }));
  assert.deepEqual(listSwaps().map((s) => [s.id, s.state]), [["a", "waiting"]]);
});

test("an update changes the fields it names and leaves the rest", () => {
  rememberSwap(swap("a"));
  updateSwap("a", { state: "done", destTx: "0xdead" });
  const [got] = listSwaps();
  assert.equal(got.state, "done");
  assert.equal(got.destTx, "0xdead");
  assert.equal(got.depositAddress, "9uHD");
});

test("an update for a swap we never saw changes nothing", () => {
  rememberSwap(swap("a"));
  updateSwap("zzz", { state: "done" });
  assert.deepEqual(listSwaps().map((s) => s.state), ["quoted"]);
});

test("forgetting takes one, or all of them", () => {
  rememberSwap(swap("a"));
  rememberSwap(swap("b"));
  forgetSwap("a");
  assert.deepEqual(listSwaps().map((s) => s.id), ["b"]);
  forgetAllSwaps();
  assert.deepEqual(listSwaps(), []);
});

test("storage that refuses to be read leaves the page working, with no history", () => {
  store({ getItem: () => { throw new Error("blocked"); } });
  assert.deepEqual(listSwaps(), []);
  assert.doesNotThrow(() => updateSwap("a", { state: "done" }));
});

test("storage that refuses to be written loses the record, not the swap", () => {
  store({ setItem: () => { throw new Error("quota"); } });
  assert.doesNotThrow(() => rememberSwap(swap("a")));
  assert.deepEqual(listSwaps(), []);
});

test("nonsense in storage reads as nothing, not as a crash", () => {
  store();
  globalThis.localStorage.setItem("zeroprint.swaps.v1", "{not json");
  assert.deepEqual(listSwaps(), []);
  rememberSwap(swap("a"));
  assert.deepEqual(listSwaps().map((s) => s.id), ["a"]);
});

test("no storage at all is simply no history", () => {
  globalThis.localStorage = undefined;
  assert.deepEqual(listSwaps(), []);
  assert.doesNotThrow(() => rememberSwap(swap("a")));
});

// A swap into the pool is paid to a hop wallet, and the withdrawal path picks its own hops by
// looking for one that is empty and untouched — which a hop awaiting a swap still is. Without
// this the same wallet is handed out twice, and the first thing to arrive is swept to whichever
// bridge the second use quoted.
test("hops a swap is waiting on are known, so nothing else is given them", () => {
  rememberSwap(swap("a", { deep: true, hop: 3 }));
  rememberSwap(swap("b", { deep: true, hop: 7 }));
  rememberSwap(swap("c"));
  assert.deepEqual(swapHops().sort(), [3, 7]);
});

test("a swap whose hop was already deposited still counts: its history is not a free wallet", () => {
  rememberSwap(swap("a", { deep: true, hop: 2, depositTx: "0xabc", state: "done" }));
  assert.deepEqual(swapHops(), [2]);
});

test("no swaps, no hops, and storage that throws is no hops either", () => {
  assert.deepEqual(swapHops(), []);
  store({ getItem: () => { throw new Error("blocked"); } });
  assert.deepEqual(swapHops(), []);
});
