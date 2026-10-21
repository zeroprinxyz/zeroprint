import "./style.css";
import { createWalletClient, custom, formatEther, formatUnits, getAddress, isAddress, keccak256, parseEther, toHex } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { startShade } from "./bgfx.js";
import { boot } from "./boot.js";
import { createBridge, validRecipient } from "./bridge.js";
import { createShade, settle } from "./core.js";
import { DUST, depositReserve, hopAccount, hopDeposit, hopReserve, hopScan, hopSend, nextHop } from "./hop.js";
import { forgetKey, hasStoredKey, saveKey, unlockKey } from "./keystore.js";
import { mountMobileNav } from "./mnav.js";
import { mountPicker } from "./picker.js";
import { enableDeep, viewSwap } from "./swap.js";
import { ROUND, amountCounts, isRound, meterHtml, privacyCheck } from "./privacy.js";
import { loadLocal, saveLocal } from "./store.js";
import { swapHops } from "./swapstore.js";

mountMobileNav();

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const eth = (wei, dp = 4) => {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, dp).replace(/0+$/, "") || "0"}` : i;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const cfg = await fetch("/config.json", { cache: "no-store" }).then((r) => r.json());
const origin = location.origin;
// The IPFS copy has no server of its own: it reads the chain from the public RPC and uses
// cfg.api (the main site) for the relayer and bridges.
const api = cfg.api ?? origin;
const shade = createShade({
  rpcUrl: cfg.rpcUrl ?? `${origin}/rpc`,
  chainName: cfg.chainName,
  deployment: cfg.deployment,
  aspUrl: `${api}/asp`,
  relayerUrl: `${api}/relayer`,
  circuits: { browser: true, baseUrl: `${origin}/` },
});
const bridge = createBridge(`${api}/bridge-api`);

const S = {
  mnemonic: null, // only in memory while unlocked
  acct: null,
  notes: [],
  wallet: null,
  address: null,
  pool: null,
  draftWords: null,
  local: null, // { plans, bridges }: encrypted in this browser, see store.js
  routes: null,
};
const saveL = () => (S.mnemonic && S.local ? saveLocal(S.mnemonic, shade.scope.toString(), S.local) : Promise.resolve());

// ---------- toast ----------
let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast${bad ? " bad" : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 9000 : 4500);
}
const errMsg = (e) => e?.shortMessage || e?.details || e?.message || String(e);

// ---------- wallet ----------
function addrLink(a) {
  return cfg.explorer ? `<a class="mono" href="${cfg.explorer}/address/${a}" target="_blank" rel="noreferrer">${a}</a>` : a;
}
function txLink(hash) {
  return cfg.explorer ? `<a href="${cfg.explorer}/tx/${hash}" target="_blank" rel="noreferrer">${short(hash)}</a>` : `<span class="mono">${short(hash)}</span>`;
}

// EIP-6963: every installed wallet announces itself, so OKX/MetaMask/Rabby don't fight over
// window.ethereum and the user picks one.
const wallets = new Map(); // rdns -> { info, provider }
window.addEventListener("eip6963:announceProvider", (e) => wallets.set(e.detail.info.rdns, e.detail));
window.dispatchEvent(new Event("eip6963:requestProvider"));
const WALLET_PREF = "shadepool.wallet";

function pickWallet() {
  const list = [...wallets.values()];
  if (!list.length) return Promise.resolve(window.ethereum ? { info: { name: "Browser wallet", rdns: "injected" }, provider: window.ethereum } : null);
  let pref = null;
  try {
    pref = localStorage.getItem(WALLET_PREF);
  } catch {}
  if (list.length === 1) return Promise.resolve(list[0]);
  if (pref && wallets.has(pref) && S.walletChosen) return Promise.resolve(wallets.get(pref));
  return new Promise((resolve) => {
    const m = $("#picker");
    m.innerHTML = `<div class="sheet"><h2>Choose a wallet</h2>
      ${list
        .map(
          (w) => `<button class="wopt" data-r="${esc(w.info.rdns)}"><img src="${esc(w.info.icon)}" alt="" />${esc(w.info.name)}${
            w.info.rdns === pref ? `<span class="pill">last used</span>` : ""
          }</button>`,
        )
        .join("")}
      <button class="btn ghost wide" id="pickCancel">Cancel</button></div>`;
    m.hidden = false;
    const done = (w) => {
      m.hidden = true;
      resolve(w);
    };
    m.querySelectorAll(".wopt").forEach((b) => (b.onclick = () => done(wallets.get(b.dataset.r))));
    $("#pickCancel").onclick = () => done(null);
  });
}

async function ensureChain() {
  const want = `0x${cfg.deployment.chainId.toString(16)}`;
  const have = await S.provider.request({ method: "eth_chainId" });
  if (have === want) return;
  try {
    await S.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await S.provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: want,
          chainName: cfg.chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [cfg.walletRpc],
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : undefined,
        },
      ],
    });
  }
}

function onAccounts(a) {
  S.address = a[0] ? getAddress(a[0]) : null;
  if (S.address) S.wallet = createWalletClient({ chain: shade.chain, account: S.address, transport: custom(S.provider) });
  $("#connect").textContent = S.address ? `${short(S.address)} · ${S.walletName}` : "Connect wallet";
  render();
}

async function connect() {
  const w = await pickWallet();
  if (!w) {
    if (!wallets.size && !window.ethereum) toast("No browser wallet found. Install MetaMask or Rabby.", true);
    return;
  }
  S.provider?.removeListener?.("accountsChanged", onAccounts);
  S.provider = w.provider;
  S.walletName = w.info.name;
  S.walletChosen = true;
  try {
    localStorage.setItem(WALLET_PREF, w.info.rdns);
  } catch {}
  const [addr] = await S.provider.request({ method: "eth_requestAccounts" });
  await ensureChain();
  S.provider.on?.("accountsChanged", onAccounts);
  onAccounts([addr]);
}

async function sendTx(tx) {
  if (!S.wallet) await connect();
  await ensureChain();
  // Explicit EIP-1559 fees: some nodes suggest a tip above the whole fee cap, which viem rejects.
  const [block, tip] = await Promise.all([
    shade.pub.getBlock(),
    shade.pub.request({ method: "eth_maxPriorityFeePerGas" }).then(BigInt, () => 0n),
  ]);
  const maxPriorityFeePerGas = tip;
  const maxFeePerGas = block.baseFeePerGas * 2n + tip;
  const hash = await S.wallet.sendTransaction({ ...tx, account: S.address, chain: shade.chain, maxFeePerGas, maxPriorityFeePerGas });
  toast("Sent. Waiting for confirmation…");
  const r = await shade.pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`Transaction failed ${hash}`);
  await settle();
  return hash;
}

// ---------- Zero Key ----------
async function loadAccount() {
  S.acct = await shade.loadAccount(S.mnemonic);
  S.notes = await shade.notes(S.acct);
  if (!S.local) {
    S.local = await loadLocal(S.mnemonic, shade.scope.toString());
    // a part that was running when the tab closed: try it again (it is bounded by the balance)
    for (const p of S.local.plans) for (const x of p.parts) if (x.state === "running") Object.assign(x, { state: "retry", retryAt: 0 });
  }
}

function renderKey() {
  const box = $("#keybox");
  if (S.mnemonic) {
    box.innerHTML = `
      <div class="row">
        <div style="flex:1;min-width:200px">
          <h2>🔓 Zero Key unlocked</h2>
          <p class="sub">Your deposits are rebuilt from the chain with this key. It never leaves this browser.</p>
        </div>
        <button class="btn ghost" id="lock">Lock</button>
      </div>`;
    $("#lock").onclick = () => {
      Object.assign(S, { mnemonic: null, acct: null, notes: [], local: null, previewHop: null, hops: null });
      render();
    };
    return;
  }
  if (S.draftWords) {
    const words = S.draftWords.split(" ");
    const ask = S.draftAsk;
    box.innerHTML = `
      <h2>Write down your Zero Key</h2>
      <p class="sub">These 12 words are the <b>only</b> way to withdraw your deposits. No server has them. Lose them and the funds are gone.</p>
      <div class="words">${words.map((w, i) => `<span><i>${i + 1}</i>${esc(w)}</span>`).join("")}</div>
      <div class="note warn">Write them on paper. Do not screenshot, do not paste into chats.</div>
      <label>To confirm, type word #${ask[0] + 1} and word #${ask[1] + 1}</label>
      <div class="row"><input id="c1" placeholder="word #${ask[0] + 1}" autocomplete="off" /><input id="c2" placeholder="word #${ask[1] + 1}" autocomplete="off" /></div>
      <label>Password to lock it in this browser</label>
      <input id="pw" type="password" placeholder="at least 8 characters" autocomplete="new-password" />
      <div class="row" style="margin-top:14px"><button class="btn" id="save">I saved it, continue</button><button class="btn ghost" id="cancel">Cancel</button></div>`;
    $("#cancel").onclick = () => {
      S.draftWords = null;
      render();
    };
    $("#save").onclick = async () => {
      if ($("#c1").value.trim().toLowerCase() !== words[ask[0]] || $("#c2").value.trim().toLowerCase() !== words[ask[1]])
        return toast("The words do not match. Check your paper.", true);
      if ($("#pw").value.length < 8) return toast("Password must be at least 8 characters.", true);
      await saveKey(S.draftWords, $("#pw").value);
      S.mnemonic = S.draftWords;
      S.draftWords = null;
      await withBusy($("#save"), loadAccount);
      render();
    };
    return;
  }
  const stored = hasStoredKey();
  box.innerHTML = `
    <h2>${stored ? "🔒 Unlock your Zero Key" : "Start with a Zero Key"}</h2>
    <p class="sub">${
      stored
        ? "Your encrypted key is in this browser."
        : "A Zero Key is 12 words, separate from your wallet. Your private notes are derived from it."
    }</p>
    ${
      stored
        ? `<input id="pw" type="password" placeholder="password" autocomplete="current-password" />
           <div class="row" style="margin-top:12px"><button class="btn" id="unlock">Unlock</button><button class="btn ghost" id="restoreBtn">Use other words</button><button class="btn danger" id="forget">Forget</button></div>`
        : `<div class="row"><button class="btn" id="create">Create new Zero Key</button><button class="btn ghost" id="restoreBtn">Restore from 12 words</button></div>`
    }
    <div id="restore" hidden>
      <label>Your 12 words</label>
      <textarea id="rw" rows="2" autocomplete="off" spellcheck="false"></textarea>
      <label>New password for this browser</label>
      <input id="rpw" type="password" autocomplete="new-password" />
      <button class="btn wide" id="doRestore">Restore and scan the chain</button>
    </div>`;
  $("#create")?.addEventListener("click", () => {
    S.draftWords = generateMnemonic(english);
    const a = Math.floor(Math.random() * 12);
    let b = Math.floor(Math.random() * 11);
    if (b >= a) b++;
    S.draftAsk = [Math.min(a, b), Math.max(a, b)];
    render();
  });
  $("#restoreBtn").onclick = () => ($("#restore").hidden = false);
  $("#unlock")?.addEventListener("click", async () => {
    try {
      S.mnemonic = await unlockKey($("#pw").value);
      await withBusy($("#unlock"), loadAccount);
      render();
    } catch (e) {
      S.mnemonic = null;
      toast(errMsg(e), true);
    }
  });
  $("#pw")?.addEventListener("keydown", (e) => e.key === "Enter" && $("#unlock")?.click());
  $("#forget")?.addEventListener("click", () => {
    if (!confirm("Remove the encrypted Zero Key from this browser? Make sure you have the 12 words on paper.")) return;
    forgetKey();
    render();
  });
  $("#doRestore").onclick = async () => {
    const words = $("#rw").value.trim().toLowerCase().split(/\s+/).join(" ");
    if ($("#rpw").value.length < 8) return toast("Password must be at least 8 characters.", true);
    try {
      S.mnemonic = words;
      await withBusy($("#doRestore"), loadAccount);
      await saveKey(words, $("#rpw").value);
      toast(`Restored ${S.notes.length} deposit(s).`);
      render();
    } catch (e) {
      S.mnemonic = null;
      toast(`Could not restore: ${errMsg(e)}`, true);
    }
  };
}

async function withBusy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Working…";
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- views ----------
const needKey = `<div class="note">Unlock or create your Zero Key above first.</div>`;

function viewDeposit(el) {
  const min = S.pool ? eth(S.pool.minimumDepositAmount) : "…";
  el.innerHTML = `
    <h2>Deposit ETH</h2>
    <p class="sub">Your wallet sends ETH to the pool with a commitment made from your Zero Key. After about ${Math.round(cfg.delaySec / 60)} min the ASP screens it; then you can withdraw privately.</p>
    <div class="note">A pool is only as private as the crowd in it. Every withdrawal could have come from any approved deposit of at least that size, so each deposit makes the others harder to single out — including yours, and including the ones that arrive after you. Early deposits are the thinnest; they get better as the pool fills.</div>
    ${S.mnemonic ? "" : needKey}
    <label>Amount (min ${min} ETH)</label>
    <input id="amt" class="amount" inputmode="decimal" placeholder="0.1" />
    <div class="chips" id="dchips">${["0.01", "0.05", "0.1", "0.5", "1"].map((v) => `<button class="chip" data-v="${v}">${v}</button>`).join("")}</div>
    <div class="note" id="dnote">Round amounts hide better: a deposit of 0.3712 ETH followed by a withdrawal of 0.3712 ETH is easy to match. The small number on each amount is how many approved deposits already used it: joining a common amount puts you in a bigger crowd.</div>
    <button class="btn wide" id="dep" ${S.mnemonic ? "" : "disabled"}>${S.address ? "Deposit" : "Connect wallet & deposit"}</button>`;
  const pickChip = (v) => {
    $("#amt").value = v;
    $("#amt").dispatchEvent(new Event("input"));
  };
  el.querySelectorAll(".chip").forEach((c) => (c.onclick = () => pickChip(c.dataset.v)));
  shade
    .crowd()
    .then((crowd) => {
      const counts = amountCounts(crowd);
      el.querySelectorAll("#dchips .chip").forEach((c) => {
        const k = counts.get(parseEther(c.dataset.v)) ?? 0;
        c.innerHTML = `${c.dataset.v}<small>${k}</small>`;
        c.title = `${k} approved deposit${k === 1 ? "" : "s"} of ${c.dataset.v} ETH`;
      });
    })
    .catch(() => {});
  $("#amt").addEventListener("input", () => {
    let v = 0n;
    try {
      v = parseEther($("#amt").value.trim() || "0");
    } catch {}
    const odd = v > 0n && !isRound(v);
    $("#dnote").className = `note${odd ? " warn" : ""}`;
    if (odd) $("#dnote").textContent = `${formatEther(v)} ETH is an unusual amount: anyone can match it to a later withdrawal of the same size. Pick a round amount like 0.01, 0.05 or 0.1.`;
  });
  $("#dep").onclick = async () => {
    try {
      const value = parseEther($("#amt").value.trim() || "0");
      if (S.pool && value < S.pool.minimumDepositAmount) return toast(`Minimum deposit is ${min} ETH`, true);
      await withBusy($("#dep"), async () => {
        await loadAccount(); // fresh history so the next deposit index is right
        const hash = await sendTx(shade.depositTx(S.acct, value));
        await loadAccount();
        toast("Deposit confirmed. The ASP will screen it.");
        location.hash = "#mine";
        console.info("deposit", hash);
      });
    } catch (e) {
      toast(errMsg(e), true);
    }
  };
}

function stateBadge(n) {
  if (n.state === "pending") {
    const left = n.eta ? Math.max(0, n.eta - Math.floor(Date.now() / 1000)) : null;
    return `<span class="pill pending">⏳ ASP check${left !== null ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : ""}</span>`;
  }
  return {
    unqueued: `<span class="pill pending">⏳ Waiting for the ASP check to start</span>`,
    approved: `<span class="pill approved">✅ Approved</span>`,
    denied: `<span class="pill denied">❌ Denied</span>`,
    spent: `<span class="pill">Spent</span>`,
    ragequit: `<span class="pill">Ragequit</span>`,
  }[n.state];
}

/** Show the do-it-yourself ASP button when the keeper seems late: not queued after 2 min, or past the window. */
function selfAsp(n) {
  if (!shade.onchainAsp) return false;
  const now = Math.floor(Date.now() / 1000);
  if (n.state === "unqueued") return true; // the keeper queues within a minute; the button is harmless before that
  return n.state === "pending" && n.eta && now > n.eta + 120;
}

function viewMine(el) {
  if (!S.mnemonic) return (el.innerHTML = `<h2>My deposits</h2>${needKey}`);
  el.innerHTML = `
    <div class="row"><h2 style="flex:1">My deposits</h2><button class="btn ghost" id="refresh">Refresh</button></div>
    <p class="sub">Rebuilt from the chain with your Zero Key. Status comes from the full public ASP list, checked here, so the ASP never learns which deposit is yours.</p>
    <div class="list">${
      S.notes.length
        ? S.notes
            .map(
              (n, i) => `
      <div class="dep">
        <div><div class="val">${eth(n.balance)} ETH <span class="meta">of ${eth(n.deposited)} deposited</span></div>
          <div class="meta">deposit tx ${txLink(n.depositTx)} · ${n.withdrawals} withdrawal(s)</div></div>
        <div>${stateBadge(n)}</div>
        ${n.state === "denied" ? `<div class="note bad" style="grid-column:1/-1;margin:0">${esc(n.reason || "Not approved")}. You can still take it back with ragequit.</div>` : ""}
        <div class="acts">
          ${n.state === "approved" ? `<button class="btn" data-w="${i}">Withdraw privately</button>` : ""}
          ${selfAsp(n) ? `<button class="btn ghost" data-a="${i}" title="The keeper normally does this. Use it if it seems stuck.">${n.state === "unqueued" ? "Start the check myself" : "Approve it myself"}</button>` : ""}
          ${n.balance > 0n && n.state !== "ragequit" ? `<button class="btn danger" data-r="${i}">Ragequit (public)</button>` : ""}
        </div>
      </div>`,
            )
            .join("")
        : `<div class="note">No deposits for this Zero Key yet.</div>`
    }</div>
    <div id="localPanels"></div>`;
  renderLocalPanels($("#localPanels"));
  $("#refresh").onclick = () => withBusy($("#refresh"), loadAccount).then(render, (e) => toast(errMsg(e), true));
  el.querySelectorAll("[data-w]").forEach((b) => (b.onclick = () => ((S.pick = Number(b.dataset.w)), (location.hash = "#withdraw"))));
  // ZeroPrintASP: when no keeper does it, the depositor can queue/approve from the deposit wallet
  el.querySelectorAll("[data-a]").forEach(
    (b) =>
      (b.onclick = async () => {
        const n = S.notes[Number(b.dataset.a)];
        try {
          if (!S.wallet) await connect();
          const tx = await shade.aspActionTx([n], S.address);
          if (!tx) {
            toast("Connect the wallet that made this deposit (never a fresh wallet), or wait for the window to end.", true);
            return;
          }
          await withBusy(b, async () => {
            await sendTx(tx);
            await loadAccount();
          });
          toast(tx.kind === "queue" ? "Check started. It can be approved when the window ends." : "Approved. You can withdraw privately now.");
          render();
        } catch (e) {
          toast(errMsg(e), true);
        }
      }),
  );
  el.querySelectorAll("[data-r]").forEach(
    (b) =>
      (b.onclick = async () => {
        const n = S.notes[Number(b.dataset.r)];
        if (
          !confirm(
            `Ragequit sends ${eth(n.balance)} ETH back to the ORIGINAL deposit wallet, in public. Anyone can see it came back. Connect that wallet first. Continue?`,
          )
        )
          return;
        try {
          await withBusy(b, async () => {
            const tx = await shade.ragequitTx(n);
            await sendTx(tx);
            await loadAccount();
          });
          toast("Ragequit done. Funds are back in the deposit wallet.");
          render();
        } catch (e) {
          toast(/OnlyOriginalDepositor/.test(errMsg(e)) ? "Connect the wallet that made this deposit." : errMsg(e), true);
        }
      }),
  );
}

// ---------- withdraw: one engine for the form, split plans and bridge hops ----------
const MIN_PART = 1_000_000_000_000_000n; // 0.001 ETH, the relayer minimum
const routeOf = (id) => (S.routes ?? []).find((r) => r.id === id);
const fmtUnits = (v, decimals, dp = 6) => {
  const s = formatUnits(BigInt(v), decimals);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, dp).replace(/0+$/, "") || "0"}` : i;
};
// Every hop this browser has given out: the bridge's, and the ones a swap into the pool is
// waiting on. A hop awaiting a swap is empty and untouched, so without this it would be handed
// out again and the swap's money swept to whatever the second use quoted.
const usedHops = () => [...(S.local?.bridges ?? []).map((b) => b.hop), ...swapHops()];

