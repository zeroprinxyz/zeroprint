// Link tree: the wallet's counterparties as an expandable tree. Click a wallet node to fetch
// its own trace and grow the tree one hop further (same /footprint-api, cached server-side).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const norm = (a) => (/^0x/i.test(a ?? "") ? a.toLowerCase() : a);
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? ""));
const usd = (v) => (v ? `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}` : "");

const COLOR = {
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
  more: "#5d6b80",
};
const KIND_NAME = { service: "Service wallet (trail stops)", cex: "Exchange", bridge: "Bridge", privacy: "Privacy pool", dex: "Swap", swapservice: "Swap service", multisend: "Multisender", fees: "Fees", wallet: "Wallet", unknown: "Unknown" };
const PER_NODE = 10;
const MAX_DEPTH = 4;
const COL_W = 250;
const ROW_H = 38;

let seq = 0;

/** Groups a trace's legs into child nodes, money-in first, biggest first. */
function childrenOf(trace, ancestors) {
  const groups = new Map();
  for (const l of [...trace.in, ...trace.out]) {
    if (l.self) continue;
    const other = l.dir === "in" ? l.from : l.to;
    const isWallet = l.kind === "wallet" || !l.via;
    const kind = l.service ? "service" : l.kind;
    const key = `${l.dir}:${kind}:${isWallet ? other?.address?.toLowerCase() : l.via}`;
    const g =
      groups.get(key) ??
      { id: ++seq, dir: l.dir, kind, name: isWallet ? short(other?.address) : l.via, address: isWallet ? other?.address : null, usd: 0, n: 0, children: null };
    g.usd += Number(l.asset?.usd ?? 0);
    g.n++;
    groups.set(key, g);
  }
  const all = [...groups.values()]
    .map((g) => ({ ...g, cycle: g.address && ancestors.has(g.address.toLowerCase()) }))
    .sort((a, b) => (a.dir === b.dir ? b.usd - a.usd || b.n - a.n : a.dir === "in" ? -1 : 1));
  if (all.length <= PER_NODE) return all;
  const rest = all.slice(PER_NODE - 1);
  return [...all.slice(0, PER_NODE - 1), { id: ++seq, dir: "out", kind: "more", name: `+${rest.length} more`, usd: rest.reduce((s, g) => s + g.usd, 0), n: rest.reduce((s, g) => s + g.n, 0), children: null }];
}

