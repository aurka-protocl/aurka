# Privy delegated trading wallets

AURKA uses [Privy](https://www.privy.io/) to create a separate EVM trading
wallet for each account. The wallet holds the funds used by automated trades;
the owner wallet remains the authority for setup, instructions, stopping, and
recovery.

Privy manages the wallet keys and authorization requests. AURKA never receives
or stores a private key. The service keeps only wallet and policy identifiers,
public addresses, mandate state, and transaction records.

## Privy resources

The integration uses these Privy resources:

| Resource | Purpose |
| --- | --- |
| Owner key quorum | Authorizes wallet administration, policy changes, signer changes, and recovery. |
| Dedicated EVM wallet | Holds ETH for fees and the Space's WETH/USDC. |
| Additional signer | Performs only the approved execution operations. |
| Execution policy | Allows the reviewed typed-data signature, input-token approval, and `executeWithSwapVM` transaction. |
| Recovery policy | Allows exact WETH and USDC transfers to the authenticated owner address after trading stops. |

The additional signer does not own the wallet. It has an override to the
execution policy and cannot change the wallet, destination, token pair, limits,
or expiry.

## Per-user provisioning

The `/agent` flow is backed by `TradingAgentService`:

1. The owner connects and authenticates the account.
2. The service creates an owner-specific recovery policy if one is not already
   recorded.
3. The service creates an owner-specific Privy wallet with the recovery policy
   attached and the reviewed signer attached with the execution-policy
   override.
4. The service reads the wallet and both policies back from Privy.
5. It rejects the setup if the owner, signer, chain, router, token, method, or
   policy rules do not match the reviewed configuration.
6. The service stores the resulting wallet address and IDs and the owner funds
   the wallet.

Provisioning is idempotent. A provider timeout or process restart reuses the
same operation and idempotency key instead of creating a second wallet.

## What can be signed

The current execution policy contains only these operations:

```text
eth_signTypedData_v4  reviewed AURKA intent
eth_signTransaction   exact input-token approval
eth_signTransaction   exact executeWithSwapVM settlement
```

The worker builds the transaction from the reviewed proposal. Before asking
Privy to sign, it verifies the account mandate, Space, direction, per-trade
amount, remaining budget, trade count, expiry, wallet balance, allowance,
nonce, chain, router, and calldata. The onchain AURKA contracts perform the
final policy, price, capacity, and accounting checks.

## Wallet lifecycle

1. Create the trading wallet and select a Space and limits.
2. Fund the wallet with Sepolia ETH, WETH, and USDC.
3. Approve the reviewed instructions. The approval and later settlement are
   limited by the Privy policy.
4. The worker evaluates the Space and submits only a matching trade.
5. Stop trading to disable new checks and revoke the additional signer.
6. Recover remaining WETH and USDC to the owner address using the recovery
   policy.

The recovery path is owner-authorized and destination-bound. It is blocked
while a submitted or ambiguous transaction still needs reconciliation.

## Configuration and checks

Privy values are server-only. The required configuration includes:

```text
PRIVY_APP_ID
PRIVY_APP_SECRET
PRIVY_DELEGATED_OWNER_ID
PRIVY_DELEGATED_SIGNER_ID
PRIVY_DELEGATED_POLICY_ID
PRIVY_DELEGATED_RECOVERY_POLICY_ID
PRIVY_DELEGATED_ROUTER
PRIVY_DELEGATED_INPUT_TOKEN
PRIVY_DELEGATED_OUTPUT_TOKEN
PRIVY_DELEGATED_CHAIN_ID
```

Authorization key material and amount/expiry limits are also required by the
server, but must never be placed in Vite variables or committed files.

Run the read-only resource check from the repository root:

```bash
pnpm privy:delegated
```

It verifies the configured key quorums, wallet ownership, signer attachment,
execution policy, and recovery policy without creating or changing a Privy
resource. Wallet provisioning belongs to the application flow and is not a
contract deployment step.

## Contract changes and Privy changes

Privy resources are not redeployed when AURKA contracts are redeployed. A new
router or token deployment must be reflected in a new reviewed execution
policy, because the old policy is bound to the previous router and token
addresses.

The safe order is:

1. Deploy and verify the new AURKA contracts.
2. Update the server-side router and token configuration.
3. Create or update the reviewed Privy execution policy using owner authority.
4. Run `pnpm privy:delegated` and confirm the policy readback.
5. Provision a new per-user agent wallet or reconcile the existing wallet
   against the new policy.
6. Fund the wallet and perform one bounded Sepolia transaction.

Do not point an existing policy at a new router by changing only the local
environment. The provider policy and the AURKA mandate must describe the same
deployment.

## Demonstrating the integration

A valid demonstration shows one complete financial flow:

1. The Agent page displays the dedicated Privy wallet address and approved
   limits.
2. The worker submits a WETH-to-USDC trade within those limits.
3. The activity view shows `TRADE CONFIRMED` and the input/output amounts.
4. The Sepolia receipt shows the transaction's `From` address equal to the
   Privy trading wallet and the `To` address equal to the AURKA router.
5. The source repository and this page explain the wallet and policy boundary.

The transaction receipt is the evidence of execution. A policy screenshot or
configuration file alone does not prove that a Privy-controlled transaction
completed.
