#!/usr/bin/env bash
# Builds the IPFS copy of the site into ui/dist-ipfs and prints its CID.
# Same pages and circuits; the config reads the chain from the public Robinhood RPC and uses the
# main site only for the relayer, the ASP stats and the bridges. Without the main site the copy
# still deposits, ragequits, approves from the deposit wallet and withdraws directly.
# Open it through a subdomain gateway (https://<CID>.ipfs.dweb.link) or a local IPFS node:
# path gateways (/ipfs/<CID>/) break the absolute links.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=dist-ipfs
npx vite build --outDir "$OUT" --emptyOutDir
mkdir -p "$OUT/artifacts" && cp ../../packages/sdk/dist/node/artifacts/* "$OUT/artifacts/"
node ipfs/config.mjs mainnet.config.json > "$OUT/config.json"
# Footprint needs the main site's scanners: send visitors there.
cat > "$OUT/footprint.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Footprint · ZeroPrint</title>
<meta http-equiv="refresh" content="0; url=https://zeroprint.xyz/footprint">
<p>Footprint runs on <a href="https://zeroprint.xyz/footprint">zeroprint.xyz/footprint</a>.</p>
HTML
printf '%s\n' "/app /app.html 200" "/docs /docs.html 200" "/status /status.html 200" "/footprint /footprint.html 200" > "$OUT/_redirects"
docker run --rm -v "$PWD/$OUT:/site:ro" --entrypoint sh ipfs/kubo:v0.32.1 -c \
  'ipfs init -e >/dev/null 2>&1; ipfs add -r -Q --only-hash --cid-version=1 /site'
