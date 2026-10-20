import "./style.css";
import { createWalletClient, custom, formatEther, getAddress, isAddress, keccak256, parseEther, toHex } from "viem";
import { english, generateMnemonic } from "viem/accounts";
import { startShade } from "./bgfx.js";
import { boot } from "./boot.js";
import { createShade, settle } from "./core.js";
import { forgetKey, hasStoredKey, saveKey, unlockKey } from "./keystore.js";

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
const shade = createShade({
  rpcUrl: `${origin}/rpc`,
  chainName: cfg.chainName,
  deployment: cfg.deployment,
  aspUrl: `${origin}/asp`,
  relayerUrl: `${origin}/relayer`,
  circuits: { browser: true, baseUrl: `${origin}/` },
});

const S = {
  mnemonic: null, // only in memory while unlocked
  acct: null,
  notes: [],
  wallet: null,
  address: null,
  pool: null,
  draftWords: null,
};

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
      Object.assign(S, { mnemonic: null, acct: null, notes: [] });
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
    ${S.mnemonic ? "" : needKey}
    <label>Amount (min ${min} ETH)</label>
    <input id="amt" class="amount" inputmode="decimal" placeholder="0.1" />
    <div class="chips">${["0.01", "0.05", "0.1", "0.5", "1"].map((v) => `<button class="chip" data-v="${v}">${v}</button>`).join("")}</div>
    <div class="note">Round amounts hide better: a deposit of 0.3712 ETH followed by a withdrawal of 0.3712 ETH is easy to match.</div>
    <button class="btn wide" id="dep" ${S.mnemonic ? "" : "disabled"}>${S.address ? "Deposit" : "Connect wallet & deposit"}</button>`;
  el.querySelectorAll(".chip").forEach((c) => (c.onclick = () => ($("#amt").value = c.dataset.v)));
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
    }</div>`;
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