export function mountLinkTree(host, trace, { lookupLaunches = async () => ({}), launches = {} } = {}) {
  const launchN = new Map(Object.entries(launches).map(([a, v]) => [a, v.total]));
  const tagLaunches = async (kids) => {
    const found = await lookupLaunches(kids.map((k) => k.address).filter(Boolean));
    for (const [a, v] of Object.entries(found)) launchN.set(a, v.total);
  };
  const root = { id: ++seq, kind: "root", name: short(trace.address), address: trace.address, depth: 0, children: null, open: true };
  root.children = childrenOf(trace, new Set([trace.address.toLowerCase()]));
  const byId = new Map();

  function layout() {
    byId.clear();
    let row = 0;
    let maxDepth = 0;
    const place = (n, depth, ancestors) => {
      n.depth = depth;
      n.ancestors = ancestors;
      byId.set(n.id, n);
      maxDepth = Math.max(maxDepth, depth);
      const kids = n.open && n.children ? n.children : [];
      if (!kids.length) {
        n.y = row++ * ROW_H + ROW_H / 2 + 10;
      } else {
        const next = new Set(ancestors);
        if (n.address) next.add(n.address.toLowerCase());
        kids.forEach((k) => place(k, depth + 1, next));
        n.y = (kids[0].y + kids[kids.length - 1].y) / 2;
      }
      n.x = 90 + depth * COL_W;
    };
    place(root, 0, new Set());
    return { width: 90 + (maxDepth + 1) * COL_W + 60, height: row * ROW_H + 20 };
  }

  function draw() {
    const { width, height } = layout();
    const edges = [];
    const nodes = [];
    for (const n of byId.values()) {
      const kids = n.open && n.children ? n.children : [];
      for (const k of kids) {
        const c = COLOR[k.kind] ?? COLOR.unknown;
        const x1 = n.x + 12;
        const x2 = k.x - 10;
        const mx = (x1 + x2) / 2;
        // the arrow points the way the money moved
        const ax = mx;
        const ay = (n.y + k.y) / 2;
        const arrow = k.dir === "in" ? `M${ax + 5},${ay - 4} L${ax - 3},${ay} L${ax + 5},${ay + 4}` : `M${ax - 5},${ay - 4} L${ax + 3},${ay} L${ax - 5},${ay + 4}`;
        edges.push(`<path d="M${x1},${n.y} C${mx},${n.y} ${mx},${k.y} ${x2},${k.y}" stroke="${c}" stroke-opacity=".45" stroke-width="1.4" fill="none" class="t-edge ${k.dir}"/>
          <path d="${arrow}" stroke="${c}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      const launched = n.address ? launchN.get(norm(n.address)) : 0;
      const c = launched ? "#ffb35c" : n.kind === "root" ? "#7ce7d0" : (COLOR[n.kind] ?? COLOR.unknown);
      const canExpand = n.kind === "wallet" && n.address && !n.cycle && n.depth < MAX_DEPTH;
      const state = n.loading ? "…" : n.error ? "!" : canExpand ? (n.open && n.children ? "−" : "+") : "";
      const sub =
        n.kind === "root"
          ? "scanned wallet"
          : `${KIND_NAME[n.kind] ?? ""}${n.usd ? ` · ${usd(n.usd)}` : ""}${n.n ? ` · ${n.n} tx` : ""}${n.cycle ? " · already above" : ""}`;
      const rocket = launched ? `<text class="t-rocket" x="16" y="${n.kind === "root" ? 26 : 26}">🚀 ${launched} launch${launched > 1 ? "es" : ""}</text>` : "";
      nodes.push(`<g class="t-node${canExpand ? " t-exp" : ""}${n.loading ? " t-load" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
          <circle r="${n.kind === "root" ? 11 : 8}" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="1.6"/>
          ${state ? `<text class="t-state" y="4" text-anchor="middle">${state}</text>` : `<circle r="2.6" fill="${c}"/>`}
          <text class="t-name" x="16" y="-2">${esc(n.name)}</text>
          <text class="t-sub" x="16" y="12">${esc(sub)}</text>
          ${rocket}
          ${n.address && n.kind !== "root" && !launched ? `<a href="/footprint?addr=${esc(n.address)}" class="t-open"><text x="16" y="26">scan ↗</text></a>` : ""}
          <title>${esc(n.address ?? n.name)}</title>
        </g>`);
    }
    host.innerHTML = `<svg class="fp-tree-svg" width="${width}" height="${Math.max(height, 120)}" viewBox="0 0 ${width} ${Math.max(height, 120)}">${edges.join("")}${nodes.join("")}</svg>`;
  }

  host.addEventListener("click", async (e) => {
    if (e.target.closest("a")) return; // "scan ↗" opens a full scan
    const g = e.target.closest(".t-exp");
    if (!g) return;
    const n = byId.get(Number(g.dataset.id));
    if (!n || n.loading) return;
    if (n.children) {
      n.open = !n.open;
      return draw();
    }
    n.loading = true;
    n.open = true;
    draw();
    try {
      const r = await fetch(`/footprint-api/trace?addr=${encodeURIComponent(n.address)}&chain=auto`);
      const t = await r.json();
      if (!r.ok) throw new Error(t.error ?? r.status);
      const anc = new Set(n.ancestors);
      anc.add(n.address.toLowerCase());
      n.children = childrenOf(t, anc);
      await tagLaunches(n.children);
      n.error = null;
    } catch (err) {
      n.error = String(err.message ?? err);
      n.open = false;
    }
    n.loading = false;
    draw();
  });

  draw();
  tagLaunches(root.children).then(draw);
}
