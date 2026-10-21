// The Swap tab. Someone arrives holding an asset somewhere and wants another one somewhere else,
// at an address nothing of theirs has touched. They need no key here and sign nothing on this
// page: we ask both providers what the trade costs, show the one that pays more, and give them an
// address to send to. What breaks is the chain's record — no transaction links where the money
// left to where it arrived. What does not break is the provider's own view: it sees both ends, and
// an amount sent at a particular minute is still an amount arriving a few minutes later. The form
// says so, in the form, not only in the docs.
import { forgetSwap, listSwaps, rememberSwap, updateSwap } from "./swapstore.js";

const DP = 6;

/**
 * The amount in full, to the last digit it has. What someone is told to send has to be this and
 * not a rounded version of it: a different amount than the quote is refunded, not filled.
 */
export const exact = (v, decimals = 18) => units(v, decimals, decimals);

/** Whole units from the smallest unit, trimmed for reading: (5000000n, 6) -> "5". */
export function units(v, decimals = 18, dp = DP) {
  const s = BigInt(v ?? 0).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).slice(0, dp).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** The smallest unit from what someone typed: ("0.01", 18) -> 10000000000000000n. */
export function smallest(text, decimals = 18) {
  const [whole = "0", frac = ""] = String(text ?? "").trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) throw new Error("that is not an amount");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// Where a transaction can be read, per destination. The provider gives a link of its own for some
// chains; where it does not, these do. Opening one tells that explorer which transaction you are
// looking at, which is why the links carry no referrer: it should not also learn where you came
// from.
const EXPLORER = {
  hood: "https://robin.etherscan.io/tx/",
  eth: "https://etherscan.io/tx/",
  base: "https://basescan.org/tx/",
  arb: "https://arbiscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  sol: "https://solscan.io/tx/",
  btc: "https://mempool.space/tx/",
  zec: "https://blockchair.com/zcash/transaction/",
};

/** The link for a destination transaction: the provider's own if it gave one, else ours. */
export const txUrl = (dest, hash, given) => (given || (hash && EXPLORER[dest] ? EXPLORER[dest] + hash : null)) || null;

/**
 * The destinations that can actually be reached from one origin asset. `keys` is the probe's list
 * as the server sends it; without one (a test network) everything stands.
 */
export function reachableFrom(keys, origin, originToken, destinations) {
  // A pasted address is on no list, so there is nothing to narrow by: show everything and let the
  // quote answer, which is what the server does with it too.
  if (!keys || looksLikeAddress(originToken)) return destinations;
  const have = new Set(keys);
  return destinations
    .map((d) => ({ ...d, tokens: d.tokens.filter((t) => have.has(`${origin}:${originToken}>${d.id}:${t.symbol}`)) }))
    .filter((d) => d.tokens.length);
}

/**
 * What the page should say a swap is. The provider's answer wins once it has one; until then a
 * quote nobody paid simply runs out, and a run-out quote is not a swap in progress.
 */
export function swapState(record, now = Date.now()) {
  if (record.destTx) return "done";
  // "waiting" is the provider waiting for the deposit, which is where a quote can still run out.
  if (["processing", "done", "refunded", "failed"].includes(record.state)) return record.state;
  if (record.expiresAt && now > record.expiresAt) return "expired";
  return record.state ?? "quoted";
}

/** The sentence above the deposit address. The refund address is the one thing they cannot fix later. */
export function sendAdvice(record) {
  const amount = `${exact(record.amountIn, record.originDecimals)} ${record.originToken}`;
  return (
    `Send exactly ${amount} on ${record.originName}, in one transaction, to the address below. ` +
    `A different amount, or one that arrives after this quote has run out, is sent back by the provider to ${record.refundTo} — ` +
    `the refund address, which cannot be changed once the quote is made.`
  );
}

// ---------- the tab ----------
import { validRecipient } from "./bridge.js";
import { looksLikeAddress, mountPicker } from "./picker.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a) => (a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : (a ?? ""));
// A quote waits on two providers, and a slow one can time out at the edge rather than here. That
// is a blip, not an answer, so a gateway error is tried once more before anyone is told about it.
const api = async (p, init, retried = false) => {
  const r = await fetch(`/swap-api${p}`, { cache: "no-store", ...init });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  if (!retried && [502, 503, 504].includes(r.status)) {
    await new Promise((s) => setTimeout(s, 1500));
    return api(p, init, true);
  }
  throw new Error(j.error || (r.status >= 500 ? "the providers did not answer in time — try again" : `swap service error (${r.status})`));
};