/**
 * Withdraws `amount` from the deposit with `label` to `recipient` on `dest` ("rh" = this chain,
 * else a bridge route). Bridge: pool -> fresh hop wallet -> bridge deposit address.
 */
async function doWithdraw({ label, amount, dest, token, recipient }, step = () => {}) {
  await loadAccount();
  const note = S.notes.find((x) => x.label === label && x.state === "approved");
  if (!note || note.balance < amount) throw new Error("Not enough approved balance left in this deposit");
  if (dest === "rh") {
    const r = await shade.withdraw(S.acct, note, amount, recipient, step);
    await shade.pub.waitForTransactionReceipt({ hash: r.txHash });
    await settle();
    await loadAccount();
    return { txHash: r.txHash };
  }
  const route = routeOf(dest);
  if (!route) throw new Error("This destination is not available");
  step("quote");
  const hopIndex = await nextHop(shade.pub, S.mnemonic, usedHops());
  const hop = hopAccount(S.mnemonic, hopIndex);
  const q0 = await shade.quote(amount, hop.address);
  const net = amount - (amount * BigInt(q0.feeBPS)) / 10_000n;
  const q = await bridge.quote({ route: dest, token, amount: net - (await hopReserve(shade.pub)), recipient, refundTo: hop.address });
  const rec = { id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000), label, hop: hopIndex, hopAddress: hop.address, dest, token, recipient, amount: amount.toString(), quote: q, state: "withdrawing" };
  S.local.bridges.unshift(rec);
  await saveL();
  const r = await shade.withdraw(S.acct, note, amount, hop.address, step);
  await shade.pub.waitForTransactionReceipt({ hash: r.txHash });
  await settle();
  Object.assign(rec, { withdrawTx: r.txHash, state: "hop" });
  await saveL();
  step("hop");
  await bridgeFromHop(rec, hop, q);
  step("bridge");
  await watchBridge(rec, 15 * 60_000);
  await loadAccount();
  return { txHash: r.txHash, bridge: rec };
}