function viewWithdraw(el) {
  if (!S.mnemonic) return (el.innerHTML = `<h2>Withdraw privately</h2>${needKey}`);
  const ready = S.notes.map((n, i) => ({ n, i })).filter(({ n }) => n.state === "approved" && n.balance > 0n);
  if (!ready.length) {
    el.innerHTML = `<h2>Withdraw privately</h2><div class="note">No approved deposits with a balance yet. Check <a href="#mine">My deposits</a>.</div>`;
    return;
  }
  const pick = ready.some((r) => r.i === S.pick) ? S.pick : ready[0].i;
  el.innerHTML = `
    <h2>Withdraw privately</h2>
    <p class="sub">The proof is made here in your browser. The relayer pays the gas, so the new wallet needs nothing and never touches your old one.</p>
    <label>From deposit</label>
    <select id="note">${ready.map(({ n, i }) => `<option value="${i}" ${i === pick ? "selected" : ""}>${eth(n.balance)} ETH · ${short(n.label)}</option>`).join("")}</select>
    <label>Amount</label>
    <div class="row"><input id="amt" class="amount" inputmode="decimal" style="flex:1" /><button class="chip" id="max">Max</button></div>
    <label>Recipient (a fresh wallet)</label>
    <input id="to" placeholder="0x…" autocomplete="off" spellcheck="false" />
    <div id="checks"></div>
    <div id="quote" class="note">Enter an amount and a recipient to get the relayer fee.</div>
    <button class="btn wide" id="go" disabled>Generate proof & withdraw</button>
    <ol class="steps" id="steps" hidden>
      <li data-s="quote">Relayer fee quote</li>
      <li data-s="trees">Rebuild pool tree + check ASP set against the chain</li>
      <li data-s="prove">Zero-knowledge proof (in this browser)</li>
      <li data-s="relay">Relayer submits the transaction</li>
    </ol>
    <div id="result"></div>`;
  const note = () => S.notes[Number($("#note").value)];
  $("#max").onclick = () => {
    $("#amt").value = formatEther(note().balance);
    update();
  };
  let timer;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 350);
  };
  ["#amt", "#to", "#note"].forEach((s) => $(s).addEventListener("input", update));

  async function check() {
    const n = note();
    const to = $("#to").value.trim();
    const warn = [];
    let ok = true;
    let amount = 0n;
    try {
      amount = parseEther($("#amt").value.trim() || "0");
    } catch {
      ok = false;
    }
    if (amount <= 0n || amount > n.balance) ok = false;
    if (to && !isAddress(to)) {
      warn.push(`<div class="note bad">That is not a valid address.</div>`);
      ok = false;
    }
    if (isAddress(to)) {
      const t = to.toLowerCase();
      if (S.address && t === S.address.toLowerCase())
        warn.push(`<div class="note bad">This is your connected wallet. Withdrawing to it links you back. Use a brand-new wallet.</div>`);
      const depLog = await shade.pub.getTransaction({ hash: n.depositTx }).catch(() => null);
      if (depLog && t === depLog.from.toLowerCase())
        warn.push(`<div class="note bad">This is the wallet that made the deposit. Anyone can link them.</div>`);
      const used = await shade.pub.getTransactionCount({ address: to }).catch(() => 0);
      if (used > 0) warn.push(`<div class="note warn">This wallet has sent transactions before. A fresh wallet hides better.</div>`);
    }
    const dep = await shade.pub.getBlock({ blockNumber: n.depositBlock }).catch(() => null);
    if (dep && Date.now() / 1000 - Number(dep.timestamp) < 3600)
      warn.push(`<div class="note warn">Deposited less than an hour ago. Waiting longer (and letting others deposit) makes the link harder to guess.</div>`);
    if (amount > 0n && !/^\d+(\.\d{1,2})?$/.test(formatEther(amount)))
      warn.push(`<div class="note warn">Unusual amount. Exact odd amounts are easy to match; consider a round amount and withdrawing the rest later.</div>`);
    $("#checks").innerHTML = warn.join("");
    if (!ok || !isAddress(to)) {
      $("#go").disabled = true;
      return;
    }
    try {
      const q = await shade.quote(amount, getAddress(to));
      const fee = (amount * BigInt(q.feeBPS)) / 10_000n;
      const max = S.pool?.maxRelayFeeBPS ?? 50n;
      const tooHigh = BigInt(q.feeBPS) > max;
      $("#quote").className = `note ${tooHigh ? "bad" : "good"}`;
      $("#quote").innerHTML = tooHigh
        ? `The relayer asks ${(Number(q.feeBPS) / 100).toFixed(2)}% of this amount, above the pool's ${Number(max) / 100}% cap. Withdraw a larger amount or use another relayer.`
        : fee === 0n
          ? `No relayer fee: the relayer pays the gas. Recipient gets <b>${eth(amount, 6)} ETH</b>.`
          : `Relayer fee ${(Number(q.feeBPS) / 100).toFixed(2)}% (${eth(fee, 6)} ETH). Recipient gets <b>${eth(amount - fee, 6)} ETH</b>.`;
      $("#go").disabled = tooHigh;
    } catch (e) {
      $("#quote").className = "note bad";
      $("#quote").textContent = `Relayer: ${errMsg(e)}`;
      $("#go").disabled = true;
    }
  }

  $("#go").onclick = async () => {
    const n = note();
    const amount = parseEther($("#amt").value.trim());
    const to = getAddress($("#to").value.trim());
    $("#steps").hidden = false;
    const lis = [...$("#steps").children];
    const step = (s) => {
      let seen = false;
      for (const li of lis) {
        li.className = li.dataset.s === s ? ((seen = true), "on") : seen ? "" : "done";
      }
    };
    try {
      await withBusy($("#go"), async () => {
        await loadAccount();
        const fresh = S.notes.find((x) => x.label === n.label);
        const r = await shade.withdraw(S.acct, fresh, amount, to, step);
        lis.forEach((li) => (li.className = "done"));
        await shade.pub.waitForTransactionReceipt({ hash: r.txHash });
        await settle();
        $("#result").innerHTML = `<div class="note good">Done. ${eth(amount)} ETH (minus gas fee) sent to <span class="mono">${short(to)}</span> · tx ${txLink(r.txHash)}</div>`;
        await loadAccount();
      });
    } catch (e) {
      $("#result").innerHTML = `<div class="note bad">${esc(errMsg(e))}</div>`;
    }
  };
  if (S.pick !== undefined) $("#max").click();
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

const views = { deposit: viewDeposit, withdraw: viewWithdraw, mine: viewMine, verify: viewVerify };

function render() {
  renderKey();
  const [v = "deposit", qs = ""] = location.hash.slice(1).split("?");
  if (v === "footprint") return void location.replace(`/footprint${qs ? `?${qs}` : ""}`); // has its own page now
  const view = views[v] ? v : "deposit";
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === `#${view}`));
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
          ? `<a href="${n[k]}/app">${k === "mainnet" ? "Mainnet" : "Testnet"}</a>`
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
render();
refreshStats();
setInterval(refreshStats, 30_000);
setInterval(() => {
  if (location.hash === "#mine" && S.notes.some((n) => n.state === "pending")) render();
}, 1000);
setInterval(async () => {
  if (S.acct && S.notes.some((n) => n.state === "pending")) {
    S.notes = await shade.notes(S.acct).catch(() => S.notes);
  }
}, 20_000);
