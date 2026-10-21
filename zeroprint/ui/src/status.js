// /status: live health of every part. Server numbers come from /status-api; the ASP root is
// also re-checked here in the browser against the chain, like the app does before a withdrawal.
import "./style.css";
import { formatEther } from "viem";
import { createShade } from "./core.js";
import { mountMobileNav } from "./mnav.js";
import { crowd as sceneCrowd, runScene } from "./scenes.js";

mountMobileNav();
runScene(document.getElementById("fx"), sceneCrowd());

const view = document.getElementById("view");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const eth = (wei, dp = 5) => (wei == null ? "–" : Number(formatEther(BigInt(wei))).toFixed(dp).replace(/\.?0+$/, ""));
const ago = (s) => (s == null ? "–" : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const WITHDRAW_GAS_ETH = 10_600_000_000_000n; // ≈ what one relayed withdrawal costs on Robinhood Chain

const cfg = await fetch("/config.json", { cache: "no-store" }).then((r) => r.json());
const api = cfg.api ?? location.origin;
const shade = createShade({ rpcUrl: cfg.rpcUrl ?? `${location.origin}/rpc`, chainName: cfg.chainName, deployment: cfg.deployment, aspUrl: `${api}/asp`, relayerUrl: `${api}/relayer` });
const explorer = (a) => (cfg.explorer ? `<a class="mono" href="${cfg.explorer}/address/${a}" target="_blank" rel="noreferrer">${a.slice(0, 6)}…${a.slice(-4)}</a>` : a);

/** ok | warn | bad, with the reason shown next to it */
const row = (level, name, value, why = "") =>
  `<div class="st-row ${level}"><span class="dot"></span><span class="k">${name}</span><span class="v">${value}</span>${why ? `<span class="why">${why}</span>` : ""}</div>`;

let rootCheck = "checking…";
async function checkRoot() {
  try {
    const s = await shade.aspSet();
    rootCheck = s.labels.length ? `✅ matches the chain (${s.labels.length} approved), checked in your browser` : "no approvals yet";
  } catch (e) {
    rootCheck = `⚠️ ${esc(e.shortMessage || e.message)}`;
  }
}

async function draw() {
  let s;
  try {
    s = await fetch(`${api}/status-api`, { cache: "no-store" }).then((r) => r.json());
  } catch {
    view.innerHTML = `<h2>Status</h2><div class="note bad">The status service is unreachable. The contracts keep working without it: see <a href="/docs#trouble">Troubleshooting</a>.</div>`;
    return;
  }
  const rows = [];
  // chain
  const lag = s.chain?.lagSec;
  rows.push(
    s.chain
      ? row(lag > 600 ? "bad" : lag > 120 ? "warn" : "ok", "Chain", `${esc(s.chain.name)} · block #${s.chain.block.toLocaleString("en-US")}`, lag > 120 ? `last block ${ago(lag)}` : `last block ${ago(lag)}`)
      : row("bad", "Chain", "unreachable", "our node does not answer"),
  );
  // pool
  rows.push(row("ok", "Pool", `${eth(s.pool.balance, 4)} ETH`, `${explorer(s.pool.address)}${s.pool.deposits != null ? ` · ${s.pool.deposits} deposits` : ""}`));
  if (s.pool.approved != null)
    rows.push(row(s.pool.pending > 0 ? "warn" : "ok", "ASP screening", `${s.pool.approved} approved · ${s.pool.pending} waiting · ${s.pool.denied} denied`, s.pool.windowSec ? `window ${Math.round(s.pool.windowSec / 60)} min` : ""));
  rows.push(row(rootCheck.startsWith("✅") || rootCheck.startsWith("no") ? "ok" : rootCheck.startsWith("checking") ? "warn" : "bad", "ASP root", rootCheck));
  // screening lists the guardian can deny against
  if (s.screening) {
    const { ofac, blocklist, ofacAt } = s.screening;
    const age = ofacAt ? Math.round((Date.now() - ofacAt) / 1000) : null;
    rows.push(
      row(
        !ofac ? "bad" : age != null && age > 172800 ? "warn" : "ok",
        "Screening lists",
        `${ofac} OFAC ${ofac === 1 ? "address" : "addresses"} · ${blocklist} ZeroPrint ${blocklist === 1 ? "entry" : "entries"}`,
        `${ofac ? `OFAC list refreshed ${ago(age)}` : "OFAC list did not load"} · <a href="/docs#screening">what gets denied</a>`,
      ),
    );
  }
  // keeper
  const k = s.keeper;
  if (!k.up) rows.push(row("bad", "Keeper", "offline", "deposits still get approved: queue and approve yourself from the deposit wallet"));
  else {
    const stale = k.lastTickSec == null || k.lastTickSec > 120;
    const kb = k.balance == null ? null : BigInt(k.balance);
    rows.push(row(!k.ok || stale ? "bad" : "ok", "Keeper", k.ok ? "running" : `error: ${esc(k.error ?? "?")}`, `last check ${ago(k.lastTickSec)}${k.guardian ? " · guardian" : ""}`));
    if (k.address)
      rows.push(row(kb == null ? "warn" : kb < 50_000_000_000_000n ? "bad" : kb < 200_000_000_000_000n ? "warn" : "ok", "Keeper gas", `${eth(k.balance)} ETH`, explorer(k.address)));
  }
  // relayer
  const r = s.relayer;
  const rb = r.balance == null ? null : BigInt(r.balance);
  const left = rb == null ? null : rb / WITHDRAW_GAS_ETH;
  rows.push(row(r.up ? "ok" : "bad", "Relayer", r.up ? "online" : "offline", r.up ? "pays the gas of private withdrawals" : "you can still withdraw directly from a fresh wallet that has gas"));
  if (r.address) rows.push(row(left == null ? "warn" : left < 10n ? "bad" : left < 50n ? "warn" : "ok", "Relayer gas", `${eth(r.balance)} ETH`, `≈ ${left ?? "?"} withdrawals left · ${explorer(r.address)}`));
  // bridges
  if (s.bridges) {
    rows.push(row(s.bridges.relay ? "ok" : "bad", "Bridge: Relay", s.bridges.relay ? "reachable" : "unreachable"));
    rows.push(row(s.bridges.near ? "ok" : "bad", "Bridge: NEAR Intents", s.bridges.near ? "reachable" : "unreachable"));
  }
  rows.push(row("ok", "Site", "online", `up ${ago(s.site.upSec).replace(" ago", "")}`));

  const worst = rows.some((x) => x.includes("st-row bad")) ? "bad" : rows.some((x) => x.includes("st-row warn")) ? "warn" : "ok";
  view.innerHTML = `
    <div class="row"><h2 style="flex:1">Status</h2><span class="pill ${worst === "ok" ? "approved" : worst === "warn" ? "pending" : "denied"}">${
      { ok: "All systems normal", warn: "Degraded", bad: "Problem" }[worst]
    }</span></div>
    <p class="sub">Updated ${new Date(s.at * 1000).toLocaleTimeString()}. Your funds never depend on any of these services: the contracts have no admin, and ragequit always works.</p>
    <div class="st-list">${rows.join("")}</div>`;
}

await draw();
checkRoot().then(draw);
setInterval(draw, 30_000);
setInterval(() => checkRoot(), 120_000);
