import "./style.css";
import "./landing.css";
import "./docs.css";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Live addresses from the running deployment
fetch("/config.json", { cache: "no-store" })
  .then((r) => r.json())
  .then((cfg) => {
    const d = cfg.deployment;
    $("#netName").textContent = cfg.chainName;
    const link = (a) =>
      cfg.explorer ? `<a class="mono" href="${esc(cfg.explorer)}/address/${esc(a)}" target="_blank" rel="noreferrer">${esc(a)}</a>` : `<span class="mono">${esc(a)}</span>`;
    const rows = [
      ["Chain ID", `<span class="mono">${d.chainId}</span>`],
      ["Entrypoint (proxy)", link(d.entrypoint)],
      ["ETH pool", link(d.pool)],
      ["Withdrawal verifier", link(d.withdrawalVerifier)],
      ["Ragequit verifier", link(d.ragequitVerifier)],
      ["ASP postman", link(d.postman)],
      ["Owner", d.ownerRenounced ? "Renounced" : "—"],
    ];
    $("#addrRows").innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td class="muted">Not deployed</td></tr>`).join("");
  })
  .catch(() => {});

// Scrollspy: highlight the section being read
const links = [...document.querySelectorAll("#toc a")];
const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.remove("on"));
      byId.get(e.target.id)?.classList.add("on");
    }
  },
  { rootMargin: "-20% 0px -70% 0px" },
);
document.querySelectorAll(".docs-main section[id]").forEach((s) => io.observe(s));

// Search: filter the table of contents by section text
const sections = [...document.querySelectorAll(".docs-main section[id]")].map((s) => [s.id, s.textContent.toLowerCase()]);
$("#q").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const [id, text] of sections) byId.get(id)?.classList.toggle("hide", !!q && !text.includes(q));
  document.querySelectorAll("#toc h4").forEach((h) => {
    let n = h.nextElementSibling;
    let any = false;
    while (n && n.tagName === "A") {
      if (!n.classList.contains("hide")) any = true;
      n = n.nextElementSibling;
    }
    h.classList.toggle("hide", !any);
  });
});

// Mobile contents drawer
$("#menuBtn").onclick = () => $("#side").classList.toggle("open");
links.forEach((a) => a.addEventListener("click", () => $("#side").classList.remove("open")));

// Copy buttons on code blocks
document.querySelectorAll("pre.code").forEach((pre) => {
  const b = document.createElement("button");
  b.className = "copy";
  b.textContent = "copy";
  b.onclick = () => navigator.clipboard?.writeText(pre.innerText).then(() => ((b.textContent = "copied"), setTimeout(() => (b.textContent = "copy"), 1200)));
  pre.append(b);
});
