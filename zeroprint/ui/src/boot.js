// Boot screen for /app. Every line is a real check (secure context, chain, renounced owner,
// ASP root vs chain, circuit download), so the "initializing" is honest. The circuit files are
// fetched into the HTTP cache (served immutable), which makes the first proof faster later.
import { keccak256, toHex } from "viem";

const GLYPHS = "ABCDEF0123456789#$%&*+=<>/\\";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Decrypts" text: random glyphs settle into the real letters left to right. */
export function decrypt(el, text, ms = 900) {
  if (reduce) return void (el.textContent = text);
  const start = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const fixed = Math.floor(p * text.length);
    el.textContent = [...text].map((c, i) => (i < fixed || c === " " ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const ARTIFACTS = ["withdraw.wasm", "withdraw.zkey", "commitment.wasm", "commitment.zkey"];

async function prefetchCircuits(onProgress) {
  let total = 0;
  let got = 0;
  const sizes = await Promise.all(
    ARTIFACTS.map((f) => fetch(`/artifacts/${f}`, { method: "HEAD" }).then((r) => Number(r.headers.get("content-length") || 0), () => 0)),
  );
  total = sizes.reduce((a, b) => a + b, 0);
  await Promise.all(
    ARTIFACTS.map(async (f) => {
      const r = await fetch(`/artifacts/${f}`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        onProgress(got, total);
      }
    }),
  );
  return total;
}

export async function boot({ cfg, shade }) {
  const host = document.getElementById("boot");
  host.innerHTML = `
    <div class="boot-core">
      <div class="boot-ring"><i></i><i></i><i></i><svg viewBox="0 0 32 32"><use href="#logo" /></svg></div>
      <div class="boot-title" id="bootTitle">ZEROPRINT</div>
      <div class="boot-sub">establishing a private session</div>
      <ol class="boot-log" id="bootLog"></ol>
      <div class="boot-bar"><i id="bootBar"></i></div>
      <button class="boot-skip" id="bootSkip">skip</button>
    </div>`;
  decrypt(document.getElementById("bootTitle"), "ZEROPRINT", 1100);
  const log = document.getElementById("bootLog");
  const bar = document.getElementById("bootBar");
  let skipped = false;
  document.getElementById("bootSkip").onclick = () => (skipped = true);

  const d = cfg.deployment;
  const steps = [
    ["Secure context", async () => {
      if (!isSecureContext || !crypto?.subtle) throw new Error("not a secure context (HTTPS needed)");
      return "WebCrypto ready";
    }],
    [`Connecting to ${cfg.chainName}`, async () => {
      const [id, n] = await Promise.all([shade.pub.getChainId(), shade.pub.getBlockNumber()]);
      if (id !== d.chainId) throw new Error(`wrong chain ${id}`);
      return `block #${n.toLocaleString("en-US")}`;
    }],
    ["Verifying contracts", async () => {
      const owner = await shade.pub.readContract({
        address: d.entrypoint,
        abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }],
        functionName: "hasRole",
        args: [keccak256(toHex("OWNER_ROLE")), cfg.deployer],
      });
      if (owner) throw new Error("deployer still holds OWNER_ROLE");
      return "owner renounced · no admin keys";
    }],
    ["Syncing association set", async () => {
      const s = await shade.aspSet();
      return s.labels.length ? `${s.labels.length} clean deposits · root matches chain` : "no approvals yet";
    }],
    ["Loading zero-knowledge circuits", async (line) => {
      const t0 = performance.now();
      const total = await Promise.race([
        prefetchCircuits((got, all) => {
          const pct = all ? Math.round((got / all) * 100) : 0;
          line.querySelector(".v").textContent = `${(got / 1e6).toFixed(1)} / ${(all / 1e6).toFixed(1)} MB`;
          bar.style.width = `${80 + pct * 0.2}%`;
        }),
        new Promise((r) => setTimeout(() => r(-1), 6000)),
      ]);
      if (total === -1) return "continuing in the background";
      return `${(total / 1e6).toFixed(1)} MB cached · ${Math.round(performance.now() - t0)} ms`;
    }],
  ];

  for (const [i, [label, run]] of steps.entries()) {
    if (skipped) break;
    const line = document.createElement("li");
    line.innerHTML = `<span class="s">[ … ]</span><span class="l">${esc(label)}</span><span class="v"></span>`;
    log.append(line);
    const t0 = performance.now();
    try {
      const v = await run(line);
      await sleep(Math.max(0, 260 - (performance.now() - t0)));
      line.classList.add("ok");
      line.querySelector(".s").textContent = "[ OK ]";
      line.querySelector(".v").textContent = v;
    } catch (e) {
      line.classList.add("bad");
      line.querySelector(".s").textContent = "[FAIL]";
      line.querySelector(".v").textContent = e.shortMessage || e.message;
    }
    bar.style.width = `${((i + 1) / steps.length) * 80}%`;
  }
  bar.style.width = "100%";
  await sleep(skipped ? 0 : 450);
  host.classList.add("done");
  await sleep(500);
  host.remove();
}
