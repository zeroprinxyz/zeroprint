#!/bin/bash
# Deploy ZeroPrint to ROBINHOOD CHAIN MAINNET (4663) with the ZeroPrintASP contract, verify the
# result on-chain, fund the keeper (guardian) and the relayer, and write the mainnet configs.
# Broadcasts real transactions. Usage: ./deploy.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")"
source ./secrets.env
export PATH=$HOME/.foundry/bin:$PATH
RPC=${RPC:-http://127.0.0.1:8547} # our own RH node
ROOT=$HOME/shadepool
DEP=$ROOT/packages/contracts/deployments/zeroprint-4663.json
WINDOW=${ASP_WINDOW:-1800}
DRY=${1:-}

[ "$(cast chain-id --rpc-url $RPC)" = 4663 ] || { echo "not Robinhood Chain mainnet"; exit 1; }
bal=$(cast balance $DEPLOYER_ADDRESS --rpc-url $RPC)
echo "deployer $DEPLOYER_ADDRESS balance $(cast from-wei $bal) ETH; guardian/keeper $POSTMAN_ADDRESS; window ${WINDOW}s"
[ "$bal" -gt 1000000000000000 ] || { echo "deployer needs at least 0.001 ETH"; exit 1; }

cd $ROOT/packages/contracts
if [ "$DRY" = "--dry-run" ]; then
  FOUNDRY_EVM_VERSION=cancun GUARDIAN_ADDRESS=$POSTMAN_ADDRESS ASP_WINDOW=$WINDOW \
    forge script script/DeployZeroPrint.s.sol:DeployZeroPrint --rpc-url $RPC --private-key $DEPLOYER_PK
  echo "dry run only: nothing was sent"
  exit 0
fi
[ -f "$DEP" ] && { echo "$DEP exists: already deployed"; exit 1; }

start=$(cast block-number --rpc-url $RPC)
FOUNDRY_EVM_VERSION=cancun GUARDIAN_ADDRESS=$POSTMAN_ADDRESS ASP_WINDOW=$WINDOW \
  forge script script/DeployZeroPrint.s.sol:DeployZeroPrint --rpc-url $RPC --private-key $DEPLOYER_PK --broadcast --slow
jq ".startBlock=$start" $DEP > $DEP.tmp && mv $DEP.tmp $DEP
cat $DEP

# on-chain checks: the ASP is the only postman, nobody owns the Entrypoint
EP=$(jq -r .entrypoint $DEP)
ASP=$(jq -r .asp $DEP)
POOL=$(jq -r .pool $DEP)
[ "$(cast call $EP 'hasRole(bytes32,address)(bool)' $(cast keccak ASP_POSTMAN) $ASP --rpc-url $RPC)" = true ] || { echo "ASP is not postman!"; exit 1; }
[ "$(cast call $EP 'hasRole(bytes32,address)(bool)' $(cast keccak ASP_POSTMAN) $DEPLOYER_ADDRESS --rpc-url $RPC)" = false ] || { echo "deployer still postman!"; exit 1; }
[ "$(cast call $EP 'hasRole(bytes32,address)(bool)' $(cast keccak OWNER_ROLE) $DEPLOYER_ADDRESS --rpc-url $RPC)" = false ] || { echo "deployer still owner!"; exit 1; }
[ "$(cast call $ASP 'guardian()(address)' --rpc-url $RPC)" = "$POSTMAN_ADDRESS" ] || { echo "wrong guardian"; exit 1; }
echo "on-chain checks OK"

# gas for the keeper (queue/deny/approve) and the relayer (withdrawals)
cast send $POSTMAN_ADDRESS --value 0.0015ether --rpc-url $RPC --private-key $DEPLOYER_PK >/dev/null && echo "funded keeper"
cast send $RELAYER_ADDRESS --value 0.0025ether --rpc-url $RPC --private-key $DEPLOYER_PK >/dev/null && echo "funded relayer"

mkdir -p $ROOT/shade/relayer/mainnet $ROOT/shade/asp/mainnet
umask 077
cat > $ROOT/shade/relayer/mainnet/config.json <<JSON
{
  "defaults": { "fee_receiver_address": "$RELAYER_ADDRESS", "signer_private_key": "$RELAYER_PK", "entrypoint_address": "$EP" },
  "chains": [{
    "chain_id": "4663", "chain_name": "robinhood", "rpc_url": "$RPC", "max_gas_price": "2000000000",
    "native_currency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
    "supported_assets": [{ "asset_address": "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "asset_name": "Ether", "fee_bps": "0", "min_withdraw_amount": "1000000000000000" }]
  }],
  "sqlite_db_path": "$ROOT/shade/relayer/mainnet/relayer.sqlite",
  "cors_allow_all": false,
  "allowed_domains": ["https://127.0.0.1:8940", "https://zeroprint.xyz"]
}
JSON
umask 022
jq -n --argjson d "$(cat $DEP)" --arg dep "$DEPLOYER_ADDRESS" --argjson w "$WINDOW" \
  '{chainName:"Robinhood Chain", walletRpc:"https://rpc.mainnet.chain.robinhood.com", explorer:"https://robinhoodchain.blockscout.com", delaySec:$w, deployer:$dep, origin:"https://127.0.0.1:8940", networks:{mainnet:"https://127.0.0.1:8940", testnet:"https://127.0.0.1:8930"}, deployment:$d}' \
  > $ROOT/shade/ui/mainnet.config.json
echo "configs written; start with: pm2 start ~/shadepool/shade/mainnet.config.cjs"