/** Pays the bridge deposit address from the hop (a plain transfer, signed here). */
async function bridgeFromHop(rec, hop, q) {
  const sent = await hopSend(shade.pub, shade.chain, hop, q.depositAddress, BigInt(q.amountIn));
  Object.assign(rec, { quote: q, hopTx: sent.hash, state: "bridging" });
  await saveL();
  bridge.submit(q, sent.hash);
}

async function watchBridge(rec, maxMs) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const st = await bridge.status(rec.quote).catch(() => null);
    if (st) {
      Object.assign(rec, { bridgeState: st.state, destTx: st.destTx ?? rec.destTx, destTxUrl: st.destTxUrl ?? rec.destTxUrl });
      if (["done", "refunded", "failed"].includes(st.state)) {
        rec.state = st.state;
        await saveL();
        return st.state;
      }
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  await saveL();
  return "processing";
}

/** Split: round equal parts at random times inside the window, at least 10 min apart. */
function makePlan({ label, total, parts, hours, dest, token, recipients }) {
  const part = ((total / BigInt(parts)) / MIN_PART) * MIN_PART;
  if (part < MIN_PART) throw new Error("Each part must be at least 0.001 ETH");
  const now = Math.floor(Date.now() / 1000);
  const span = hours * 3600;
  const times = Array.from({ length: parts }, () => now + 300 + Math.floor(Math.random() * (span - 300))).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) times[i] = Math.max(times[i], times[i - 1] + 600);
  return {
    id: crypto.randomUUID(),
    created: now,
    label,
    dest,
    token,
    parts: times.map((at, i) => ({ amount: part.toString(), at, to: recipients[i % recipients.length], state: "todo" })),
  };
}

