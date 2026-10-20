import "./style.css";
import "./landing.css";
import { startShade } from "./bgfx.js";
import { cipher, crowd, merkle, runScene } from "./scenes.js";
import { createPublicClient, formatEther, http, keccak256, toHex } from "viem";

const $ = (s) => document.querySelector(s);
// Each section has its own background that scrolls with it
// vault framing the hero copy; hover the ring to stop it, click to reverse, drag to turn it
startShade($("#fx-hero"), { poolY: 0.5, poolR: 0.36, darkCore: true, scanline: false, interactive: document.querySelector(".l-hero") });
runScene($("#fx-crowd"), crowd());
runScene($("#fx-merkle"), merkle());
runScene($("#fx-cipher"), cipher());

// Launch App: wipe the page, then go
document.querySelectorAll('a[href^="/app"]').forEach((a) =>
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    e.preventDefault();
    $("#wipe").classList.add("on");
    setTimeout(() => (location.href = a.getAttribute("href")), 480);
  }),
);
// coming back with the browser's back button: undo the wipe
addEventListener("pageshow", () => $("#wipe").classList.remove("on"));
const cfg = await fetch("/config.json", { cache: "no-store" }).then((r) => r.json());
const pub = createPublicClient({ transport: http(`${location.origin}/rpc`) });
$("#net").textContent = cfg.chainName;
// on mainnet, offer the free testnet next to the badge; on the testnet, the way back
if (cfg.networks?.testnet && !cfg.chainName.includes("Testnet"))
  $("#net").insertAdjacentHTML("afterend", ` <a class="trylink" href="${cfg.networks.testnet}/app" target="_blank" rel="noopener">Try it free on testnet →</a>`);
else if (cfg.networks?.mainnet && cfg.chainName.includes("Testnet"))
  $("#net").insertAdjacentHTML("afterend", ` <a class="trylink" href="${cfg.networks.mainnet}/">Test ETH only · go to mainnet →</a>`);

async function stats() {
  try {
    const [st, bal] = await Promise.all([
      fetch("/asp/stats", { cache: "no-store" }).then((r) => r.json()),
      pub.getBalance({ address: cfg.deployment.pool }),
    ]);
    $("#st-set").textContent = st.approved;
    $("#st-pool").textContent = Number(formatEther(bal)).toLocaleString("en-US", { maximumFractionDigits: 3 });
  } catch {}
  try {
    const owner = await pub.readContract({
      address: cfg.deployment.entrypoint,
      abi: [{ type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }],
      functionName: "hasRole",
      args: [keccak256(toHex("OWNER_ROLE")), cfg.deployer],
    });
    $("#st-admin").textContent = owner ? "1" : "0";
  } catch {}
}
stats();
setInterval(stats, 30_000);
