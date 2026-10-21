// The token's address, if there is one. Until it is set the chip says "soon" and
// copies nothing: a placeholder address in somebody's clipboard is the one mistake on this page
// that cannot be taken back, because 0x000… is a burn.
const COPY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7.5" width="13" height="13" rx="3"/><path d="M7.5 3.5h9a4 4 0 0 1 4 4v9"/></svg>`;
const CHART_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.5v3.5M7.5 15v5.5M16.5 3.5v5M16.5 17v3.5"/><rect x="4.5" y="7" width="6" height="8" rx="1.5"/><rect x="13.5" y="8.5" width="6" height="8.5" rx="1.5"/></svg>`;
const CHART_URL = (ca) => `https://gmgn.ai/robinhood/token/${ca}`;

// The chart sits beside the chip, not inside it: a plain link, so it still works when the phone
// menu copies the header as HTML and loses every handler.
function mountChartLink(host, token) {
  const had = host.parentElement?.querySelector(".zero-chart");
  const a = had ?? document.createElement("a");
  a.className = "zero-chart";
  a.href = CHART_URL(token.ca);
  a.target = "_blank";
  a.rel = "noreferrer";
  a.title = `$${token.symbol} chart on GMGN`;
  a.innerHTML = `${CHART_ICON}<span>Chart</span>`;
  // The app header marks each of its items for the phone menu; the landing page marks the whole
  // nav instead, and marking a child of it as well would copy this link into the menu twice.
  if (host.hasAttribute("data-m")) a.setAttribute("data-m", "");
  if (!had) host.insertAdjacentElement("afterend", a);
}

export async function mountZeroChip(host) {
  if (!host) return;
  const token = await fetch("/token-api", { cache: "no-store" })
    .then((r) => r.json())
    .then((j) => j.token)
    .catch(() => null);
  host.hidden = false;
  if (!token) {
    host.className = "zero-chip soon";
    host.textContent = "$ZERO soon";
    host.title = "No contract address yet. When there is one it will appear here.";
    return;
  }
  host.className = "zero-chip hot";
  // The address is shown, not only offered: somebody who wants to check it against another
  // source should not have to hover, and somebody being handed a fake one elsewhere should see
  // the real one at a glance.
  host.innerHTML = `<span class="zero-label">Buy <b>$${token.symbol}</b></span><button type="button" class="zero-copy" title="Copy ${token.ca}" aria-label="Copy the contract address">${COPY_ICON}</button>`;
  const label = host.querySelector(".zero-label");
  const copyBtn = host.querySelector(".zero-copy");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.ca);
      const was = label.innerHTML;
      label.textContent = "Address copied";
      setTimeout(() => (label.innerHTML = was), 1600);
    } catch {
      label.textContent = token.ca; // no clipboard: show it so it can be selected by hand
    }
  };
  copyBtn.onclick = (e) => (e.preventDefault(), e.stopPropagation(), copy());
  // The label goes where the token can be bought when that is set, and otherwise copies as well:
  // the address is the thing somebody needs either way.
  label.onclick = () => (token.buy ? window.open(token.buy, "_blank", "noopener,noreferrer") : copy());
  host.title = token.ca;
  mountChartLink(host, token);
}