let planBusy = false;
async function runPlans(force) {
  if (planBusy || !S.mnemonic || !S.local) return;
  const now = Math.floor(Date.now() / 1000);
  for (const plan of S.local.plans) {
    const p = plan.parts.find((x) => (x.state === "todo" && (x.at <= now || force === x)) || (x.state === "retry" && x.retryAt <= now));
    if (!p) continue;
    planBusy = true;
    try {
      p.state = "running";
      await saveL();
      const r = await doWithdraw({ label: plan.label, amount: BigInt(p.amount), dest: plan.dest, token: plan.token, recipient: p.to });
      Object.assign(p, { state: "done", tx: r.txHash, doneAt: Math.floor(Date.now() / 1000) });
      toast(`Split plan: part sent (${eth(BigInt(p.amount))} ETH).`);
    } catch (e) {
      p.tries = (p.tries ?? 0) + 1;
      Object.assign(p, { error: errMsg(e), state: p.tries >= 3 ? "failed" : "retry", retryAt: now + 600 });
    } finally {
      planBusy = false;
      await saveL();
      if (location.hash.startsWith("#mine")) render();
    }
    return; // one part per tick
  }
}

function viewWithdraw(el) {
  if (!S.mnemonic) return (el.innerHTML = `<h2>Withdraw privately</h2>${needKey}`);
  const ready = S.notes.map((n, i) => ({ n, i })).filter(({ n }) => n.state === "approved" && n.balance > 0n);
  if (!ready.length) {
    el.innerHTML = `<h2>Withdraw privately</h2><div class="note">No approved deposits with a balance yet. Check <a href="#mine">My deposits</a>.</div>`;
    return;
  }
  const pick = ready.some((r) => r.i === S.pick) ? S.pick : ready[0].i;
  const routes = S.routes ?? [];
  el.innerHTML = `
    <h2>Withdraw privately</h2>
    <p class="sub">The proof is made here in your browser. The relayer pays the gas, so the new wallet needs nothing and never touches your old one.</p>
    <label>From deposit</label>
    <select id="note">${ready.map(({ n, i }) => `<option value="${i}" ${i === pick ? "selected" : ""}>${eth(n.balance)} ETH · ${short(n.label)}</option>`).join("")}</select>
    <label>Amount</label>
    <div class="row"><input id="amt" class="amount" inputmode="decimal" style="flex:1" /><button class="chip" id="max">Max</button></div>
    <div class="chips" id="wchips"></div>
    <label>Receive</label>
    <div class="row two">
      <select id="dest"><option value="rh">${esc(cfg.chainName)} · ETH</option>${routes
        .map((r) => `<option value="${r.id}">${esc(r.name)}</option>`)
        .join("")}</select>
      <select id="token" hidden></select>
    </div>
    <div id="destNote"></div>
    <label id="toLabel">Recipient (a fresh wallet)</label>
    <input id="to" placeholder="0x…" autocomplete="off" spellcheck="false" />
    <details id="split" class="split">
      <summary>Split into several withdrawals over time</summary>
      <div class="row">
        <label class="inl">Parts <select id="parts">${[2, 3, 4, 5, 6, 8, 10].map((v) => `<option>${v}</option>`).join("")}</select></label>
        <label class="inl">Spread over <select id="spread">${[6, 12, 24, 48, 72].map((v) => `<option value="${v}" ${v === 24 ? "selected" : ""}>${v} hours</option>`).join("")}</select></label>
      </div>
      <label>Recipients, one per line (best: a different fresh wallet for each part)</label>
      <textarea id="tos" rows="3" autocomplete="off" spellcheck="false"></textarea>
      <div class="note">Each part is its own private withdrawal at a random time in the window, at least 10 min apart. Proofs are made in this browser, so <b>keep this tab open and unlocked</b>. If you close it, due parts run when you come back and unlock.</div>
    </details>
    <div id="meter"></div>
    <div id="checks"></div>
    <div id="quote" class="note">Enter an amount and a recipient to get a quote.</div>
    <button class="btn wide" id="go" disabled>Generate proof & withdraw</button>
    <ol class="steps" id="steps" hidden>
      <li data-s="quote">Fee quote</li>
      <li data-s="trees">Rebuild pool tree + check ASP set against the chain</li>
      <li data-s="prove">Zero-knowledge proof (in this browser)</li>
      <li data-s="relay">Relayer submits the transaction</li>
      <li data-s="hop" data-b>Hop wallet pays the bridge</li>
      <li data-s="bridge" data-b>Bridge delivers on the other chain</li>
    </ol>
    <div id="result"></div>`;
  const note = () => S.notes[Number($("#note").value)];
  const splitOn = () => $("#split").open;
  const setAmt = (v) => {
    $("#amt").value = v;
    update();
  };
  const chips = () => {
    const bal = note().balance;
    $("#wchips").innerHTML = ROUND.filter((v) => parseEther(v) <= bal)
      .map((v) => `<button class="chip" data-v="${v}">${v}</button>`)
      .join("");
    $("#wchips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => setAmt(c.dataset.v)));
  };
  chips();
  const picks = { dest: mountPicker($("#dest")), token: mountPicker($("#token"), { kind: "token" }) };
  $("#max").onclick = () => setAmt(formatEther(note().balance));
  let timer;
  let seq = 0;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 400);
  };
  ["#amt", "#to", "#tos", "#parts", "#spread"].forEach((s) => $(s).addEventListener("input", update));
  $("#note").addEventListener("input", () => (chips(), update()));
  $("#split").addEventListener("toggle", () => {
    $("#to").hidden = $("#toLabel").hidden = splitOn();
    if (splitOn() && !$("#tos").value && $("#to").value) $("#tos").value = $("#to").value;
    update();
  });
  const tokenValue = () => $("#token")?.value || undefined;
  $("#dest").addEventListener("input", () => {
    const r = routeOf($("#dest").value);
    const tok = $("#token");
    tok.hidden = !r || r.tokens.length < 2;
    tok.innerHTML = (r?.tokens ?? []).map((t) => `<option value="${esc(t.symbol)}">${esc(t.symbol)}${t.name && t.name !== t.symbol ? ` · ${esc(t.name)}` : ""}</option>`).join("");
    $("#toLabel").textContent = r ? `Recipient on ${r.name} (a fresh wallet)` : "Recipient (a fresh wallet)";
    $("#to").placeholder = r ? { evm: "0x…", solana: "Solana address", btc: "bc1… / 1… / 3…", zec: "t1… (transparent)" }[r.kind] : "0x…";
    picks.token.refresh();
    picks.dest.refresh();
    const vias = [...new Set((r?.tokens ?? []).flatMap((t) => t.providers))].map((p) => ({ relay: "Relay", near: "NEAR Intents", echo: "echo" })[p] ?? p);
    const path = ["pool", "a one-time hop wallet", ...(vias.length ? [vias.join(" or ")] : []), r?.name].filter(Boolean).join(" → ");
    $("#destNote").innerHTML = r
      ? `<div class="note">Goes <b>${esc(path)}</b>. The hop wallet comes from your Zero Key; if the swap cannot be filled, the ETH lands back there and you can retry from <a href="#mine">My deposits</a>. The bridge sees the amount and the destination, never your deposit.</div>`
      : "";
    update();
  });
  $("#token").addEventListener("input", update);

  function recipients() {
    const r = routeOf($("#dest").value);
    const list = splitOn() ? $("#tos").value.split(/\s+/).map((x) => x.trim()).filter(Boolean) : [$("#to").value.trim()].filter(Boolean);
    const ok = (a) => (r ? validRecipient(r.kind, a) : isAddress(a));
    return { list: list.map((a) => (!r || r.kind === "evm") && isAddress(a) ? getAddress(a) : a), bad: list.filter((a) => !ok(a)), route: r };
  }

  async function check() {
    const my = ++seq;
    if (!$("#dest")) return; // the view was replaced while this was queued
    const n = note();
    const warn = [];
    let ok = true;
    let amount = 0n;
    try {
      amount = parseEther($("#amt").value.trim() || "0");
    } catch {
      ok = false;
    }
    if (amount <= 0n || amount > n.balance) ok = false;
    const parts = splitOn() ? Number($("#parts").value) : 1;
    const each = splitOn() ? ((amount / BigInt(parts)) / MIN_PART) * MIN_PART : amount;
    if (splitOn() && amount > 0n && each < MIN_PART) {
      warn.push(`<div class="note bad">Each part must be at least 0.001 ETH.</div>`);
      ok = false;
    }
    const { list, bad, route } = recipients();
    if (bad.length) {
      warn.push(`<div class="note bad">Not a valid ${route ? esc(route.name) : ""} address: <span class="mono">${esc(bad[0])}</span></div>`);
      ok = false;
    }
    if (!list.length) ok = false;
    if (splitOn() && list.length && list.length < parts)
      warn.push(`<div class="note warn">${parts} parts but ${list.length} recipient${list.length > 1 ? "s" : ""}: parts sent to the same wallet are linked to each other. One fresh wallet per part hides best.</div>`);
    const dep = await shade.pub.getTransaction({ hash: n.depositTx }).catch(() => null);
    for (const to of list.filter(isAddress)) {
      const t = to.toLowerCase();
      if (S.address && t === S.address.toLowerCase())
        warn.push(`<div class="note bad">${short(to)} is your connected wallet. Withdrawing to it links you back. Use a brand-new wallet.</div>`);
      if (dep && t === dep.from.toLowerCase()) warn.push(`<div class="note bad">${short(to)} made the deposit. Anyone can link them.</div>`);
      if (!route) {
        const used = await shade.pub.getTransactionCount({ address: to }).catch(() => 0);
        if (used > 0) warn.push(`<div class="note warn">${short(to)} has sent transactions before. A fresh wallet hides better.</div>`);
      }
    }
    // privacy meter, from the public deposit list
    if (amount > 0n) {
      try {
        const [crowd, blk] = await Promise.all([shade.crowd(), shade.pub.getBlock({ blockNumber: n.depositBlock })]);
        if (my !== seq) return;
        $("#meter").innerHTML = meterHtml(privacyCheck({ crowd, note: n, amount: each, ageSec: Date.now() / 1000 - Number(blk.timestamp) }));
      } catch {
        $("#meter").innerHTML = "";
      }
    } else $("#meter").innerHTML = "";
    if (my !== seq) return;
    $("#checks").innerHTML = warn.join("");
    $("#go").textContent = splitOn() ? `Create plan: ${parts} × ${eth(each)} ETH` : "Generate proof & withdraw";
    if (!ok) {
      $("#go").disabled = true;
      return;
    }
    try {
      if (!route) {
        const q = await shade.quote(each, list[0]);
        if (my !== seq) return;
        const fee = (each * BigInt(q.feeBPS)) / 10_000n;
        const max = S.pool?.maxRelayFeeBPS ?? 50n;
        const tooHigh = BigInt(q.feeBPS) > max;
        $("#quote").className = `note ${tooHigh ? "bad" : "good"}`;
        $("#quote").innerHTML = tooHigh
          ? `The relayer asks ${(Number(q.feeBPS) / 100).toFixed(2)}% of this amount, above the pool's ${Number(max) / 100}% cap. Withdraw a larger amount or use another relayer.`
          : `${fee === 0n ? "No relayer fee: the relayer pays the gas." : `Relayer fee ${(Number(q.feeBPS) / 100).toFixed(2)}% (${eth(fee, 6)} ETH).`} ${splitOn() ? "Each part" : "Recipient"} gets <b>${eth(each - fee, 6)} ETH</b>.`;
        $("#go").disabled = tooHigh;
      } else {
        // preview only: the real quote (and hop wallet) is made when you press the button
        S.previewHop ??= hopAccount(S.mnemonic, await nextHop(shade.pub, S.mnemonic, usedHops())).address;
        const q0 = await shade.quote(each, S.previewHop);
        const net = each - (each * BigInt(q0.feeBPS)) / 10_000n;
        const q = await bridge.quote({ route: route.id, token: tokenValue(), amount: net - (await hopReserve(shade.pub)), recipient: list[0], refundTo: S.previewHop });
        if (my !== seq) return;
        const via = { relay: "Relay", near: "NEAR Intents", echo: "echo" }[q.provider];
        $("#quote").className = "note good";
        $("#quote").innerHTML = `${splitOn() ? "Each part" : "You"} receive about <b>${fmtUnits(q.amountOut, q.decimals)} ${esc(q.symbol)}</b> on ${esc(route.name)} via ${via}${q.eta ? ` (~${q.eta < 90 ? `${q.eta} s` : `${Math.round(q.eta / 60)} min`})` : ""}. Minimum ${fmtUnits(q.minOut, q.decimals)} ${esc(q.symbol)}.${q.others?.length ? ` <span class="meta">Best of ${q.others.length + 1} bridges.</span>` : ""}`;
        $("#go").disabled = false;
      }
    } catch (e) {
      if (my !== seq) return;
      $("#quote").className = "note bad";
      $("#quote").textContent = `${route ? "Bridge" : "Relayer"}: ${errMsg(e)}`;
      $("#go").disabled = true;
    }
  }

  $("#go").onclick = async () => {
    const n = note();
    const amount = parseEther($("#amt").value.trim());
    const dest = $("#dest").value;
    const { list } = recipients();
    if (splitOn()) {
      try {
        const plan = makePlan({ label: n.label, total: amount, parts: Number($("#parts").value), hours: Number($("#spread").value), dest, token: tokenValue(), recipients: list });
        S.local.plans.unshift(plan);
        await saveL();
        toast(`Plan saved: ${plan.parts.length} parts. Keep this tab open.`);
        location.hash = "#mine";
      } catch (e) {
        toast(errMsg(e), true);
      }
      return;
    }
    $("#steps").hidden = false;
    const lis = [...$("#steps").children].filter((li) => dest !== "rh" || !li.hasAttribute("data-b"));
    $("#steps").querySelectorAll("[data-b]").forEach((li) => (li.hidden = dest === "rh"));
    const step = (s) => {
      let seen = false;
      for (const li of lis) li.className = li.dataset.s === s ? ((seen = true), "on") : seen ? "" : "done";
    };
    try {
      await withBusy($("#go"), async () => {
        const r = await doWithdraw({ label: n.label, amount, dest, token: tokenValue(), recipient: list[0] }, step);
        S.previewHop = null;
        if (!r.bridge) {
          lis.forEach((li) => (li.className = "done"));
          $("#result").innerHTML = `<div class="note good">Done. ${eth(amount)} ETH sent to <span class="mono">${short(list[0])}</span> · tx ${txLink(r.txHash)}</div>`;
          return;
        }
        const b = r.bridge;
        if (b.state === "done") lis.forEach((li) => (li.className = "done"));
        $("#result").innerHTML = `<div class="note ${b.state === "done" ? "good" : b.state === "processing" || b.state === "bridging" ? "" : "bad"}">${bridgeLine(b)}</div>`;
      });
    } catch (e) {
      S.previewHop = null;
      $("#result").innerHTML = `<div class="note bad">${esc(errMsg(e))}${S.local.bridges[0]?.state === "hop" ? " Your ETH is safe in the hop wallet: retry from My deposits." : ""}</div>`;
    }
  };
  if (S.pick !== undefined) $("#max").click();
  $("#dest").dispatchEvent(new Event("input"));
}

