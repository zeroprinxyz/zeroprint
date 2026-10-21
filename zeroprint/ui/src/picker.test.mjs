// The picker is a coat over a real <select>: the select stays the value everything else reads, so
// these cases pin the two decisions that are not the browser's — what the list says, and where the
// keyboard goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { markFor, tokenMark } from "./marks.js";
import { moveIndex, optionsOf } from "./picker.js";

const select = (opts, value) => ({
  value,
  options: opts.map(([v, label], i) => ({ value: v, textContent: label, index: i, disabled: false })),
});

test("the list mirrors the select, marking the one in use", () => {
  const got = optionsOf(select([["hood", "Robinhood Chain · ETH"], ["sol", "Solana"]], "sol"));
  assert.deepEqual(got.map((o) => [o.value, o.label, o.selected]), [
    ["hood", "Robinhood Chain · ETH", false],
    ["sol", "Solana", true],
  ]);
});

test("arrows walk the list and stop at its ends", () => {
  assert.equal(moveIndex(0, "ArrowDown", 3), 1);
  assert.equal(moveIndex(2, "ArrowDown", 3), 2);
  assert.equal(moveIndex(0, "ArrowUp", 3), 0);
  assert.equal(moveIndex(1, "Home", 3), 0);
  assert.equal(moveIndex(1, "End", 3), 2);
  assert.equal(moveIndex(1, "a", 3), 1);
});

test("an empty select has nowhere to go", () => {
  assert.deepEqual(optionsOf(select([], "")), []);
  assert.equal(moveIndex(0, "ArrowDown", 0), 0);
});

test("a chain's mark is served from this site, never from someone else's", () => {
  assert.match(markFor("sol"), /^<img [^>]*src="\/chains\/sol\.png"/);
  assert.match(markFor("eth"), /^<img [^>]*src="\/chains\/eth\.png"/);
  assert.equal(/https?:/.test(markFor("hood") + markFor("base") + markFor("arb") + markFor("bsc") + markFor("btc")), false);
});

test("a chain with no file of its own still gets a mark", () => {
  assert.match(markFor("zec"), /^<img [^>]*src="\/chains\/zec\.png"/);
  assert.match(markFor("nope"), /^<svg/);
});

test("a token we have a picture of shows it, from this site", () => {
  assert.match(tokenMark("USDC"), /^<img [^>]*src="\/tokens\/usdc\.png"/);
  assert.match(tokenMark("cbBTC"), /^<img [^>]*src="\/tokens\/cbbtc\.png"/);
  assert.equal(/https?:/.test(tokenMark("USDC")), false);
});

test("a token we have no picture of still says which one it is", () => {
  const badge = tokenMark("PONS");
  assert.match(badge, /^<svg/);
  assert.match(badge, />PON</);
});
