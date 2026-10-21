// Footprint: a read-only scan of a wallet's public money trail, so users see what an
// observer already knows before they deposit, and check a fresh wallet after withdrawing.
// Data comes from a wallet-tracer service (proxied at /footprint-api); this file only
// summarises and draws it. Lives on its own page, /footprint?addr=…&chain=….
import { mountLinkTree } from "./linktree.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? ""));

const CHAINS = [
  ["auto", "All chains"],
  ["4663", "Robinhood"],
  ["1", "Ethereum"],
  ["56", "BNB Chain"],
  ["8453", "Base"],
  ["792703809", "Solana"],
];
const CHAIN_NAMES = { 4663: "Robinhood", 1: "Ethereum", 56: "BNB Chain", 8453: "Base", 792703809: "Solana" };

const ico = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const KIND = {
  bridge: ["Bridge", ico('<path d="M3 16h18M5 16V9a7 7 0 0 1 14 0v7M9 16v-4M15 16v-4"/>')],
  cex: ["Exchange", ico('<path d="M4 9h16L12 4 4 9Z"/><path d="M6 9v8M10 9v8M14 9v8M18 9v8M4 20h16"/>')],
  wallet: ["Wallet", ico('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12.5h2M3 9h18"/>')],
  dex: ["Swap", ico('<path d="M7 7h11l-3-3M17 17H6l3 3"/>')],
  privacy: ["Privacy pool", ico('<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z"/>')],
  multisend: ["Multisender", ico('<path d="M4 12h6M10 12l4-5h6M10 12l4 5h6"/>')],
  fees: ["Fees", ico('<circle cx="12" cy="12" r="8"/><path d="M12 8v8M9.5 10.5h4a1.5 1.5 0 0 1 0 3h-3"/>')],
  swapservice: ["Swap service", ico('<path d="M4 12a8 8 0 0 1 14-5l2-2v6h-6l2.5-2.5A5 5 0 0 0 7 12M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2.5 2.5A5 5 0 0 0 17 12"/>')],
  service: ["Service wallet", ico('<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>')],
  unknown: ["Unknown", ico('<circle cx="12" cy="12" r="8"/><path d="M10 9.5a2 2 0 1 1 2.8 1.8c-.6.3-.8.8-.8 1.4M12 16h.01"/>')],
};

// "api" (the bridge's own record, nothing matched on the destination chain yet) gets no badge:
// the row already shows which chain transactions were found.
const PROOF = {
  verified: ["Verified on-chain", "ok"],
  likely: ["Likely match", "mid"],
};