function bridgeLine(b) {
  const q = b.quote;
  const r = routeOf(b.dest);
  const what = `${eth(BigInt(b.amount))} ETH → ${q ? `~${fmtUnits(q.amountOut, q.decimals)} ${esc(q.symbol)}` : "?"} on ${esc(r?.name ?? b.dest)}`;
  const state = { withdrawing: "withdrawing", hop: "waiting in hop wallet", bridging: "bridging…", processing: "bridging…", done: "delivered ✅", refunded: "refunded to the hop wallet", failed: "failed" }[b.state] ?? b.state;
  const links = [b.withdrawTx && `withdraw ${txLink(b.withdrawTx)}`, b.hopTx && `hop ${txLink(b.hopTx)}`, b.destTxUrl ? `<a href="${esc(b.destTxUrl)}" target="_blank" rel="noreferrer">destination tx</a>` : b.destTx ? `dest <span class="mono">${esc(short(b.destTx))}</span>` : ""].filter(Boolean);
  return `${what} · <b>${state}</b>${q ? ` · via ${{ relay: "Relay", near: "NEAR Intents", echo: "echo" }[q.provider]}` : ""}<div class="meta">${links.join(" · ")}</div>`;
}

/** Plans, bridge withdrawals and hop wallets, under My deposits. */
function renderLocalPanels(host) {
  const plans = S.local?.plans ?? [];
  const bridges = S.local?.bridges ?? [];
  const fmtAt = (t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  host.innerHTML = `
    ${plans
      .map((p, pi) => {
        const left = p.parts.filter((x) => x.state !== "done" && x.state !== "failed" && x.state !== "cancelled");
        const r = routeOf(p.dest);
        return `<div class="plan">
          <div class="row"><b style="flex:1">Split plan · ${p.parts.length} × ${eth(BigInt(p.parts[0].amount))} ETH → ${esc(p.token ? `${p.token} on ${r?.name ?? p.dest}` : (r?.name ?? cfg.chainName))}</b>
            ${left.length ? `<button class="btn ghost sm" data-run="${pi}">Run next now</button><button class="btn danger sm" data-cancel="${pi}">Cancel rest</button>` : `<button class="btn ghost sm" data-del="${pi}">Remove</button>`}</div>
          <ol class="parts">${p.parts
            .map(
              (x) => `<li class="${x.state}"><span>${eth(BigInt(x.amount))} ETH → <span class="mono">${esc(short(x.to))}</span></span>
                <span class="meta">${x.state === "done" ? `sent ${fmtAt(x.doneAt ?? x.at)} · ${txLink(x.tx)}` : x.state === "todo" ? `due ${fmtAt(x.at)}` : x.state === "retry" ? `retrying (${esc(x.error ?? "")})` : esc(x.state + (x.error ? `: ${x.error}` : ""))}</span></li>`,
            )
            .join("")}</ol>
        </div>`;
      })
      .join("")}
    ${bridges.length ? `<h3>Withdrawals to other chains</h3><div class="list">${bridges.slice(0, 12).map((b, i) => `<div class="note">${bridgeLine(b)}${["bridging", "processing"].includes(b.state) ? ` <button class="chip" data-chk="${i}">Check</button>` : ""}</div>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:14px"><button class="btn ghost sm" id="scanHops">Check hop wallets</button><span class="meta">Bridge refunds and unfinished bridges wait here.</span></div>
    <div id="hops"></div>`;
  host.querySelectorAll("[data-run]").forEach((b) => (b.onclick = () => {
    const p = plans[Number(b.dataset.run)];
    const next = p.parts.find((x) => x.state === "todo" || x.state === "retry");
    if (next) withBusy(b, () => runPlans(next.state === "todo" ? next : (next.retryAt = 0, undefined)));
  }));
  host.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Cancel the parts that have not run yet? The ETH stays in your deposit.")) return;
    plans[Number(b.dataset.cancel)].parts.forEach((x) => ["todo", "retry"].includes(x.state) && (x.state = "cancelled"));
    await saveL();
    render();
  }));
  host.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    plans.splice(Number(b.dataset.del), 1);
    await saveL();
    render();
  }));
  host.querySelectorAll("[data-chk]").forEach((b) => (b.onclick = () => withBusy(b, () => watchBridge(bridges[Number(b.dataset.chk)], 1)).then(render)));
  $("#scanHops", host).onclick = () =>
    withBusy($("#scanHops", host), async () => {
      S.hops = (await hopScan(shade.pub, S.mnemonic, usedHops())).filter((h) => h.balance > DUST);
      drawHops($("#hops", host));
    });
  if (S.hops) drawHops($("#hops", host)); // keep the last scan across the 1 s re-renders
}

