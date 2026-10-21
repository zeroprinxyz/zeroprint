#!/usr/bin/env bash
# IPFS node that serves the ZeroPrint front end to public gateways.
# Ports: 4001 swarm (the only one that needs to be reachable), 127.0.0.1:5001 API,
# 127.0.0.1:8088 local gateway. Data in /bsc-node/ipfs.
set -euo pipefail
IMG=ipfs/kubo:v0.32.1
docker rm -f zeroprint-ipfs 2>/dev/null || true
docker run -d --name zeroprint-ipfs --restart unless-stopped \
  -v /bsc-node/ipfs:/data/ipfs \
  -p 4001:4001 -p 4001:4001/udp \
  -p 127.0.0.1:5001:5001 -p 127.0.0.1:8088:8080 \
  -e IPFS_PROFILE=server \
  "$IMG"
echo "waiting for the daemon…"
for i in $(seq 1 60); do docker exec zeroprint-ipfs ipfs id >/dev/null 2>&1 && break; sleep 2; done
docker exec zeroprint-ipfs ipfs id -f "<id>\n"