function ago(t, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - t));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 2 * 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const amt = (a, sym) => (a == null ? "" : `${Number(a).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${sym ?? ""}`.trim());
const usd = (v) => (v == null ? "" : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`);
const ext = (url, text) => (url ? `<a class="fp-ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)} ↗</a>` : "");
const scanLink = (addr) => (addr ? `<a class="fp-addr mono" href="/footprint?addr=${esc(addr)}" title="Scan this wallet">${esc(short(addr))}</a>` : "");

function legRow(l) {
  const [kindName, icon] = l.service ? KIND.service : (KIND[l.kind] ?? KIND.unknown);
  const bridge = l.kind === "bridge";
  const pending = bridge && !l.to?.tx && l.proof?.status !== "likely";
  const other = l.dir === "in" ? l.from : l.to;
  const route = bridge ? `${esc(l.from?.chainName ?? "?")} → ${esc(l.to?.chainName ?? "?")}` : esc(l.from?.chainName ?? "");
  const sent = amt(l.asset?.amountIn, l.asset?.in);
  const got =
    l.asset?.amountOut != null && (l.asset.amountOut !== l.asset.amountIn || l.asset.out !== l.asset.in)
      ? ` → ${esc(amt(l.asset.amountOut, l.asset.out))}`
      : "";
  const [plabel, pcls] = pending ? ["Pending", "mid"] : (PROOF[l.proof?.status] ?? []);
  const checks = (l.proof?.checks ?? []).map((c) => `<li class="${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "✗"} ${esc(c.text)}</li>`).join("");
  return `<div class="fp-leg k-${esc(l.kind)}">
    <div class="fp-ic">${icon}</div>
    <div class="fp-body">
      <div class="fp-l1"><b>${esc(l.service ? "Service wallet" : (l.via ?? kindName))}</b>${l.self ? '<span class="fp-tag">own wallet</span>' : ""}${
        l.service ? `<span class="fp-tag" title="Likely an exchange, bridge solver or payment service">${Number(l.serviceTx).toLocaleString("en-US")}${l.serviceTxAtLeast ? "+" : ""} tx</span>` : ""
      }<span class="fp-route">${route}</span><span class="fp-age">${l.from?.time ? esc(ago(l.from.time)) : ""}</span></div>
      <div class="fp-l2"><span class="fp-amt">${esc(sent)}${got}</span><span class="fp-usd">${esc(usd(l.asset?.usd))}</span></div>
      <div class="fp-l3">${l.self ? "" : scanLink(other?.address)}${ext(l.from?.txUrl, bridge ? `${l.from?.chainName ?? ""} tx` : "tx")}${bridge ? ext(l.to?.txUrl, `${l.to?.chainName ?? ""} tx`) : ""}
        ${plabel ? `<details class="fp-proof p-${pcls}"><summary>${esc(plabel)}</summary>${checks ? `<ul>${checks}</ul>` : ""}</details>` : ""}</div>
    </div>
  </div>`;
}

/** What an observer learns, from the legs alone. */
function exposure(r) {
  const legs = [...r.in, ...r.out];
  const by = (k) => legs.filter((l) => l.kind === k);
  const cex = [...new Set(by("cex").map((l) => l.via).filter(Boolean))];
  const bridges = by("bridge");
  const services = by("wallet").filter((l) => l.service && !l.self);
  const wallets = new Set(
    by("wallet")
      .filter((l) => !l.self && !l.service)
      .map((l) => (l.dir === "in" ? l.from?.address : l.to?.address))
      .filter(Boolean),
  );
  const privacy = by("privacy").length;
  const findings = [];
  if (cex.length)
    findings.push(["high", `Linked to ${cex.length === 1 ? "an exchange" : `${cex.length} exchanges`}: ${cex.map(esc).join(", ")}`, "Exchanges keep identity (KYC) records, so this wallet can be tied to a person.", "Source: on-chain transfers to or from addresses labelled as that exchange"]);
  if (wallets.size)
    findings.push(["mid", `${wallets.size} direct wallet link${wallets.size > 1 ? "s" : ""}`, "Anyone can follow these transfers to other wallets and group them as one owner.", "Source: on-chain transfers"]);
  if (bridges.length) {
    const n = (s) => bridges.filter((l) => l.proof?.status === s).length;
    const proof = [[n("verified"), "verified on-chain"], [n("likely"), "likely match"]].filter(([k]) => k).map(([k, t]) => `${k} ${t}`).join(", ");
    findings.push(["mid", `${bridges.length} bridge hop${bridges.length > 1 ? "s" : ""}`, "Bridges connect this wallet to its addresses on other chains.", `Source: bridge APIs, re-checked on both chains${proof ? ` (${proof})` : ""}`]);
  }
  const ff = r.firstFunder;
  if (ff?.kind === "bridge")
    findings.push(["mid", `Funded via ${ff.via ?? "a"} bridge from ${ff.from?.chainName ?? "another chain"}`, "The first money came over a bridge; Footprint links both sides of the bridge transfer.", "Source: the wallet's first incoming transfer"]);
  if (services.length) {
    const top = services.reduce((a, b) => (b.serviceTx > a.serviceTx ? b : a));
    findings.push([
      "mid",
      `${services.length === 1 ? "A busy service wallet" : `${services.length} busy service wallets`} on the trail`,
      `${Number(top.serviceTx).toLocaleString("en-US")}${top.serviceTxAtLeast ? "+" : ""} transactions: likely an exchange, bridge solver or payment service. Its money is pooled, so the trail stops there.`,
      "Source: the counterparty's on-chain transaction count",
    ]);
  }
  if (privacy) findings.push(["low", `${privacy} privacy-pool transfer${privacy > 1 ? "s" : ""}`, "These links are broken on-chain; the pool hides which deposit is whose.", "Source: transfers with known privacy-pool contracts"]);
  if (!legs.length) findings.push(["low", "No public money trail found", "Nothing in or out on the scanned chains yet.", "Source: the chains listed above"]);
  const level = findings.some((f) => f[0] === "high") ? "high" : findings.some((f) => f[0] === "mid") ? "mid" : "low";
  return { level, findings, total: legs.length };
}


// ---------- Token launches: the server follows the money two hops across chains ----------
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? "");
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a ?? "") && !isEvm(a);
const norm = (a) => (isEvm(a) ? a.toLowerCase() : a);
const CHAIN_LABEL = { robinhood: "Robinhood", solana: "Solana", ethereum: "Ethereum" };
const EXPLORER = {
  robinhood: "https://robin.etherscan.io/token/",
  solana: "https://solscan.io/token/",
  ethereum: "https://etherscan.io/token/",
};
const GMGN = {
  robinhood: "https://gmgn.ai/robinhood/token/",
  solana: "https://gmgn.ai/sol/token/",
  ethereum: "https://gmgn.ai/eth/token/",
};
const ICON_EXPLORER = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/></svg>`;

/** Robinhood launches for many addresses at once (instant, from the index). Also used by the link tree. */
export async function lookupLaunches(addrs) {
  const list = [...new Set(addrs.filter(isEvm).map((a) => a.toLowerCase()))];
  if (!list.length) return {};
  const r = await fetch(`/footprint-api/launches?addr=${list.join(",")}`).catch(() => null);
  if (!r?.ok) return {};
  return (await r.json()).launches ?? {};
}

/** Direct links of the scanned wallet, for the instant first answer. */
function directLinks(r) {
  const rel = new Map([[norm(r.address), null]]);
  for (const l of [...r.in, ...r.out]) {
    if (l.kind !== "wallet" && l.kind !== "bridge") continue;
    const other = l.dir === "in" ? l.from : l.to;
    const a = norm(other?.address);
    if (!(isEvm(a) || isSol(a)) || rel.has(a)) continue;
    rel.set(a, l.kind === "bridge" ? (l.dir === "out" ? "bridged to" : "bridged from") : l.dir === "out" ? "sent funds to" : "got funds from");
  }
  return rel;
}

const usdShort = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`);
const PEAK_CHAINS = new Set(["solana", "ethereum", "robinhood"]);

