#!/bin/bash
# Deploy ShadePool to RH testnet (46630) and write the configs for the testnet stack.
# Needs DEPLOYER funded (~0.002 ETH is plenty at 0.01 gwei); it then tops up postman + relayer.
set -euo pipefail
cd "$(dirname "$0")"
source ./secrets.env
export PATH=$HOME/.foundry/bin:$PATH
RPC=https://rpc.testnet.chain.robinhood.com
ROOT=$HOME/shadepool
DEP=$ROOT/packages/contracts/deployments/shade-46630.json

[ "$(cast chain-id --rpc-url $RPC)" = 46630 ] || { echo "wrong chain"; exit 1; }
bal=$(cast balance $DEPLOYER_ADDRESS --rpc-url $RPC)
echo "deployer $DEPLOYER_ADDRESS balance $(cast from-wei $bal) ETH"
[ "$bal" -gt 0 ] || { echo "fund the deployer first"; exit 1; }

if [ ! -f "$DEP" ]; then
  start=$(cast block-number --rpc-url $RPC)
  (cd $ROOT/packages/contracts && FOUNDRY_EVM_VERSION=cancun POSTMAN_ADDRESS=$POSTMAN_ADDRESS \
    forge script script/DeployShade.s.sol:DeployShade --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast --slow)
  # the script records the simulation block; use the block before broadcast as the scan start
  jq ".startBlock=$start" $DEP > $DEP.tmp && mv $DEP.tmp $DEP
fi
cat $DEP

# gas for postman (root updates) and relayer (relays)
for who in POSTMAN RELAYER; do
  addr_var=${who}_ADDRESS
  have=$(cast balance ${!addr_var} --rpc-url $RPC)
  if [ "$have" -lt 200000000000000 ]; then
    cast send ${!addr_var} --value 0.0005ether --rpc-url $RPC --private-key $DEPLOYER_PK >/dev/null && echo "funded $who"
  fi
done

EP=$(jq -r .entrypoint $DEP)
mkdir -p ../relayer/testnet
umask 077
cat > ../relayer/testnet/config.json <<JSON
{
  "defaults": { "fee_receiver_address": "$RELAYER_ADDRESS", "signer_private_key": "$RELAYER_PK", "entrypoint_address": "$EP" },
  "chains": [{
    "chain_id": "46630", "chain_name": "robinhood-testnet", "rpc_url": "$RPC", "max_gas_price": "2000000000",
    "native_currency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
    "supported_assets": [{ "asset_address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "asset_name": "Ether", "fee_bps": "0", "min_withdraw_amount": "1000000000000000" }]
  }],
  "sqlite_db_path": "$ROOT/zeroprint/relayer/testnet/relayer.sqlite",
  "cors_allow_all": false,
  "allowed_domains": ["https://127.0.0.1:8930"]
}
JSON
umask 022
jq -n --argjson d "$(cat $DEP)" --arg dep "$DEPLOYER_ADDRESS" '{chainName:"Robinhood Chain Testnet", walletRpc:"https://rpc.testnet.chain.robinhood.com", explorer:"https://explorer.testnet.chain.robinhood.com", delaySec:1800, deployer:$dep, origin:"https://127.0.0.1:8930", deployment:$d}' > ../ui/testnet.config.json
echo "configs written; start with: pm2 start ~/shadepool/zeroprint/testnet.config.cjs"
