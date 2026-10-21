#!/usr/bin/env bash
# Adds ui/dist-ipfs to the node, pins it and republishes IPNS, then prints the CID and links.
# Build it first with ui/ipfs/build.sh.
set -euo pipefail
D="$(cd "$(dirname "$0")/../ui/dist-ipfs" && pwd)"
docker run --rm -v "$D:/site:ro" -v /bsc-node/ipfs:/data/ipfs --entrypoint sh ipfs/kubo:v0.32.1 -c \
  "ipfs add -r -Q --cid-version=1 --pin=true /site" > /tmp/zp-cid.txt 2>/dev/null || {
    # the daemon holds the repo lock: add through its API instead
    docker cp "$D" zeroprint-ipfs:/tmp/site
    docker exec zeroprint-ipfs sh -c "ipfs add -r -Q --cid-version=1 --pin=true /tmp/site; rm -rf /tmp/site" | tail -1 > /tmp/zp-cid.txt
  }
CID=$(tail -1 /tmp/zp-cid.txt | tr -d "\r\n")
docker exec zeroprint-ipfs ipfs pin add "$CID" >/dev/null
KEY=$(docker exec zeroprint-ipfs ipfs name publish --key=self --quieter "/ipfs/$CID" | tr -d "\r\n")
echo "CID  $CID"
echo "IPNS $KEY"
echo "gateway https://$CID.ipfs.dweb.link/"
echo "ipns     https://$KEY.ipns.dweb.link/"