function drawHops(host) {
  const hops = S.hops;
  if (!hops.length) return void (host.innerHTML = `<div class="note">No ETH waiting in hop wallets.</div>`);
  host.innerHTML = hops
    .map((h) => {
      const rec = S.local.bridges.find((b) => b.hop === h.i);
      return `<div class="note warn"><b>${eth(h.balance, 6)} ETH</b> in hop wallet #${h.i} <span class="mono">${short(h.address)}</span>${rec ? ` (bridge to ${esc(routeOf(rec.dest)?.name ?? rec.dest)} <span class="mono">${esc(short(rec.recipient))}</span>)` : ""}
        <div class="row" style="margin-top:8px">${rec ? `<button class="btn sm" data-retry="${h.i}">Bridge it again</button>` : ""}<button class="btn sm" data-pool="${h.i}">Deposit it into the pool</button><button class="btn ghost sm" data-sweep="${h.i}">Send to a ${esc(cfg.chainName)} address</button></div></div>`;
    })
    .join("");
  host.querySelectorAll("[data-retry]").forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const i = Number(b.dataset.retry);
    const rec = S.local.bridges.find((x) => x.hop === i);
    const hop = hopAccount(S.mnemonic, i);
    try {
      const bal = await shade.pub.getBalance({ address: hop.address });
      const q = await bridge.quote({ route: rec.dest, token: rec.token, amount: bal - (await hopReserve(shade.pub)), recipient: rec.recipient, refundTo: hop.address });
      if (!confirm(`Bridge ${eth(bal, 6)} ETH again → about ${fmtUnits(q.amountOut, q.decimals)} ${q.symbol} on ${routeOf(rec.dest)?.name}?`)) return;
      await bridgeFromHop(rec, hop, q);
      toast("Sent to the bridge. Checking…");
      await watchBridge(rec, 10 * 60_000);
    } catch (e) {
      toast(errMsg(e), true);
    }
    S.hops = null;
    render();
  })));
  // ETH on a hop can go back into the pool rather than on to a wallet: that is how a swap that
  // was paid here while the tab was closed is finished later.
  host.querySelectorAll("[data-pool]").forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const i = Number(b.dataset.pool);
    try {
      const hop = hopAccount(S.mnemonic, i);
      const reserve = await depositReserve(shade.pub);
      const value = (await shade.pub.getBalance({ address: hop.address })) - reserve;
      if (value <= 0n) return toast("Not enough there to cover the deposit's gas", true);
      if (!confirm(`Deposit ${eth(value, 6)} ETH from hop wallet #${i} into the pool?`)) return;
      await hopDeposit(shade.pub, shade.chain, hop, shade.depositTx(S.acct, value), reserve, S.pool?.minimumDepositAmount ?? 0n);
      await settle();
      S.notes = await shade.notes(S.acct).catch(() => S.notes);
      toast(`Deposited ${eth(value, 6)} ETH. It needs the screening window before you can withdraw it.`);
    } catch (e) {
      toast(errMsg(e), true);
    }
    S.hops = null;
    render();
  })));

  host.querySelectorAll("[data-sweep]").forEach((b) => (b.onclick = () => withBusy(b, async () => {
    const to = prompt(`Send everything in hop wallet #${b.dataset.sweep} to which ${cfg.chainName} address? Use a fresh wallet, not your deposit wallet.`);
    if (!to) return;
    if (!isAddress(to.trim())) return toast("Not a valid address", true);
    try {
      const r = await hopSend(shade.pub, shade.chain, hopAccount(S.mnemonic, Number(b.dataset.sweep)), getAddress(to.trim()), "all");
      toast(`Sent ${eth(r.value, 6)} ETH.`);
    } catch (e) {
      toast(errMsg(e), true);
    }
    S.hops = null;
    render();
  })));
}

