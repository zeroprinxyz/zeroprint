// A coat over a native <select>: the select keeps the value, fires its own events and stays the
// thing every other line of the app reads. We draw a nicer list over it, with each chain's mark,
// and hand the keys back to it. If this file never runs, the form still works.
//
// Token lists are long and never complete, so theirs opens with a search field: type to narrow it,
// or paste an address nobody listed and let the page go and ask about it.
import { markFor, tokenMark } from "./marks.js";

/** The select's options as a list model: what to draw. */
export const optionsOf = (select) =>
  [...(select.options ?? [])].map((o) => ({ value: o.value, label: o.textContent, selected: o.value === select.value }));

/** Where a key moves the highlight. Anything else leaves it where it was. */
export function moveIndex(index, key, length) {
  if (!length) return 0;
  const last = length - 1;
  if (key === "ArrowDown") return Math.min(index + 1, last);
  if (key === "ArrowUp") return Math.max(index - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return last;
  return index;
}

/** Does this option answer what was typed? Symbols and names, in any case, anywhere in the word. */
export const matches = (label, query) => !query || String(label).toLowerCase().includes(query.trim().toLowerCase());

/** Long enough and shaped like one: an address someone pasted rather than a name they typed. */
export const looksLikeAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(v ?? "") || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test((v ?? "").trim());

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Draws `select` as a button and a list. `kind` picks the marks; `search` adds the field at the
 * top of the list; `lookup` is asked about anything typed there that looks like an address and
 * matches nothing, and returns { value, label } for an option to add, or throws with a reason.
 * Returns { refresh, destroy }.
 */
export function mountPicker(select, { kind = "chain", mark, search = false, lookup = null } = {}) {
  if (!select || select.dataset.picked) return { refresh() {}, destroy() {} };
  const glyph = (o) => (mark ? mark(o) : kind === "token" ? tokenMark(o.value) : markFor(o.value));
  select.dataset.picked = "1";
  const wrap = document.createElement("div");
  wrap.className = "pick";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pick-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "pick-list";
  panel.hidden = true;
  panel.innerHTML = `${search ? `<input class="pick-search" type="search" placeholder="Search, or paste an address" autocomplete="off" spellcheck="false" />` : ""}<div class="pick-rows" role="listbox"></div><div class="pick-say"></div>`;
  const rows = panel.querySelector(".pick-rows");
  const say = panel.querySelector(".pick-say");
  const field = panel.querySelector(".pick-search");
  select.after(wrap);
  wrap.append(select, button, panel);
  select.classList.add("pick-native");

  let at = 0;
  let built = "";
  const shown = () => [...rows.children].filter((el) => !el.hidden);

  const draw = () => {
    wrap.hidden = select.hidden;
    const opts = optionsOf(select);
    const here = opts.find((o) => o.selected) ?? opts[0];
    button.innerHTML = here ? `${glyph(here)}<span>${esc(here.label)}</span><span class="pick-caret">▾</span>` : "";
    const sig = opts.map((o) => o.value).join("|");
    if (sig !== built) {
      built = sig;
      rows.innerHTML = opts
        .map((o) => `<div class="pick-opt" role="option" data-v="${esc(o.value)}"><span class="pick-mark">${glyph(o)}</span><span>${esc(o.label)}</span></div>`)
        .join("");
    }
    [...rows.children].forEach((el, i) => {
      el.classList.toggle("on", !!opts[i]?.selected);
      el.setAttribute("aria-selected", String(!!opts[i]?.selected));
    });
  };

  const filter = () => {
    const q = field?.value ?? "";
    const opts = optionsOf(select);
    [...rows.children].forEach((el, i) => (el.hidden = !matches(opts[i]?.label, q)));
    const none = !shown().length;
    say.innerHTML = none
      ? looksLikeAddress(q) && lookup
        ? `<button type="button" class="pick-ask">Look up ${esc(q.trim().slice(0, 10))}…</button>`
        : `<div class="pick-none">Nothing matches that${lookup ? ", and it is not an address" : ""}.</div>`
      : "";
    const ask = say.querySelector(".pick-ask");
    if (ask) ask.onclick = () => askAbout(q.trim());
    highlight(0);
  };

  async function askAbout(query) {
    if (!lookup || !looksLikeAddress(query)) return;
    say.innerHTML = `<div class="pick-none">Asking…</div>`;
    try {
      const added = await lookup(query);
      if (!added) throw new Error("not found");
      draw();
      choose(added.value);
    } catch (e) {
      say.innerHTML = `<div class="pick-none bad">${esc(e.message)}</div>`;
    }
  }

  const close = () => {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    draw();
    if (field) field.value = "";
    filter();
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const sel = shown().findIndex((el) => el.classList.contains("on"));
    highlight(Math.max(0, sel));
    field?.focus();
  };
  const highlight = (i) => {
    const list = shown();
    at = Math.max(0, Math.min(i, list.length - 1));
    list.forEach((el, n) => el.classList.toggle("at", n === at));
    list[at]?.scrollIntoView({ block: "nearest" });
  };
  const choose = (value) => {
    if (value != null && value !== select.value) {
      select.value = value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    close();
    draw();
    button.focus();
  };

  wrap.addEventListener("mousedown", (e) => {
    if (panel.contains(e.target)) return;
    e.preventDefault(); // opening on the press feels immediate, and keeps focus where it is
    panel.hidden ? open() : close();
  });
  wrap.addEventListener("click", (e) => {
    if (panel.contains(e.target) || e.detail !== 0) return; // a touch or Enter arrives with no press
    panel.hidden ? open() : close();
  });
  const keys = (e) => {
    if (panel.hidden) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) e.preventDefault(), open();
      return;
    }
    if (e.key === "Escape") return e.preventDefault(), close(), button.focus();
    if (e.key === "Enter") {
      e.preventDefault();
      const el = shown()[at];
      return el ? choose(el.dataset.v) : askAbout(field?.value ?? "");
    }
    const to = moveIndex(at, e.key, shown().length);
    if (to !== at) e.preventDefault(), highlight(to);
  };
  button.addEventListener("keydown", keys);
  field?.addEventListener("keydown", keys);
  field?.addEventListener("input", filter);
  rows.addEventListener("mousedown", (e) => {
    const opt = e.target.closest(".pick-opt");
    if (opt) e.preventDefault(), choose(opt.dataset.v);
  });
  const away = (e) => !wrap.contains(e.target) && close();
  document.addEventListener("click", away);
  select.addEventListener("input", draw); // the app can still set the value itself
  draw();

  return {
    refresh: draw,
    destroy() {
      document.removeEventListener("click", away);
      delete select.dataset.picked;
      select.classList.remove("pick-native");
      wrap.before(select);
      wrap.remove();
    },
  };
}
