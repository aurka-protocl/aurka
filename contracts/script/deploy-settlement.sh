#!/usr/bin/env bash
set -euo pipefail

# Simulation-first deployment helper. Set DRY_RUN=1 (the default) to print the
# command; set DRY_RUN=0 only when an operator has explicitly supplied a local
# or testnet RPC and a deployer key.
: "${AURKA_POLICY_REGISTRY:?Set AURKA_POLICY_REGISTRY}"
: "${AURKA_RISK_REGISTRY:?Set AURKA_RISK_REGISTRY}"
: "${AURKA_AQUA_ADDRESS:?Set AURKA_AQUA_ADDRESS}"
: "${AURKA_SWAPVM_ADDRESS:?Set AURKA_SWAPVM_ADDRESS}"
: "${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY}"
: "${RPC_URL:?Set RPC_URL to a local or explicitly approved testnet endpoint}"

command=(
  forge create contracts/src/AurkaSwapVMRouter.sol:AurkaSwapVMRouter
  --rpc-url "$RPC_URL"
  --private-key "$DEPLOYER_PRIVATE_KEY"
  --constructor-args "$AURKA_POLICY_REGISTRY" "$AURKA_RISK_REGISTRY" "$AURKA_AQUA_ADDRESS" "$AURKA_SWAPVM_ADDRESS"
)

if [[ "${DRY_RUN:-1}" != "0" ]]; then
  printf 'DRY RUN:'
  printf ' %q' "${command[@]}"
  printf '\n'
  exit 0
fi

"${command[@]}"