async function viewVerify(el) {
  const d = cfg.deployment;
  el.innerHTML = `
    <h2>Verify it yourself</h2>
    <p class="sub">Don't trust us. Check.</p>
    <h3>Contracts (${esc(cfg.chainName)}, chain ${d.chainId})</h3>
    <dl class="kv">
      <dt>Entrypoint</dt><dd>${addrLink(d.entrypoint)}</dd>
      <dt>ETH pool</dt><dd>${addrLink(d.pool)}</dd>
      <dt>Withdrawal verifier</dt><dd>${addrLink(d.withdrawalVerifier)}</dd>
      <dt>Ragequit verifier</dt><dd>${addrLink(d.ragequitVerifier)}</dd>
      ${d.asp ? `<dt>ZeroPrintASP</dt><dd>${addrLink(d.asp)}</dd><dt>Guardian</dt><dd>${addrLink(d.guardian)}</dd>` : `<dt>ASP postman</dt><dd>${addrLink(d.postman)}</dd>`}
    </dl>
    <h3>Live checks</h3>
    <dl class="kv" id="live"><dt>…</dt><dd>checking</dd></dl>
    <h3>Prove the proof is made in your browser</h3>
    <ol class="howto">
      <li>Open <b>DevTools → Network</b> before you withdraw.</li>
      <li>You will see <code>/artifacts/withdraw.wasm</code> and <code>withdraw.zkey</code> download. The SDK checks their SHA-256 against the 0xbow ceremony hashes before using them.</li>
      <li>The only thing sent out is <code>POST /relayer/request</code>: it holds the proof, amount and recipient. Search it: your 12 words, nullifier and secret are not there.</li>
      <li><b>Offline test:</b> load this page, unlock, then set DevTools Network to <b>Offline</b> after the quote. The proof step still finishes; only the relay step needs the network.</li>
      <li>The ASP list is downloaded whole and checked against the on-chain root here, so the ASP cannot see which deposit is yours.</li>
    </ol>
    <h3>No admin keys</h3>
    <p class="sub">The deployer renounced <code>OWNER_ROLE</code> right after setup. Nobody can upgrade the contracts, pause or remove the pool, or move funds. The postman can only publish ASP roots; if it misbehaves, ragequit still returns your ETH.</p>`;
  const live = [];
  try {
    const owner = await shade.pub.readContract({
      address: d.entrypoint,
      abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }],
      functionName: "hasRole",
      args: [keccak256(toHex("OWNER_ROLE")), cfg.deployer],
    });
    live.push(["Deployer still owner?", owner ? "⚠️ YES" : "✅ no (renounced)"]);
  } catch (e) {
    live.push(["Deployer still owner?", `could not check: ${esc(errMsg(e))}`]);
  }
  try {
    const set = await shade.aspSet();
    live.push(["ASP root on-chain", set.onchain.toString().slice(0, 18) + "…"]);
    live.push(["ASP list matches chain", set.labels.length ? "✅ yes" : "no roots yet"]);
    live.push(["Approved deposits", String(set.labels.length)]);
  } catch (e) {
    live.push(["ASP list matches chain", `⚠️ ${esc(errMsg(e))}`]);
  }
  live.push(["Pool balance", `${eth(await shade.pub.getBalance({ address: d.pool }))} ETH`]);
  $("#live").innerHTML = live.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
}

