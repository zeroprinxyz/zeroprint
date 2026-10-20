// Browser stand-in for Node assert: the SDK only uses assert(cond) for constant sanity checks.
export default function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}
assert.ok = assert;
