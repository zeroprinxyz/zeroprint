// ZeroPrint ROBINHOOD CHAIN MAINNET stack (4663). Ports 8940 (UI), 8945 (relayer), 8946 (keeper).
const fs = require("fs");
const HOME = process.env.HOME;
const ROOT = `${HOME}/shadepool`;
const NODE = `${HOME}/.nvm/versions/node/v22.23.3/bin/node`;
const readEnv = (p) =>
  Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const secrets = readEnv(`${ROOT}/shade/mainnet/secrets.env`);
const footprint = readEnv(`${ROOT}/shade/footprint.env`);
const RPC_URL = "http://127.0.0.1:8547"; // our own RH node
module.exports = {
  apps: [
    {
      name: "zeroprint-keeper",
      cwd: `${ROOT}/shade/asp`,
      script: "keeper.mjs",
      interpreter: NODE,
      env: {
        RPC_URL,
        DEPLOYMENT: `${ROOT}/packages/contracts/deployments/zeroprint-4663.json`,
        DATA_DIR: `${ROOT}/shade/asp/mainnet`,
        POLL_SEC: "20",
        PORT: "8946",
        KEEPER_PK: secrets.POSTMAN_PK,
      },
    },
    {
      name: "zeroprint-relayer",
      cwd: `${ROOT}/shade/relayer`,
      script: "start.mjs",
      interpreter: NODE,
      env: { CONFIG_PATH: `${ROOT}/shade/relayer/mainnet/config.json`, SHADE_RELAYER_PORT: "8945" },
    },
    {
      name: "zeroprint-ui",
      cwd: `${ROOT}/shade/ui`,
      script: "server.mjs",
      interpreter: NODE,
      env: {
        HOST: "127.0.0.1",
        PORT: "8940",
        RPC_URL,
        ASP_URL: "http://127.0.0.1:8946",
        RELAYER_URL: "http://127.0.0.1:8945",
        ...footprint,
        UI_CONFIG: `${ROOT}/shade/ui/mainnet.config.json`,
        TLS_CERT: `${ROOT}/shade/local/tls/cert.pem`,
        TLS_KEY: `${ROOT}/shade/local/tls/key.pem`,
      },
    },
  ],
};