// Peaks for Solana/Ethereum tokens come from the server (GeckoTerminal, slow and approximate),
// Robinhood ones from the launch index (instant); one at a time, and since rows re-render
// often, answers are kept here and re-applied.
const peaks = new Map(); // "chain:token" -> { text, title }
const peakQueue = [];
let peakBusy = false;
function hydratePeaks(root) {
  root.querySelectorAll("[data-peak]").forEach((el) => {
    const k = el.dataset.peak;
    const v = peaks.get(k);
    if (v) {
      el.textContent = v.text;
      el.title = v.title;
    } else {
      if (!peakQueue.includes(k)) peakQueue.push(k);
      el.textContent = " · peak …";
    }
  });
  if (!peakBusy) nextPeak();
}
async function nextPeak() {
  const k = peakQueue.find((x) => !peaks.has(x));
  if (!k) return void (peakBusy = false);
  peakBusy = true;
  const [chain, token] = k.split(":");
  let v = null;
  if (chain === "robinhood") {
    const t = (await fetch(`/footprint-api/token?addr=${encodeURIComponent(token)}`).then((r) => r.json()).catch(() => ({}))).token;
    v = t?.peak_mc_usd ? { text: ` · peak ${usdShort(t.peak_mc_usd)}`, title: "Peak market cap, from our Robinhood Chain index" } : { text: "", title: "" };
  }
  for (let i = 0; i < 12 && !v; i++) {
    const j = await fetch(`/footprint-api/peak?chain=${chain}&token=${encodeURIComponent(token)}`).then((r) => (r.ok ? r.json() : { peak: null })).catch(() => ({ peak: null }));
    if (j.pending) continue;
    const p = j.peak;
    const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
    v = p
      ? { text: ` · peak ~${usdShort(p.peakUsd)}`, title: `Approximate peak market cap on ${day(p.at)}, from GeckoTerminal daily candles (history from ${day(p.since)})` }
      : { text: "", title: "" };
  }
  peaks.set(k, v ?? { text: "", title: "" });
  document.querySelectorAll(`[data-peak="${CSS.escape(k)}"]`).forEach((el) => {
    el.textContent = peaks.get(k).text;
    el.title = peaks.get(k).title;
  });
  nextPeak();
}

function tokenRow(l) {
  const when = l.ts ? new Date(l.ts * 1000).toISOString().slice(0, 10) : l.block ? `block ${l.block}` : "";
  const bits = [l.launchpad, when, l.peak_mc_usd ? `peak ${usdShort(l.peak_mc_usd)}` : ""].filter(Boolean).join(" · ");
  const askPeak = !l.peak_mc_usd && PEAK_CHAINS.has(l.chain) && l.token;
  const ex = EXPLORER[l.chain];
  const gm = GMGN[l.chain];
  return `<div class="fp-lrow">
      <span class="fp-lname">${esc(l.name || "Unnamed")} <i>${esc(l.symbol ? `$${l.symbol}` : "")}</i></span>
      <span class="fp-lmeta"><b class="fp-chain c-${esc(l.chain)}">${esc(CHAIN_LABEL[l.chain] ?? l.chain)}</b> ${esc(bits)}${askPeak ? `<span data-peak="${esc(l.chain)}:${esc(l.token)}"></span>` : ""}</span>
      <span class="fp-licons">
        ${ex ? `<a class="fp-ico" href="${ex}${esc(l.token)}" target="_blank" rel="noopener noreferrer" title="Contract on the explorer">${ICON_EXPLORER}</a>` : ""}
        ${gm ? `<a class="fp-ico gmgn" href="${gm}${esc(l.token)}" target="_blank" rel="noopener noreferrer" title="Open on GMGN"><img src="/gmgn.png" alt="GMGN" width="20" height="20" /></a>` : ""}
      </span>
    </div>`;
}

