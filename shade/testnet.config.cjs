// ShadePool RH TESTNET stack (chain 46630). Ports 8930-8932 so it can run next to the local stack.
const fs = require("fs");
const HOME = process.env.HOME;
const ROOT = `${HOME}/shadepool`;
const NODE = `${HOME}/.nvm/versions/node/v22.23.3/bin/node`;
const secrets = Object.fromEntries(
  fs.readFileSync(`${ROOT}/shade/testnet/secrets.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
const RPC_URL = "https://rpc.testnet.chain.robinhood.com";
// Footprint keys (Etherscan, Solana RPC): shade/footprint.env, 600, not in git
const footprint = Object.fromEntries(
  fs.readFileSync(`${ROOT}/shade/footprint.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
module.exports = {
  apps: [
    {
      name: "shadepool-t-asp",
      cwd: `${ROOT}/shade/asp`,
      script: "asp.mjs",
      interpreter: NODE,
      env: {
        RPC_URL,
        DEPLOYMENT: `${ROOT}/packages/contracts/deployments/shade-46630.json`,
        DATA_DIR: `${ROOT}/shade/asp/testnet`,
        DELAY_SEC: "1800",
        POLL_SEC: "60",
        PORT: "8932",
        LOG_CHUNK: "50000",
        POSTMAN_PK: secrets.POSTMAN_PK,
      },
    },
    {
      name: "shadepool-t-relayer",
      cwd: `${ROOT}/shade/relayer`,
      script: "start.mjs",
      interpreter: NODE,
      env: { CONFIG_PATH: `${ROOT}/shade/relayer/testnet/config.json`, SHADE_RELAYER_PORT: "8931" },
    },
    {
      name: "shadepool-t-ui",
      cwd: `${ROOT}/shade/ui`,
      script: "server.mjs",
      interpreter: NODE,
      env: {
        HOST: "127.0.0.1",
        PORT: "8930",
        RPC_URL,
        ...footprint,
        UI_CONFIG: `${ROOT}/shade/ui/testnet.config.json`,
        ASP_URL: "http://127.0.0.1:8936",
        RELAYER_URL: "http://127.0.0.1:8935",
        TLS_CERT: `${ROOT}/shade/local/tls/cert.pem`,
        TLS_KEY: `${ROOT}/shade/local/tls/key.pem`,
      },
    },
    {
      // ZeroPrint keeper: queues, guards (denies blocklisted) and approves on the ZeroPrintASP contract
      name: "shadepool-t-keeper",
      cwd: `${ROOT}/shade/asp`,
      script: "keeper.mjs",
      interpreter: NODE,
      env: {
        RPC_URL,
        DEPLOYMENT: `${ROOT}/packages/contracts/deployments/zeroprint-46630.json`,
        DATA_DIR: `${ROOT}/shade/asp/testnet-zp`,
        POLL_SEC: "30",
        PORT: "8936",
        KEEPER_PK: secrets.POSTMAN_PK,
      },
    },
    {
      name: "shadepool-t-zrelayer",
      cwd: `${ROOT}/shade/relayer`,
      script: "start.mjs",
      interpreter: NODE,
      env: { CONFIG_PATH: `${ROOT}/shade/relayer/testnet-zp/config.json`, SHADE_RELAYER_PORT: "8935" },
    },
    {
      // the first testnet pool (server ASP), kept reachable so its deposits can still leave
      name: "shadepool-t-legacy-ui",
      cwd: `${ROOT}/shade/ui`,
      script: "server.mjs",
      interpreter: NODE,
      env: {
        HOST: "127.0.0.1",
        PORT: "8934",
        RPC_URL,
        ASP_URL: "http://127.0.0.1:8932",
        RELAYER_URL: "http://127.0.0.1:8931",
        ...footprint,
        UI_CONFIG: `${ROOT}/shade/ui/testnet-legacy.config.json`,
        TLS_CERT: `${ROOT}/shade/local/tls/cert.pem`,
        TLS_KEY: `${ROOT}/shade/local/tls/key.pem`,
      },
    },
  ],
};
