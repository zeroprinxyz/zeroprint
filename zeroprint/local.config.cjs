// ShadePool LOCAL stack (Anvil chain 31337). Keys are the public Anvil test keys.
const fs = require("fs");
const HOME = process.env.HOME;
const ROOT = `${HOME}/shadepool`;
const NODE = `${HOME}/.nvm/versions/node/v22.23.3/bin/node`;
const secrets = Object.fromEntries(
  fs.readFileSync(`${ROOT}/zeroprint/local/secrets.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
const RPC_URL = "http://127.0.0.1:8923";
// Footprint keys (Etherscan, Solana RPC): zeroprint/footprint.env, 600, not in git
const footprint = Object.fromEntries(
  fs.readFileSync(`${ROOT}/zeroprint/footprint.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
);
module.exports = {
  apps: [
    {
      name: "shadepool-asp",
      cwd: `${ROOT}/zeroprint/asp`,
      script: "asp.mjs",
      interpreter: NODE,
      env: {
        RPC_URL,
        DEPLOYMENT: `${ROOT}/packages/contracts/deployments/shade-31337.json`,
        DATA_DIR: `${ROOT}/zeroprint/asp/local`,
        EXTRA_BLOCKLIST_PATH: `${ROOT}/zeroprint/asp/local/extra-blocklist.json`,
        DELAY_SEC: "300",
        POLL_SEC: "20",
        PORT: "8922",
        POSTMAN_PK: secrets.POSTMAN_PK,
      },
    },
    {
      name: "shadepool-relayer",
      cwd: `${ROOT}/zeroprint/relayer`,
      script: "start.mjs",
      interpreter: NODE,
      env: { CONFIG_PATH: `${ROOT}/zeroprint/relayer/local/config.json`, SHADE_RELAYER_PORT: "8921" },
    },
    {
      name: "shadepool-ui",
      cwd: `${ROOT}/zeroprint/ui`,
      script: "server.mjs",
      interpreter: NODE,
      env: { HOST: "127.0.0.1", PORT: "8920", RPC_URL, ...footprint,
        UI_CONFIG: `${ROOT}/zeroprint/ui/local.config.json`, TLS_CERT: `${ROOT}/zeroprint/local/tls/cert.pem`, TLS_KEY: `${ROOT}/zeroprint/local/tls/key.pem` },
    },
  ],
};