/** [{addr, how}, …, {addr}]: "This wallet — bridged from → 3ntf… — got SOL from → 9YGZ…" */
function pathHtml(path) {
  return `<div class="fp-path">${path
    .map(
      (p, i) =>
        `${i === 0 ? `<span class="fp-pchip me">This wallet</span>` : `<a class="fp-pchip mono" href="/footprint?addr=${esc(p.addr)}" title="${esc(p.addr)}">${esc(short(p.addr))}</a>`}${
          p.how ? `<span class="fp-parrow">${esc([p.how, p.via, p.chainName].filter(Boolean).join(" · "))} →</span>` : ""
        }`,
    )
    .join("")}</div>`;
}

function findingCard(f) {
  if (f.kind === "launched") {
    const self = f.path.length === 1;
    return `<div class="fp-lgroup">
        ${self ? "" : pathHtml(f.path)}
        <div class="fp-lwho"><span class="fp-rel">${self ? "Launched by this wallet" : "Launched by a wallet on this money trail"}</span><b>${f.total} launch${f.total > 1 ? "es" : ""}</b></div>
        ${f.launches.slice(0, 5).map(tokenRow).join("")}
        ${f.total > 5 ? `<div class="fp-lmore">and ${f.total - 5} more</div>` : ""}
      </div>`;
  }
  // bundle pattern
  const n = f.bundleWallets ?? f.wallets?.length ?? 0;
  const speed =
    f.secondsAfterLaunch != null
      ? f.secondsAfterLaunch <= 1
        ? "in its launch block"
        : `within ${f.secondsAfterLaunch}s of launch`
      : f.chain === "robinhood"
        ? "within 3 blocks of launch"
        : "right at launch";
  const flow = f.deployerFlow && !f.deployerFlow.self ? ` The deployer ${f.deployerFlow.sentToHub ? `sent ${f.deployerFlow.sentToHub.toFixed(3)} SOL to` : `got ${f.deployerFlow.gotFromHub.toFixed(3)} SOL from`} the same wallet.` : "";
  const deployer = f.creatorPath?.length === 1
    ? `<div class="fp-sub">Deployer: this wallet</div>`
    : f.creatorPath
      ? `<div class="fp-sub">Deployer on this trail:</div>${pathHtml(f.creatorPath)}`
    : f.creator
      ? `<div class="fp-sub">Deployer: ${scanLink(f.creator)}</div>`
      : "";
  return `<div class="fp-lgroup">
      ${f.hubPath && f.hubPath.length > 1 ? pathHtml(f.hubPath) : ""}
      <div class="fp-lwho"><span class="fp-rel">Bundle pattern</span><b>${n} linked wallets</b></div>
      ${tokenRow({ ...f, chain: f.chain })}
      <p class="fp-why">${n} wallets linked to this one bought it ${esc(speed)}.${esc(flow)}</p>
      ${deployer}
    </div>`;
}

