# ZeroPrint (formerly ShadePool)

Private ETH transfers on Robinhood Chain, built on the audited [0xbow Privacy Pools](https://github.com/0xbow-io/privacy-pools-core)
contracts and circuits (Apache-2.0). This folder is everything ShadePool adds; `../packages` is upstream.

**Status: experimental, local test chain only.** Design: [`docs/2026-10-20-shadepool-v1-design.md`](docs/2026-10-20-shadepool-v1-design.md).

## What is ours

| Path | What |
|---|---|
| `../packages/contracts/script/DeployShade.s.sol` | Deploy verifiers, Entrypoint, ETH pool; register the pool (vetting fee 0, relay fee cap 0.5%); **renounce OWNER_ROLE** |
| `../packages/contracts/test/shade/` | Every admin call reverts after the renounce |
| `asp/` | Association Set Provider: delay + OFAC/blocklist screening, posts roots with the postman key |
| `relayer/start.mjs` | Runs the unmodified 0xbow relayer on localhost |
| `ui/` | Web app (Vite, vanilla JS). `ui/src/core.js` = all protocol logic, proofs made in the browser |
| `e2e/e2e.mjs` | Full flow on the local chain with real proofs |
| `local/` | Local Anvil chain (`anvil.sh`), public Anvil test keys |
| `local.config.cjs` | pm2 apps for the local stack |

## Local stack (private network only)

| pm2 | Port | |
|---|---|---|
| `shadepool-anvil` | 127.0.0.1:8923 | Anvil, chain 31337, state in `local/anvil-state.json` |
| `shadepool-asp` | 127.0.0.1:8922 | ASP, 5 min delay locally |
| `shadepool-relayer` | 127.0.0.1:8921 | 0xbow relayer |
| `shadepool-ui` | 127.0.0.1:8920 | UI + proxies `/rpc` `/asp` `/relayer` |

```bash
# tests
cd packages/contracts && FOUNDRY_EVM_VERSION=cancun forge test --match-path 'test/shade/*'
cd shade/asp && node --test lib.test.mjs
cd shade/e2e && node e2e.mjs            # ~3-6 min, waits for the ASP delay

# redeploy contracts on the local chain
cd packages/contracts && FOUNDRY_EVM_VERSION=cancun POSTMAN_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  forge script script/DeployShade.s.sol:DeployShade --rpc-url http://127.0.0.1:8923 --private-key <anvil #0> --broadcast

# rebuild the UI
cd shade/ui && npm run build && pm2 restart shadepool-ui
```

Use Node 22 (`nvm use 22`); the system Node 18 is too old.

## Wallet setup for testing

Add a network in MetaMask/Rabby: RPC `http://127.0.0.1:8923`, chain id `31337`, symbol ETH.
Import one of the public Anvil test keys from `local/anvil-keys.txt` (#3 or #4; **#5 is on the local blocklist** so its deposits are denied, to test ragequit).
These keys are public. Never use them anywhere else.