const views = { deposit: viewDeposit, withdraw: viewWithdraw, swap: viewSwap, mine: viewMine, verify: viewVerify };

function render() {
  renderKey();
  const [v = "deposit", qs = ""] = location.hash.slice(1).split("?");
  if (v === "footprint") return void location.replace(`/footprint${qs ? `?${qs}` : ""}`); // has its own page now
  const view = views[v] ? v : "deposit";
  // Two levels: the section pills say which part of the site you are in, the tabs which part of
  // the pool. A swap needs no key and no deposit, so neither the key panel nor the pool tabs
  // belong on screen while you are there.
  const section = view === "swap" ? "#swap" : view === "verify" ? "#verify" : "#deposit";
  document.querySelectorAll("#segnav a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === section));
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${view}`));
  const pool = section === "#deposit";
  $("#tabs").hidden = !pool;
  $("#keybox").hidden = !pool;
  views[view]($("#view"), new URLSearchParams(qs));
}

async function refreshStats() {
  try {
    const [st, bal] = await Promise.all([shade.anonymitySet(), shade.pub.getBalance({ address: cfg.deployment.pool })]);
    $("#st-set").textContent = st.approved;
    $("#st-pool").textContent = eth(bal, 3);
    $("#st-delay").textContent = st.delaySec >= 3600 ? `${st.delaySec / 3600} h` : `${Math.round(st.delaySec / 60)} min`;
  } catch {}
}

// What the Swap tab needs to finish a swap inside the pool. It never reaches into this file's
// state itself; everything it can do with a key is one of these four things.
enableDeep({
  chainName: cfg.chainName,
  waitText: `${Math.round(cfg.delaySec / 60)}-minute screening`,
  unlocked: () => !!S.mnemonic,
  async freshHop() {
    const index = await nextHop(shade.pub, S.mnemonic, usedHops());
    return { index, address: hopAccount(S.mnemonic, index).address };
  },
  async depositFromHop(index) {
    await loadAccount();
    const hop = hopAccount(S.mnemonic, index);
    const reserve = await depositReserve(shade.pub);
    const balance = await shade.pub.getBalance({ address: hop.address });
    const value = balance - reserve;
    if (value <= 0n) throw new Error("Nothing has arrived on that wallet yet");
    const sent = await hopDeposit(shade.pub, shade.chain, hop, shade.depositTx(S.acct, value), reserve, S.pool?.minimumDepositAmount ?? 0n);
    await settle();
    S.notes = await shade.notes(S.acct).catch(() => S.notes);
    S.hops = null;
    return sent;
  },
});

boot({ cfg, shade });
// Mainnet / Testnet switch (each network is its own site)
function netSwitch(host) {
  const n = cfg.networks;
  if (!n) return void (host.textContent = cfg.chainName);
  const here = cfg.chainName.includes("Testnet") ? "testnet" : "mainnet";
  host.className = "netsw";
  host.innerHTML = ["mainnet", "testnet"]
    .map((k) =>
      k === here
        ? `<span class="on">${k === "mainnet" ? "Mainnet" : "Testnet"}</span>`
        : n[k]
          ? `<a href="${n[k]}/app"${k === "testnet" ? ` target="_blank" rel="noopener"` : ""}>${k === "mainnet" ? "Mainnet" : "Testnet"}</a>`
          : `<span class="off" title="Not live yet">${k === "mainnet" ? "Mainnet" : "Testnet"}</span>`,
    )
    .join("");
}
netSwitch($("#net"));
startShade($("#fx"), { intensity: 0.45 });
$("#connect").onclick = () => {
  S.walletChosen = false; // always show the picker on an explicit click
  connect().catch((e) => toast(errMsg(e), true));
};
window.addEventListener("hashchange", render);
shade
  .poolConfig()
  .then((p) => {
    S.pool = p;
    if (location.hash === "#deposit" || !location.hash) render();
  })
  .catch(() => {});
bridge.routes().then((r) => {
  S.routes = r;
  if (location.hash.startsWith("#withdraw")) render();
});
render();
refreshStats();
setInterval(refreshStats, 30_000);
setInterval(runPlans, 30_000);
setInterval(() => {
  if (location.hash === "#mine" && S.notes.some((n) => n.state === "pending")) render();
}, 1000);
setInterval(async () => {
  if (S.acct && S.notes.some((n) => n.state === "pending")) {
    S.notes = await shade.notes(S.acct).catch(() => S.notes);
  }
}, 20_000);
