<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/zeroprint-logo-dark.png">
    <img src="brand/zeroprint-logo-light.png" alt="ZeroPrint" width="360">
  </picture>
</p>

<p align="center"><b>Know your footprint. Leave zero.</b></p>

Private ETH withdrawals on Robinhood Chain. Deposit from any wallet, withdraw to a fresh one
later: a zero-knowledge proof shows the money is yours without revealing which deposit it came from.

**App:** https://zeroprint.xyz · **Testnet:** https://testnet.zeroprint.xyz

## How it works

- **Pool.** The audited 0xbow Privacy Pools contracts and circuits, unchanged.
- **AutoASP.** `ZeroPrintASP` is the only party that can publish the approved-deposit set. Anyone
  queues a deposit; a guardian can deny it during a 30-minute window (sanctions/blocklist checks);
  after the window anyone can approve it. If the keeper is offline, users approve their own deposit.
- **Relayer.** Submits the withdrawal so the fresh wallet needs no gas. Fee: 0.
- **Footprint.** Shows what is already public about a wallet's money trail, before you deposit and
  after you withdraw.
- **Ragequit.** A deposit can always leave publicly back to the wallet that made it.

## Robinhood Chain mainnet (4663)

| Contract | Address |
|---|---|
| Entrypoint (proxy) | `0xc4F56c7141A1E434046f12a373d864deD34196a7` |
| ETH pool | `0xeD680b003F98581b6345D76bc309CB70584aC230` |
| ZeroPrintASP | `0x696559CF37C88554b95b0794a11E6746E5374039` |

Verified on Sourcify. Minimum deposit 0.001 ETH, maximum relay fee 0.5 %, ASP window 30 minutes,
vetting fee 0, Entrypoint owner role renounced. Full deployment: `packages/contracts/deployments/`.

## CLI

Everything the app does, from a terminal. Proofs are made locally; no ZeroPrint server is needed
except the relayer for private withdrawals.

```bash
git clone https://github.com/zeroprinxyz/zeroprint && cd zeroprint
yarn install --ignore-scripts
yarn workspace @0xbow/privacy-pools-core-sdk build
node shade/cli/zeroprint.mjs status
```

```
zeroprint status                         list your deposits (asks for your Zero Key)
zeroprint approve                        queue/approve your deposits yourself
zeroprint withdraw <eth> --to <0x…>      private withdraw through a relayer
zeroprint withdraw <eth> --direct        no relayer: your wallet pays the gas
zeroprint ragequit [--deposit N]         public exit back to the depositing wallet
options: --network mainnet|testnet, --rpc <url>, --relayer <url>
```

## Repository

- `packages/` upstream Privacy Pools monorepo: contracts (plus `src/zeroprint/ZeroPrintASP.sol`),
  circuits, SDK, relayer.
- `shade/` ZeroPrint: web app and server (`ui/`), CLI (`cli/`), ASP keeper (`asp/`), relayer
  launcher, deploy scripts, end-to-end tests.
- `brand/` logo files.

## Status

Experimental. The upstream contracts and circuits are audited (`audit/`); `ZeroPrintASP` and the
ZeroPrint app are not. Do not deposit more than you can afford to lose.

## License

Apache-2.0. Built on [0xbow Privacy Pools](https://github.com/0xbow-io/privacy-pools-core); see
`NOTICE` and `PRIVACY-POOLS.md`.