const STATE_TEXT = {
  quoted: ["Waiting for your deposit", "mid"],
  expired: ["Quote ran out — get a new one before sending", "no"],
  waiting: ["Waiting for your deposit", "mid"],
  processing: ["Sent — the provider is filling it", "mid"],
  done: ["Done", "ok"],
  refunded: ["Refunded to your refund address", "mid"],
  failed: ["Failed — the provider refunds the deposit", "no"],
};

let ROUTES = null; // { origins, destinations }
let polling = null;
let deep = null; // the pool side of the app, handed in by main.js when a key is around

/**
 * Lets the Swap tab finish a swap inside the pool. Everything it needs belongs to the app's own
 * state - the Zero Key, the hop wallets, the deposit call - so main.js hands those in rather than
 * this file reaching into them.
 */
export function enableDeep(api) {
  deep = api;
}

const pick = (list, id) => list.find((r) => r.id === id) ?? list[0];
const pastedInfo = new Map(); // address -> { symbol, name, decimals }
const token = (route, sym) => {
  const info = pastedInfo.get(sym);
  if (info) return { symbol: sym, label: info.symbol, decimals: info.decimals };
  return route?.tokens.find((t) => t.symbol === sym) ?? route?.tokens[0];
};

function optionsFor(list, selected) {
  return list.map((r) => `<option value="${esc(r.id)}" ${r.id === selected ? "selected" : ""}>${esc(r.name)}</option>`).join("");
}
function tokenOptions(route, selected) {
  const listed = (route?.tokens ?? []).map((t) => `<option value="${esc(t.symbol)}" ${t.symbol === selected ? "selected" : ""}>${esc(t.symbol)}${t.name && t.name !== t.symbol ? ` · ${esc(t.name)}` : ""}</option>`);
  const pasted = [...pastedInfo].filter(([, i]) => i.chain === route?.id).map(([addr, i]) => `<option value="${esc(addr)}" ${addr === selected ? "selected" : ""}>${esc(i.symbol)} · pasted</option>`);
  return [...listed, ...pasted].join("");
}