function renderLaunches(out, j, state) {
  const host = out.querySelector("#fpLaunches");
  const box = out.querySelector(".fp-findings");
  box.querySelectorAll(".fp-find.launch").forEach((e) => e.remove());
  // a deployer whose only launch is already shown as a bundle (with its path) needs no second card
  const bundled = new Set((state.findings ?? []).filter((f) => f.kind === "bundle" && f.creatorPath).map((f) => `${f.creator}:${f.token}`));
  const fs = (state.findings ?? []).filter(
    (f) => !(f.kind === "launched" && f.path.length > 1 && f.launches.every((l) => bundled.has(`${f.addr}:${l.token}`))),
  );
  if (!fs.length) {
    // nothing found (yet): while the search runs say so quietly; when it ends, show nothing
    host.innerHTML = state.done ? "" : `<div class="fp-follow"><span class="spin"></span>Checking linked wallets for token launches… ${state.nodes ?? 1} wallets so far</div>`;
    return;
  }
  const chains = [...new Set(fs.flatMap((f) => (f.kind === "launched" ? f.launches.map((l) => l.chain) : [f.chain])))].map((c) => CHAIN_LABEL[c] ?? c);
  const order = (f) => (f.kind === "launched" ? f.path.length : 1.5);
  host.innerHTML = `<section class="fp-launch">
      <div class="fp-h">Token launches · ${esc(chains.join(", "))} <span>${fs.length}</span></div>
      ${[...fs].sort((a, b) => order(a) - order(b)).map(findingCard).join("")}
      ${state.done ? "" : `<div class="fp-follow"><span class="spin"></span>Following the money… ${state.nodes ?? 1} wallets checked</div>`}
    </section>`;
  // headline findings
  hydratePeaks(host);
  const me = fs.find((f) => f.kind === "launched" && f.path.length === 1);
  const others = fs.filter((f) => f.kind === "launched" && f.path.length > 1).length;
  const bundle = fs.find((f) => f.kind === "bundle" && f.creator !== norm(j.address));
  const msgs = [];
  if (me) msgs.push([`Launched ${me.total} token${me.total > 1 ? "s" : ""}`, "Every launch is public and tied to this wallet as its creator.", "Source: token creation transactions"]);
  if (others) msgs.push([`${others} wallet${others > 1 ? "s" : ""} on this money trail launched tokens`, "Up to two hops away, through transfers or bridges, on this chain or another.", "Source: on-chain transfers, then token creation transactions"]);
  if (bundle) msgs.push([`Linked to the ${bundle.symbol ? `$${bundle.symbol}` : ""} launch`, "Wallets linked to this one bought it right at launch, a bundle pattern.", "Source: buys in the token's first blocks, from wallets linked by transfers"]);
  for (const [t, d, src] of msgs.reverse())
    box.insertAdjacentHTML("afterbegin", `<div class="fp-find lv-high launch"><i></i><div><b>${esc(t)}</b><p>${esc(d)}</p><small class="fp-src">${esc(src)}</small></div></div>`);
}

/** A token contract or mint has no money trail of its own: say what it is and who made it. */
async function showToken(out, r) {
  if (!r.isContract && !isSol(r.address)) return;
  const j = await fetch(`/footprint-api/token?addr=${encodeURIComponent(r.address)}`).then((x) => x.json()).catch(() => ({}));
  const t = j.token;
  if (!t) return;
  // a wallet's exposure score and "no money trail" don't apply to a token
  if (!r.in.length && !r.out.length) {
    out.querySelector(".fp-head .fp-h").textContent = "Token";
    out.querySelector(".fp-score")?.remove();
    out.querySelectorAll(".fp-findings .fp-find:not(.launch)").forEach((e) => e.remove());
  }
  const host = out.querySelector("#fpToken");
  host.innerHTML = `<section class="fp-launch">
      <div class="fp-h">This address is a token</div>
      ${tokenRow(t)}
      <p class="fp-why">A token has no money trail of its own.${
        t.creator ? ` It was created by <a class="mono" href="/footprint?addr=${esc(t.creator)}">${esc(short(t.creator))}</a>: <a href="/footprint?addr=${esc(t.creator)}">scan the creator →</a>` : ""
      }</p>
    </section>`;
  hydratePeaks(host);
}

const LEVEL = { high: "High exposure", mid: "Moderate exposure", low: "Low exposure" };

// ---------- Money map: counterparties left (in) and right (out) of the wallet ----------
const KIND_COLOR = {
  cex: "#ff6b81",
  bridge: "#6aa8ff",
  privacy: "#7ce7d0",
  dex: "#b892ff",
  swapservice: "#b892ff",
  multisend: "#ffcc66",
  fees: "#ffcc66",
  wallet: "#8fa3c0",
  service: "#ffcc66",
  unknown: "#5d6b80",
};
const MAP_MAX = 9;

function groupLegs(legs) {
  const by = new Map();
  for (const l of legs) {
    const other = l.dir === "in" ? l.from : l.to;
    const kind = l.service ? "service" : l.kind;
    const key = l.kind === "wallet" || !l.via ? `${kind}:${other?.address}` : `${kind}:${l.via}`;
    const g = by.get(key) ?? { kind, name: l.kind === "wallet" || !l.via ? short(other?.address) : l.via, address: l.kind === "wallet" ? other?.address : null, usd: 0, n: 0, chains: new Set(), self: l.self };
    g.usd += Number(l.asset?.usd ?? 0);
    g.n++;
    if (l.from?.chainName) g.chains.add(l.from.chainName);
    by.set(key, g);
  }
  const all = [...by.values()].sort((a, b) => b.usd - a.usd || b.n - a.n);
  if (all.length <= MAP_MAX) return all;
  const rest = all.slice(MAP_MAX - 1);
  return [
    ...all.slice(0, MAP_MAX - 1),
    { kind: "unknown", name: `${rest.length} more`, usd: rest.reduce((s, g) => s + g.usd, 0), n: rest.reduce((s, g) => s + g.n, 0), chains: new Set(), more: true },
  ];
}

