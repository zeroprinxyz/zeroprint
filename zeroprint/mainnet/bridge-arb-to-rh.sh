#!/bin/bash
# Bridge 0.00096 ETH from the deployer on Arbitrum to the same address on Robinhood mainnet via Relay.
# Re-quotes, checks chain/value/target/recipient, then sends. Never prints the key.
set -euo pipefail
export PATH=$HOME/.foundry/bin:$PATH
A=0xa6a46FeAb42dEaaD2072B751c6741c752E93b7d7
ARB=https://arb1.arbitrum.io/rpc
AMOUNT=960000000000000
Q=$(mktemp)
curl -s -X POST https://api.relay.link/quote -H 'content-type: application/json' -d "{\"user\":\"$A\",\"recipient\":\"$A\",\"originChainId\":42161,\"destinationChainId\":4663,\"originCurrency\":\"0x0000000000000000000000000000000000000000\",\"destinationCurrency\":\"0x0000000000000000000000000000000000000000\",\"amount\":\"$AMOUNT\",\"tradeType\":\"EXACT_INPUT\"}" > $Q
jq -e '(.steps|length)==1 and (.steps[0].items|length)==1' $Q >/dev/null || { echo "unexpected quote shape"; exit 1; }
TO=$(jq -r .steps[0].items[0].data.to $Q); VAL=$(jq -r .steps[0].items[0].data.value $Q)
CH=$(jq -r .steps[0].items[0].data.chainId $Q); DATA=$(jq -r .steps[0].items[0].data.data $Q)
REC=$(jq -r '.details.recipient|ascii_downcase' $Q)
echo "to $TO value $VAL chain $CH receive $(jq -r .details.currencyOut.amountFormatted $Q) ETH on Robinhood"
[ "$CH" = 42161 ] && [ "$VAL" = $AMOUNT ] && [ "${TO,,}" = 0x4cd00e387622c35bddb9b4c962c136462338bc31 ] && [ "$REC" = "${A,,}" ] \
  || { echo "quote mismatch, not sending"; exit 1; }
source "$(dirname "$0")/secrets.env"
cast send $TO $DATA --value $VAL --rpc-url $ARB --private-key $DEPLOYER_PK --json | jq -r '"arb tx \(.transactionHash) status \(.status)"'
rm -f $Q
