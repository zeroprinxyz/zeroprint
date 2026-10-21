import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "viem";
import { ROUND, amountCounts, isRound, privacyCheck } from "./privacy.js";

const dep = (eth, approved = true, block = 100n) => ({ value: parseEther(eth), approved, block });
const note = (eth, block = 100n) => ({ deposited: parseEther(eth), depositBlock: block });
const HOUR = 3600;

test("isRound accepts up to three decimals, which is what the chips offer", () => {
  for (const v of ROUND) assert.ok(isRound(parseEther(v)), v);
  assert.ok(isRound(parseEther("2")));
  assert.ok(!isRound(parseEther("0.3712")));
  assert.ok(!isRound(parseEther("0.0001")));
});

test("amountCounts only counts approved deposits", () => {
  const counts = amountCounts([dep("0.1"), dep("0.1"), dep("0.1", false), dep("0.5")]);
  assert.equal(counts.get(parseEther("0.1")), 2);
  assert.equal(counts.get(parseEther("0.5")), 1);
  assert.equal(counts.get(parseEther("1")), undefined);
});

test("cover counts every approved deposit that is large enough", () => {
  const crowd = [dep("0.01"), dep("0.1"), dep("1"), dep("1", false)];
  const r = privacyCheck({ crowd, note: note("1"), amount: parseEther("0.1"), ageSec: 48 * HOUR });
  assert.equal(r.cover, 2); // 0.1 and 1; the unapproved 1 does not count
});

test("a big crowd, a round amount and enough time rate Good", () => {
  const crowd = Array.from({ length: 30 }, () => dep("0.1"));
  const r = privacyCheck({ crowd, note: note("0.5"), amount: parseEther("0.1"), ageSec: 72 * HOUR });
  assert.equal(r.level, 3);
  assert.equal(r.label, "Good");
});

test("a tiny crowd is Weak however good everything else is", () => {
  const crowd = [dep("1"), dep("1")];
  const r = privacyCheck({ crowd, note: note("1"), amount: parseEther("0.1"), ageSec: 72 * HOUR });
  assert.equal(r.level, 1);
  assert.match(r.tips.join(" "), /Only 2 approved deposits/);
});

test("withdrawing the whole deposit when few share that amount is called out", () => {
  const crowd = [...Array.from({ length: 30 }, () => dep("0.1")), dep("7")];
  const r = privacyCheck({ crowd, note: note("7"), amount: parseEther("7"), ageSec: 72 * HOUR });
  assert.equal(r.same, 1);
  assert.equal(r.level, 1, "one deposit of that size and we take all of it: weak");
  assert.match(r.tips.join(" "), /exactly what you put in/);
});

test("the same-amount warning goes away once the amount is common", () => {
  const crowd = Array.from({ length: 30 }, () => dep("0.1"));
  const r = privacyCheck({ crowd, note: note("0.1"), amount: parseEther("0.1"), ageSec: 72 * HOUR });
  assert.equal(r.same, 30);
  assert.equal(r.level, 3);
  assert.ok(!r.tips.join(" ").includes("exactly what you put in"));
});

test("an odd amount caps the rating at Fair", () => {
  const crowd = Array.from({ length: 30 }, () => dep("1"));
  const r = privacyCheck({ crowd, note: note("1"), amount: parseEther("0.3712"), ageSec: 72 * HOUR });
  assert.equal(r.level, 2);
  assert.match(r.tips.join(" "), /Odd amounts/);
});

test("withdrawing within the hour caps the rating at Fair", () => {
  const crowd = Array.from({ length: 30 }, () => dep("1"));
  const r = privacyCheck({ crowd, note: note("1"), amount: parseEther("0.1"), ageSec: 20 * 60 });
  assert.equal(r.level, 2);
  assert.match(r.tips.join(" "), /20 min ago/);
});

test("deposits that arrived after yours are counted, approved or not", () => {
  const crowd = [dep("1", true, 50n), dep("1", true, 150n), dep("1", false, 160n)];
  const r = privacyCheck({ crowd, note: note("1", 100n), amount: parseEther("0.1"), ageSec: 72 * HOUR });
  assert.equal(r.after, 2);
});

test("every rating carries at least one line of advice", () => {
  for (const n of [1, 5, 30]) {
    const crowd = Array.from({ length: n }, () => dep("0.1"));
    const r = privacyCheck({ crowd, note: note("0.1"), amount: parseEther("0.05"), ageSec: 72 * HOUR });
    assert.ok(r.tips.length > 0, `${n} deposits`);
    assert.ok(["Weak", "Fair", "Good"].includes(r.label));
  }
});