function moneyMap(r) {
  const L = groupLegs(r.in);
  const R = groupLegs(r.out);
  if (!L.length && !R.length) return "";
  const W = 1000;
  const row = 52;
  const H = Math.max(260, Math.max(L.length, R.length) * row + 40);
  const cx = W / 2;
  const cy = H / 2;
  const maxUsd = Math.max(1, ...L.map((g) => g.usd), ...R.map((g) => g.usd));
  const width = (g) => 1.2 + 7 * Math.sqrt(g.usd / maxUsd);
  const ys = (n) => Array.from({ length: n }, (_, i) => (n === 1 ? cy : 30 + ((H - 60) / (n - 1)) * i));
  const fmt = (g) => `${g.usd ? usd(g.usd) : ""}${g.usd ? " · " : ""}${g.n} tx`;
  const node = (g, x, y, side) => {
    const c = KIND_COLOR[g.kind] ?? KIND_COLOR.unknown;
    const anchor = side === "L" ? "end" : "start";
    const tx = side === "L" ? x - 14 : x + 14;
    const label = `<text x="${tx}" y="${y - 3}" text-anchor="${anchor}" class="m-name">${esc(g.name)}${g.self ? " (own)" : ""}</text>
      <text x="${tx}" y="${y + 13}" text-anchor="${anchor}" class="m-sub">${esc(fmt(g))}${g.chains.size ? ` · ${esc([...g.chains].join(", "))}` : ""}</text>`;
    const dot = `<circle cx="${x}" cy="${y}" r="7" fill="${c}" fill-opacity=".18" stroke="${c}" stroke-width="1.5"/><circle cx="${x}" cy="${y}" r="2.5" fill="${c}"/>`;
    const body = `<g class="m-node">${dot}${label}<title>${esc(KIND[g.kind]?.[0] ?? "Unknown")}: ${esc(g.name)} · ${esc(fmt(g))}</title></g>`;
    return g.address && !g.self ? `<a href="/footprint?addr=${esc(g.address)}" class="m-link">${body}</a>` : body;
  };
  const edge = (x1, y1, x2, y2, g, dir) => {
    const c = KIND_COLOR[g.kind] ?? KIND_COLOR.unknown;
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${c}" stroke-width="${width(g).toFixed(1)}" stroke-opacity=".28" fill="none"/>
      <path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" stroke="${c}" stroke-width="${Math.max(1, width(g) / 2).toFixed(1)}" fill="none" class="m-flow ${dir}"/>`;
  };
  const lx = 300;
  const rx = 700;
  const ly = ys(L.length);
  const ry = ys(R.length);
  const edges = [...L.map((g, i) => edge(lx, ly[i], cx - 34, cy, g, "in")), ...R.map((g, i) => edge(cx + 34, cy, rx, ry[i], g, "out"))].join("");
  const nodes = [...L.map((g, i) => node(g, lx, ly[i], "L")), ...R.map((g, i) => node(g, rx, ry[i], "R"))].join("");
  const center = `<g class="m-center">
      <circle cx="${cx}" cy="${cy}" r="48" class="m-halo"/>
      <circle cx="${cx}" cy="${cy}" r="34" fill="#0c1018" stroke="#7ce7d0" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="41" fill="none" stroke="#7ce7d0" stroke-opacity=".35" stroke-dasharray="3 6" class="m-spin"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="m-me">${esc(r.address.slice(0, 6))}</text>
      <text x="${cx}" y="${cy + 11}" text-anchor="middle" class="m-me">…${esc(r.address.slice(-4))}</text>
    </g>`;
  const legend = Object.entries({ cex: "Exchange", bridge: "Bridge", wallet: "Wallet", service: "Service", dex: "Swap", privacy: "Privacy pool" })
    .map(([k, t]) => `<span><i style="background:${KIND_COLOR[k]}"></i>${t}</span>`)
    .join("");
  return `<div class="fp-map">
      <div class="fp-maphead"><div class="fp-h">Who sent money in, and where it went</div><div class="fp-legend">${legend}</div></div>
      <div class="fp-mapcols"><span>← Money in</span><span>Money out →</span></div>
      <svg viewBox="0 0 ${W} ${H}" class="fp-svg" role="img" aria-label="Money map: where this wallet's money came from and went">${edges}${center}${nodes}</svg>
      <p class="fp-fine">Line width follows the USD value. Click a wallet to scan it.</p>
    </div>`;
}