export async function viewSwap(el) {
  el.innerHTML = `<h2>Swap privately</h2><div class="note">Loading what can be swapped…</div>`;
  try {
    ROUTES ??= await api("/routes");
  } catch {
    el.innerHTML = `<h2>Swap privately</h2><div class="note bad">The swap service is not reachable right now.</div>`;
    return;
  }
  const { origins, destinations, pairs } = ROUTES;
  if (!origins.length || !destinations.length) {
    el.innerHTML = `<h2>Swap privately</h2><div class="note">No swaps are offered on this network.</div>`;
    return;
  }
  const home = origins.find((o) => o.id === "hood");
  const deepReady = !!deep && !!home;
  const from = pick(origins, "hood");
  const to = pick(destinations, destinations.find((d) => d.id !== from.id)?.id ?? from.id);

  el.innerHTML = `
    <h2>Swap privately</h2>
    <p class="sub">No key, nothing signed here, and no deposit into the pool. You send from any wallet or exchange withdrawal; the provider pays an address you name and nothing on any chain links the two.</p>
    ${deepReady ? `<nav class="segnav" id="smode" aria-label="Swap mode"><a href="#swap" class="on" data-mode="fast">Fast</a><a href="#swap" data-mode="deep">Into the pool</a></nav>` : ""}
    <div id="sdeepnote"></div>
    <label>You send</label>
    <div class="row two"><select id="sorigin">${optionsFor(origins, from.id)}</select><select id="sotoken">${tokenOptions(from)}</select></div>
    <input id="samt" class="amount" inputmode="decimal" placeholder="0.0" />
    <label>You receive</label>
    <div class="row two"><select id="sdest">${optionsFor(destinations, to.id)}</select><select id="sdtoken">${tokenOptions(to)}</select></div>
    <label id="srlabel">Recipient (a fresh wallet)</label>
    <input id="srecip" placeholder="0x…" autocomplete="off" spellcheck="false" />
    <label id="sflabel">Refund address (yours, where you are sending from)</label>
    <input id="srefund" placeholder="0x…" autocomplete="off" spellcheck="false" />
    <div id="squote" class="note">Fill this in and ask for a quote. Nothing is sent until you send it yourself.</div>
    <button class="btn wide" id="sgo">Get a quote</button>
    <div id="sout"></div>
    <details class="fp-limits"><summary>What a swap hides, and what it does not</summary><ul>
      <li>No transaction on any chain links the address you send from to the address you receive at.</li>
      <li>The provider filling the swap sees both ends. It is a company with records, like an exchange.</li>
      <li>The amount and the minute still match: an unusual amount leaving and arriving minutes apart tells the story by itself.</li>
      <li>For an anonymity set — many deposits a withdrawal could have come from — use Deposit and Withdraw instead.</li>
    </ul></details>
    <div id="shist"></div>`;

  // Swaps made in this tab, kept here as well as in storage. A private window, cleared site data
  // or a full quota all make storage keep nothing, and the panel is drawn from these records: the
  // deposit address has to appear even when nothing can be remembered.
  const session = new Map();
  const records = () => {
    const stored = listSwaps();
    const have = new Set(stored.map((r) => r.id));
    return [...stored, ...[...session.values()].filter((r) => !have.has(r.id))].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  };

  let mode = "fast";
  let hop = null; // { index, address } once a Deep swap needs one

  /** Asks the server about an address nobody listed, and puts what comes back into the picker. */
  const lookupInto = (which) => async (address) => {
    const chain = which === "o" ? originOf() : destOf();
    const { token: t } = await api(`/token?chain=${encodeURIComponent(chain.id)}&address=${encodeURIComponent(address)}`);
    pastedInfo.set(address, { ...t, chain: chain.id });
    (which === "o" ? $("#sotoken") : $("#sdtoken")).innerHTML = tokenOptions(chain, address);
    return { value: address };
  };

  const picks = {
    origin: mountPicker($("#sorigin")),
    otoken: mountPicker($("#sotoken"), { kind: "token", search: true, lookup: lookupInto("o") }),
    dest: mountPicker($("#sdest")),
    dtoken: mountPicker($("#sdtoken"), { kind: "token", search: true, lookup: lookupInto("d") }),
  };
  const originOf = () => pick(origins, $("#sorigin").value);
  const reachable = () => reachableFrom(pairs, $("#sorigin").value, $("#sotoken").value, destinations);
  const destOf = () => pick(reachable(), $("#sdest").value);

  // Redraw the destination pickers for whatever the origin asset can actually reach.
  function redrawDest() {
    const list = reachable();
    const keep = list.some((d) => d.id === $("#sdest").value) ? $("#sdest").value : list[0]?.id;
    $("#sdest").innerHTML = optionsFor(list, keep);
    $("#sdest").value = keep ?? "";
    $("#sdtoken").innerHTML = tokenOptions(pick(list, keep));
    picks.dest.refresh();
    picks.dtoken.refresh();
    $("#squote").textContent = list.length
      ? "Fill this in and ask for a quote. Nothing is sent until you send it yourself."
      : "Nothing can be swapped from that asset right now.";
  }

  const relabel = () => {
    const o = originOf();
    const d = destOf();
    $("#srlabel").textContent = `Recipient on ${d.name} (a fresh wallet)`;
    $("#sflabel").textContent = `Refund address on ${o.name} (yours, where you are sending from)`;
    const hint = { evm: "0x…", solana: "Solana address", btc: "bc1… / 1… / 3…", zec: "t1… (transparent)" };
    $("#srecip").placeholder = hint[d.kind] ?? "0x…";
    $("#srefund").placeholder = hint[o.kind] ?? "0x…";
  };
  $("#sorigin").addEventListener("input", () => {
    $("#sotoken").innerHTML = tokenOptions(originOf());
    picks.otoken.refresh();
    redrawDest();
    relabel();
  });
  $("#sotoken").addEventListener("input", () => {
    redrawDest();
    relabel();
  });
  $("#sdest").addEventListener("input", () => {
    $("#sdtoken").innerHTML = tokenOptions(destOf());
    picks.dtoken.refresh();
    relabel();
  });
  redrawDest();
  relabel();

  async function setMode(next) {
    mode = next;
    document.querySelectorAll("#smode a").forEach((a) => a.classList.toggle("on", a.dataset.mode === mode));
    const deepOn = mode === "deep";
    $("#sdest").closest(".row").hidden = deepOn;
    $("#srecip").hidden = $("#srlabel").hidden = deepOn;
    if (!deepOn) {
      $("#sdeepnote").innerHTML = "";
      relabel();
      return;
    }
    if (!reachable().some((d) => d.id === "hood")) {
      $("#sdeepnote").innerHTML = `<div class="note bad">That asset cannot be swapped into ${esc(deep.chainName)} ETH, which is what a pool deposit is made of. Pick another one to send.</div>`;
      return;
    }
    $("#sdest").value = "hood";
    $("#sdest").dispatchEvent(new Event("input", { bubbles: true }));
    $("#sdtoken").value = "ETH";
    $("#sdeepnote").innerHTML = `<div class="note">The swap pays a one-time wallet of your own Zero Key on ${esc(deep.chainName)}, and this browser then deposits it into the pool. After that it is an ordinary deposit: the ${esc(deep.waitText ?? "screening")} wait, then you withdraw it when you choose, to any chain the Withdraw tab reaches. This is the mode with a crowd to hide in — Fast only breaks the chain's record. What arrives has to clear the pool's minimum deposit, so send a little more than it.</div>`;
    if (!deep.unlocked()) {
      $("#sdeepnote").innerHTML += `<div class="note bad">Unlock your Zero Key first — the pool wallet comes from it.</div>`;
      return;
    }
    try {
      hop ??= await deep.freshHop();
      $("#sdeepnote").innerHTML += `<div class="note">It will be paid to <span class="mono">${esc(hop.address)}</span>, a wallet used once.</div>`;
    } catch (e) {
      $("#sdeepnote").innerHTML += `<div class="note bad">${esc(e.message)}</div>`;
    }
  }
  if (deepReady) document.querySelectorAll("#smode a").forEach((a) => (a.onclick = (e) => (e.preventDefault(), setMode(a.dataset.mode))));

  $("#sgo").onclick = async () => {
    const o = originOf();
    const d = destOf();
    const ot = token(o, $("#sotoken").value);
    const dt = token(d, $("#sdtoken").value);
    const refundTo = $("#srefund").value.trim();
    const note = $("#squote");
    try {
      // Into the pool pays a wallet of the person's own key; Fast pays whoever they named.
      const deepOn = mode === "deep";
      if (deepOn && !deep?.unlocked()) throw new Error("Unlock your Zero Key first — the pool wallet comes from it");
      if (deepOn) hop ??= await deep.freshHop();
      const recipient = deepOn ? hop.address : $("#srecip").value.trim();
      const amount = smallest($("#samt").value, ot.decimals);
      if (amount <= 0n) throw new Error("Enter an amount to send");
      if (!validRecipient(d.kind, recipient)) throw new Error(`That is not a valid ${d.name} address`);
      if (!validRecipient(o.kind, refundTo)) throw new Error(`The refund address must be a valid ${o.name} address`);
      $("#sgo").disabled = true;
      note.className = "note";
      note.textContent = "Asking both providers…";
      const q = await api("/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: o.id, originToken: ot.symbol, route: d.id, token: dt.symbol, amount: amount.toString(), recipient, refundTo }),
      });
      const record = {
        id: crypto.randomUUID(),
        at: Date.now(),
        origin: o.id,
        originName: o.name,
        originToken: q.originToken ?? ot.label ?? ot.symbol,
        originDecimals: ot.decimals,
        dest: d.id,
        destName: d.name,
        destToken: q.token ?? dt.label ?? dt.symbol,
        destDecimals: dt.decimals,
        amountIn: q.amountIn,
        amountOut: q.amountOut,
        minOut: q.minOut,
        provider: q.provider,
        quoteId: q.id,
        depositAddress: q.depositAddress,
        recipient,
        refundTo,
        expiresAt: q.expiresAt ? Date.parse(q.expiresAt) : null,
        state: "quoted",
        ...(mode === "deep" ? { deep: true, hop: hop.index } : {}),
      };
      rememberSwap(record);
      session.set(record.id, record);
      note.textContent = `${units(record.amountIn, ot.decimals)} ${record.originToken} → about ${units(record.amountOut, dt.decimals)} ${record.destToken} via ${q.provider === "near" ? "NEAR Intents" : "Relay"}${q.eta ? `, usually ${q.eta}s` : ""}.`;
      drawRecords();
      $("#sout").scrollIntoView({ block: "nearest", behavior: "smooth" });
    } catch (e) {
      note.className = "note bad";
      note.textContent = e.message;
    } finally {
      $("#sgo").disabled = false;
    }
  };

  function drawRecords() {
    const all = records();
    // Every swap still waiting is shown, not only the newest: a second quote used to hide the
    // first one's address, and that address is the only place its money can go.
    const open = all.filter((r) => !["done", "refunded", "failed"].includes(swapState(r)));
    $("#sout").innerHTML = open.map(depositPanel).join("");
    open.forEach((r) => {
      const panel = $(`#swap-${CSS.escape(r.id)}`);
      if (!panel) return;
      const copy = $(".s-copy", panel);
      if (copy) copy.onclick = () => navigator.clipboard?.writeText(r.depositAddress);
      const again = $(".s-again", panel);
      if (again) again.onclick = () => (forget(r.id), $("#sgo").click());
      const dep = $(".s-dep", panel);
      if (dep)
        dep.onclick = async () => {
          dep.disabled = true;
          dep.textContent = "Depositing…";
          try {
            const { hash } = await deep.depositFromHop(r.hop);
            patch(r.id, { depositTx: hash, state: "done" });
          } catch (e) {
            dep.textContent = e.message;
          } finally {
            dep.disabled = false;
            drawRecords();
          }
        };
    });
    $("#shist").innerHTML = all.length ? `<h3>Your swaps</h3>${all.map(historyRow).join("")}` : "";
    $("#shist").querySelectorAll("[data-forget]").forEach((b) => (b.onclick = () => (forget(b.dataset.forget), drawRecords())));
  }

  /** Both places a record lives, so a browser that cannot store still follows its own swap. */
  const patch = (id, fields) => {
    updateSwap(id, fields);
    const r = session.get(id);
    if (r) Object.assign(r, fields);
  };
  const forget = (id) => {
    forgetSwap(id);
    session.delete(id);
    drawRecords();
  };

  function depositPanel(r) {
    const state = swapState(r);
    const [text, cls] = STATE_TEXT[state] ?? STATE_TEXT.quoted;
    const left = r.expiresAt ? Math.max(0, Math.round((r.expiresAt - Date.now()) / 1000)) : null;
    // NEAR's deadlines run for days, and "4499m 11s left" reads like a stopwatch nobody asked for.
    const leftText = left == null ? "" : left >= 86400 ? `${Math.floor(left / 86400)}d ${Math.floor((left % 86400) / 3600)}h left` : left >= 3600 ? `${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m left` : `${Math.floor(left / 60)}m ${left % 60}s left`;
    return `
      <div class="plan" id="swap-${esc(r.id)}">
        <div class="fp-l1"><b class="${esc(cls)}">${esc(text)}</b>${left != null && (state === "quoted" || state === "waiting") ? `<span class="fp-tag">${leftText}</span>` : ""}</div>
        ${state === "expired"
          ? `<div class="note bad">This quote ran out. Do not send to the address below — ask for a new quote, which will give you a new address.</div><button class="btn sm s-again">New quote</button>`
          : `<div class="note">${esc(sendAdvice(r))}</div>
             <label>Send to this address</label>
             <div class="row"><input class="mono" style="flex:1" readonly value="${esc(r.depositAddress ?? "")}" /><button class="chip s-copy">Copy</button></div>`}
        <div class="note">You receive about ${esc(units(r.amountOut, r.destDecimals))} ${esc(r.destToken)} at ${esc(short(r.recipient))} on ${esc(r.destName)}.${r.destTx ? ` Paid: ${link(r)}` : ""}</div>
        ${r.deep && !r.depositTx ? `<div class="note">When it lands, this browser deposits it into the pool.</div><button class="btn sm s-dep">Deposit it into the pool</button>` : ""}
        ${r.depositTx ? `<div class="note ok">Deposited into the pool. It shows up under My deposits, and can be withdrawn once the screening window has passed.</div>` : ""}
      </div>`;
  }

  const link = (r) => {
    const url = txUrl(r.dest, r.destTx, r.destTxUrl);
    return url ? `<a class="fp-ext" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(short(r.destTx))} ↗</a>` : esc(short(r.destTx));
  };

  function historyRow(r) {
    const state = swapState(r);
    const [text] = STATE_TEXT[state] ?? STATE_TEXT.quoted;
    return `<div class="fp-leg k-${esc(state)}"><div class="fp-body">
      <div class="fp-l1"><b>${esc(units(r.amountIn, r.originDecimals))} ${esc(r.originToken)} → ${esc(units(r.amountOut, r.destDecimals))} ${esc(r.destToken)}</b><span class="fp-route">${esc(r.originName)} → ${esc(r.destName)}</span></div>
      <div class="fp-l2"><span class="fp-amt">${esc(text)}${r.destTx ? ` · ${link(r)}` : ""}</span><button class="btn sm" data-forget="${esc(r.id)}">Forget this swap</button></div>
    </div></div>`;
  }

  drawRecords();
  clearInterval(polling);
  polling = setInterval(watch, 8000);
  watch();

  async function watch() {
    const open = records().filter((r) => r.quoteId && !["done", "refunded", "failed"].includes(swapState(r)));
    if (!open.length) return;
    for (const r of open.slice(0, 3)) {
      const st = await api(`/status?provider=${encodeURIComponent(r.provider)}&id=${encodeURIComponent(r.quoteId)}`).catch(() => null);
      if (st) patch(r.id, { state: st.state, destTx: st.destTx ?? r.destTx, destTxUrl: st.destTxUrl ?? r.destTxUrl });
    }
    if (location.hash.startsWith("#swap") && $("#sout")) drawRecords();
  }
}
