#!/bin/bash
# ShadePool local chain (private network only). Default anvil mnemonic: keys are PUBLIC, local testing only.
exec $HOME/.foundry/bin/anvil \
  --host 127.0.0.1 --port 8923 \
  --chain-id 31337 \
  --hardfork cancun \
  --block-base-fee-per-gas 10000000 --gas-price 10000000 --disable-min-priority-fee \
  --accounts 10 --balance 1000 \
  --state $HOME/shadepool/zeroprint/local/anvil-state.json \
  --state-interval 30