/** What a scan cannot show, so nobody reads "nothing found" as "nothing there". */
function limits(r) {
  const items = [
    r.capped && "This wallet is busy: only its most recent transactions were read, so older links may be missing.",
    r.partial?.length && `${r.partial.join(", ")} did not answer this time; those links may be missing.`,
    "Inside an exchange: deposits and withdrawals are linked in its private records (KYC), not on-chain.",
    "Privacy pools and mixers: which deposit paid which withdrawal is hidden by design.",
    "Busy service wallets (exchanges, bridge solvers, payment services) pool many people's money, so the trail stops there.",
    "Cash, OTC and peer-to-peer trades, and transfers on chains or bridges not listed above.",
    "Off-chain links: reused usernames, IP addresses, the same habits on two wallets.",
  ].filter(Boolean);
  return `<details class="fp-limits"><summary>What Footprint can't see</summary><ul>${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>`;
}

function report(r) {
  const x = exposure(r);
  const flags = [
    r.isContract && `<span class="fp-flag">Contract, not a personal wallet</span>`,
    r.capped && `<span class="fp-flag">Busy wallet: partial history</span>`,
    r.cached && `<span class="fp-flag dim">cached</span>`,
  ]
    .filter(Boolean)
    .join("");
  const first = r.firstFunder ? `<div class="fp-first"><div class="fp-h">First funder</div>${legRow(r.firstFunder)}</div>` : "";
  const col = (title, legs, empty) =>
    `<section class="fp-col"><div class="fp-h">${title} <span>${legs.length}</span></div>${legs.length ? legs.map(legRow).join("") : `<p class="fp-empty">${empty}</p>`}</section>`;
  return `
    <div class="fp-head">
      <div>
        <div class="fp-h">Wallet</div>
        <div class="fp-wallet mono">${esc(r.address)}</div>
        <div class="fp-chains">${r.chains.map((c) => `<span>${esc(CHAIN_NAMES[c] ?? c)}</span>`).join("")}${flags}</div>
      </div>
      <div class="fp-score lv-${x.level}"><b>${LEVEL[x.level]}</b><span>${x.total} public transfer${x.total === 1 ? "" : "s"}</span></div>
    </div>
    ${r.partial?.length ? `<div class="note warn">Some sources didn't answer this time: ${r.partial.map(esc).join(", ")}. The rest is below.</div>` : ""}
    <div id="fpToken"></div>
    <div class="fp-findings">${x.findings
      .map(([lv, t, d, src]) => `<div class="fp-find lv-${lv}"><i></i><div><b>${t}</b><p>${esc(d)}</p>${src ? `<small class="fp-src">${esc(src)}</small>` : ""}</div></div>`)
      .join("")}</div>
    <div id="fpLaunches"></div>
    ${limits(r)}
    <div class="fp-viz">
      <div class="fp-vtabs" role="tablist">
        <button class="on" data-v="map">Money map</button>
        <button data-v="tree">Link tree</button>
      </div>
      <div class="fp-vpane" data-p="map">${moneyMap(r) || `<p class="fp-empty">No transfers to map.</p>`}</div>
      <div class="fp-vpane" data-p="tree" hidden>
        <p class="fp-fine">Click a wallet (+) to load its own links and follow the money further. Arrows show which way the money moved.</p>
        <div class="fp-tree" id="fpTree"></div>
      </div>
    </div>
    ${first}
    <div class="fp-cols">${col("Money in", r.in, "No incoming funds found.")}${col("Money out", r.out, "Nothing sent out yet.")}</div>`;
}

export function viewFootprint(el, params) {
  const addr = params.get("addr") ?? "";
  const chain = params.get("chain") ?? "auto";
  el.innerHTML = `
    <div class="fp-title"><h2>Footprint</h2><span class="pill">Wallet exposure scan</span></div>
    <p class="sub">See what anyone can see about a wallet: where its money came from and where it went. Read-only, nothing is signed.
      Scan before you deposit, and scan your fresh wallet after you withdraw.</p>
    <form class="fp-form" id="fpForm">
      <div class="fp-input">
        <input id="fpAddr" class="mono" placeholder="Wallet address: 0x… or a Solana address" value="${esc(addr)}" spellcheck="false" autocomplete="off" />
        <button type="button" class="fp-clear" id="fpClear" title="Clear" aria-label="Clear the address" ${addr ? "" : "hidden"}>✕</button>
      </div>
      <select id="fpChain">${CHAINS.map(([v, t]) => `<option value="${v}" ${v === chain ? "selected" : ""}>${t}</option>`).join("")}</select>
      <button class="btn" type="submit">Scan</button>
    </form>
    <p class="fp-fine">Chains: Robinhood, Ethereum, BNB Chain, Base, Solana. Bridges: Relay, Across, Robinhood Bridge, deBridge, Stargate/LayerZero, each hop re-checked on both chains. Testnets are not scanned.</p>
    <p class="fp-fine">Not logged: no accounts, no analytics, no access logs. Rate limits use a scrambled ID of your IP that changes daily, never the IP itself. Results (public chain data) are cached for up to 6 hours so repeat scans are fast.</p>
    <div id="fpOut"></div>`;
  const input = el.querySelector("#fpAddr");
  const clear = el.querySelector("#fpClear");
  input.addEventListener("input", () => (clear.hidden = !input.value));
  clear.onclick = () => {
    input.value = "";
    clear.hidden = true;
    input.focus();
  };
  el.querySelector("#fpForm").onsubmit = (e) => {
    e.preventDefault();
    const a = el.querySelector("#fpAddr").value.trim();
    if (!a) return el.querySelector("#fpAddr").focus();
    location.href = `/footprint?addr=${encodeURIComponent(a)}&chain=${el.querySelector("#fpChain").value}`;
  };
  if (!addr) return;
  const out = el.querySelector("#fpOut");
  out.innerHTML = `<div class="fp-busy"><span class="spin"></span><span>Scanning ${esc(short(addr))}: reading the chains and the bridges… <b id="fpSecs">0 s</b></span></div>`;
  const t0 = Date.now();
  const tick = setInterval(() => {
    const el = out.querySelector("#fpSecs");
    if (!el) return clearInterval(tick);
    const s = Math.round((Date.now() - t0) / 1000);
    el.textContent = s < 20 ? `${s} s` : `${s} s · busy wallets and new scans can take up to a minute`;
  }, 1000);
  fetch(`/footprint-api/trace?addr=${encodeURIComponent(addr)}&chain=${encodeURIComponent(chain)}`)
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      out.innerHTML = r.ok ? report(j) : `<div class="note bad">${esc(j.error ?? `Scan failed (${r.status})`)}</div>`;
      if (!r.ok) return;
      showToken(out, j);
      // Launches: shown only when something is found. Robinhood index first (instant), then
      // the server's investigation, which follows the money two hops across chains.
      const rel = directLinks(j);
      const quick = await lookupLaunches([...rel.keys()]);
      const root = norm(j.address);
      const quickFindings = Object.entries(quick).map(([a, v]) => ({
        kind: "launched",
        addr: a,
        total: v.total,
        launches: v.recent,
        path: a === root ? [{ addr: a }] : [{ addr: root, how: rel.get(a) }, { addr: a }],
      }));
      renderLaunches(out, j, { findings: quickFindings, done: false, nodes: rel.size });
      const launches = Object.fromEntries(quickFindings.map((f) => [f.addr, { total: f.total }]));
      const t0 = Date.now();
      (async function poll() {
        const r = await fetch(`/footprint-api/investigate?addr=${encodeURIComponent(j.address)}`).catch(() => null);
        const st = r?.ok ? await r.json() : { findings: [], done: true };
        const merged = st.findings.length ? st.findings : quickFindings;
        for (const f of merged) if (f.kind === "launched") launches[f.addr] = { total: f.total };
        renderLaunches(out, j, { ...st, findings: merged });
        if (!st.done && Date.now() - t0 < 240_000) setTimeout(poll, 2500);
        else if (!st.done) renderLaunches(out, j, { ...st, findings: merged, done: true });
      })();
      let treeMounted = false;
      out.querySelectorAll(".fp-vtabs button").forEach((b) =>
        b.addEventListener("click", () => {
          out.querySelectorAll(".fp-vtabs button").forEach((x) => x.classList.toggle("on", x === b));
          out.querySelectorAll(".fp-vpane").forEach((p) => (p.hidden = p.dataset.p !== b.dataset.v));
          if (b.dataset.v === "tree" && !treeMounted) {
            mountLinkTree(out.querySelector("#fpTree"), j, { lookupLaunches, launches });
            treeMounted = true;
          }
        }),
      );
    })
    .catch(() => (out.innerHTML = `<div class="note bad">The scan service is not reachable right now.</div>`));
}
