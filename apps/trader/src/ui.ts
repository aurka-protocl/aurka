import { AurkaError } from "@aurka/sdk";

const lifecycleLabels: Record<string, string> = {
  ACTIVE: "Ready to trade",
  DRAFT: "Draft saved",
  FAILED: "Needs attention",
  PAUSED: "Trading paused",
  PENDING: "Setup in progress",
  PRICING_NEEDS_RENEWAL: "Price update needed",
  STRATEGY_MISMATCH: "Owner repair required",
  REACTIVATION_REQUIRED: "Ready to reactivate",
};

const errorLabels: Record<string, string> = {
  ASSET_DECIMALS_MISMATCH:
    "This asset setup needs attention. Try again or choose another Space.",
  AUTHORIZATION_PENDING:
    "The wallet approval is still pending. Review the request in your wallet and try again.",
  AUTH_REQUIRED: "Connect your wallet to continue.",
  AUTH_CHALLENGE_INVALID:
    "The wallet sign-in request expired. Start sign-in again.",
  AUTH_CHALLENGE_MISMATCH:
    "The wallet account or network changed during sign-in. Connect the same Sepolia account and try again.",
  AUTH_SIGNATURE_INVALID:
    "The wallet could not verify this request. Close any older wallet prompt, reconnect, and try again.",
  AUTH_ORIGIN_INVALID:
    "This page could not be verified for wallet sign-in. Reload the app and try again.",
  AUTH_ORIGIN_NOT_ALLOWED:
    "Wallet sign-in is not available from this address. Open the app from its main link.",
  AUTH_UNAVAILABLE:
    "Wallet sign-in is temporarily unavailable. Try again shortly.",
  AUTH_ORIGIN_MISMATCH:
    "The wallet sign-in request is out of date. Start it again from this page.",
  AGENT_NOT_FOUND: "Create your trading agent before starting.",
  DELEGATED_CONFIGURATION_MISSING:
    "Agent trading is not configured on this deployment. Setup needs administrator attention.",
  AGENT_PROVISIONING_UNAVAILABLE:
    "Your private trading wallet could not be created. Try again shortly.",
  AGENT_FAUCET_UNAVAILABLE:
    "Testnet funding is temporarily unavailable. Try again shortly.",
  AGENT_FAUCET_COOLDOWN:
    "Please wait a moment before requesting another balance update.",
  AGENT_FUNDING_LIMIT: "The requested balance is above the allowed limit.",
  AGENT_FUNDING_FAILED:
    "The balance update did not finish. Refresh the wallet and try again.",
  AGENT_FUNDING_RECONCILIATION_REQUIRED:
    "A previous balance update is still finishing. Refresh and try again shortly.",
  AGENT_FUNDING_INVALID: "Enter an amount greater than zero.",
  AGENT_ACTIVE:
    "Stop the active trading wallet before changing its instructions or archiving it.",
  AGENT_FUNDS_REMAINING:
    "Move the remaining WETH and USDC back to your wallet before archiving it.",
  AGENT_BALANCE_UNAVAILABLE:
    "The trading wallet balance could not be checked. Refresh and try again.",
  AGENT_ARCHIVE_FAILED:
    "The trading wallet could not be archived. Try again shortly.",
  AGENT_RECONCILIATION_REQUIRED:
    "The last wallet action is still being checked. Refresh before trying again.",
  DELEGATED_MINIMUM_RATE: "The current rate is below the minimum you selected.",
  DELEGATED_APPROVAL_UNAVAILABLE:
    "The trading wallet could not approve this asset. Make sure it has ETH for fees, then try again.",
  DELEGATED_APPROVAL_FAILED:
    "The trading wallet could not approve this asset. Make sure it has Sepolia ETH for fees, then try again.",
  DELEGATED_AUTHORIZATION_REPLAYED:
    "That approval has already been used. Start the action again.",
  DELEGATED_CONTROL_EXPIRED:
    "That approval expired. Start the action again and approve the new request.",
  DELEGATED_CONTROL_MISMATCH:
    "The wallet approval did not match this action. Start it again and approve the new request.",
  DELEGATED_EXPIRY_INVALID:
    "The trading session settings are no longer valid. Create a new session.",
  DELEGATED_EXPIRED:
    "This trading session has expired. Review the instructions and start a new one.",
  DELEGATED_DIRECTION:
    "This trading session uses a different token direction. Start a new session for the pair shown.",
  DELEGATED_EXECUTION_FAILED:
    "The trading wallet could not submit the swap. Check its WETH approval for this Space and try again.",
  DELEGATED_EXHAUSTED:
    "This trading session reached its limit. Create a new session to continue.",
  DELEGATED_NOT_ACTIVE:
    "This trading session is not running. Open the instructions and start it.",
  DELEGATED_NOT_STOPPED:
    "Stop the trading wallet before moving its balance back to your wallet.",
  DELEGATED_POLICY_CHANGED:
    "The trading instructions changed while this session was open. Start a fresh session.",
  DELEGATED_RECONCILIATION_REQUIRED:
    "The previous swap is still being checked. Refresh before starting another one.",
  DELEGATED_REVOKE_PENDING:
    "Stopping is still being confirmed. Wait a moment, then try again.",
  DELEGATED_RECOVERY_ASSET: "Choose a WETH or USDC balance greater than zero.",
  DELEGATED_RECOVERY_DESTINATION:
    "Balances can only be returned to the wallet that created this trading wallet.",
  DELEGATED_RECOVERY_RECONCILIATION_REQUIRED:
    "The balance transfer is still being confirmed. Refresh before trying again.",
  DELEGATED_RECOVERY_REPLAYED:
    "That balance transfer was already requested. Refresh to see the result.",
  DELEGATED_SPACE_INELIGIBLE:
    "That Space cannot be used with these instructions. Choose an active Space with the displayed token pair.",
  DELEGATED_TRADE_CAP:
    "This swap is above the per-trade limit. Review the instructions and choose a larger limit.",
  DELEGATED_UNAVAILABLE:
    "The private trading wallet is temporarily unavailable. Try again shortly.",
  DELEGATED_PROVIDER_UNAVAILABLE:
    "The wallet service could not respond. Your setup is saved. Try again shortly.",
  DELEGATED_TIMEOUT:
    "The wallet service could not respond. Your setup is saved. Try again shortly.",
  DELEGATED_RATE_LIMITED:
    "The wallet service could not respond. Your setup is saved. Try again after a short delay.",
  DELEGATED_POLICY_MISMATCH: "Trading permissions need attention.",
  DELEGATED_REVOKED:
    "Trading is stopped. Start again with fresh authorization.",
  DELEGATED_WALLET_MISMATCH:
    "The trading wallet settings changed. Refresh and start a fresh session.",
  DELEGATED_OWNER_BINDING_MISSING:
    "The trading wallet is not linked to an account yet. Try again shortly.",
  DELEGATED_OWNER_UNAUTHORIZED:
    "This wallet is not linked to the trading wallet. Connect the wallet used to create it.",
  DELEGATED_SESSION_NOT_FOUND:
    "This trading session is no longer available. Create a new one.",
  CHAIN_MISMATCH:
    "Your wallet is on the wrong network. Switch to the network shown in the app and try again.",
  RPC_COOLDOWN:
    "Live network data is recovering. Trading will resume automatically shortly.",
  RPC_RATE_LIMITED:
    "Live network data is recovering. Trading will resume automatically shortly.",
  RPC_SYNCING:
    "Live network data is syncing. Trading will resume automatically shortly.",
  RPC_UNAVAILABLE:
    "Live network data is temporarily unavailable. Trading will resume automatically shortly.",
  COMMITMENT_MISMATCH:
    "The reviewed trade is out of date. Request a fresh rate before signing.",
  FORK_CONTEXT_MISMATCH:
    "This session is out of date. Reload the app before trying again.",
  FUNDING_CONFIGURATION_UNAVAILABLE:
    "Space funding is temporarily unavailable. Try again shortly.",
  SPACE_CHAIN_VERIFICATION_FAILED:
    "The starting balances do not fit the allocation range at the current reference price. Use the minimum and maximum amounts shown in the form.",
  SPACE_ALREADY_EXISTS:
    "This Space was already saved. Refresh the page to continue editing it.",
  AUTHORIZATION_MISMATCH:
    "This Space form is out of date. Refresh it and review the changes again.",
  AUTHORIZATION_EXPIRED:
    "This Space review expired. Review the details again before saving.",
  INSUFFICIENT_FUNDING:
    "The connected wallet does not have enough USDC or WETH to fund this Space. Add funds and try again.",
  INFEASIBLE_BOUNDS:
    "Those allocation limits cannot be satisfied with the selected funding.",
  INVALID_FUNDING_AMOUNT:
    "Enter positive token amounts with the precision shown in the form.",
  INVALID_SIGNATURE: "The wallet approval could not be verified. Try again.",
  OWNER_WALLET_SIGNATURE_TIMEOUT:
    "Your wallet did not answer the approval request. Finish or reject the wallet prompt, then try again.",
  INTERNAL_ERROR: "We couldn't complete that request. Try again.",
  INVALID_RESPONSE: "We received an unexpected response. Try again.",
  INVALID_REQUEST: "Review the details and try again.",
  NETWORK_ERROR:
    "We couldn't connect right now. Check your connection and try again.",
  NOT_FOUND: "That page or record is no longer available.",
  PRICING_NEEDS_RENEWAL:
    "This Space needs an updated price before trading can resume.",
  PRICING_RENEWAL_REQUIRED:
    "This Space needs an updated price before trading can resume.",
  STRATEGY_MISMATCH:
    "This Space needs owner repair before trading can resume. Create a replacement Space after recovering its funds.",
  PRICE_DATA_STALE:
    "The price is being refreshed. Wait a few seconds, then try again.",
  REQUEST_TOO_LARGE: "That request is too long. Shorten it and try again.",
  SIMULATION_FAILED:
    "The rate changed before the swap could be completed. Review the updated rate and try again.",
  SPACE_NOT_FOUND: "That Space could not be found. Choose another Space.",
  SPACE_NOT_ACTIVE:
    "This Space is not ready to trade yet. Check its current status.",
  SPACE_OWNER_MISMATCH:
    "This wallet cannot change that Space. Connect the wallet that created it.",
  SPACE_PAUSED: "Trading is paused for this Space.",
  SNAPSHOT_STALE:
    "The Space changed while this request was open. Request a fresh rate.",
  SNAPSHOT_UNAVAILABLE:
    "Live network data is syncing. Trading will resume automatically shortly.",
  TIMEOUT: "This is taking longer than expected. Refresh and try again.",
  UNSUPPORTED_ASSET: "That token is not supported by this Space.",
  UNSUPPORTED_ASSET_SET: "That token pair is not supported by this Space.",
  UNREPRESENTABLE_AMOUNT:
    "That amount cannot be quoted exactly at the current rate. Review the supported amount before continuing.",
};

export function lifecycleLabel(state: string): string {
  return lifecycleLabels[state] ?? "Needs attention";
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** Keep fixture-only prefixes out of asset names shown to end users. */
export function displayAssetSymbol(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^(?:AURKA\s+)?(?:DEMO|MOCK)\s+/i, "")
    .trim();
  return cleaned || "Token";
}

/** Keep infrastructure details out of user-facing error surfaces. */
export function userFacingError(
  error: unknown,
  fallback = "That request could not be completed. Try again.",
): string {
  if (error instanceof AurkaError) return errorLabels[error.code] ?? fallback;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return errorLabels[error.code] ?? fallback;
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return fallback;
  if (/network|fetch failed|failed to fetch/i.test(message))
    return errorLabels.NETWORK_ERROR;
  if (
    /provider account .* differs from the connected app account/i.test(message)
  )
    return "The selected wallet account changed. Reconnect the wallet and try again.";
  if (/timed out|timeout|aborted/i.test(message)) return errorLabels.TIMEOUT;
  if (/not found|does not exist/i.test(message))
    return "That record could not be found. Choose another option and try again.";
  if (/internal service error|internal error/i.test(message))
    return errorLabels.INTERNAL_ERROR;
  return fallback;
}

export function setupProgressLabel(progress: string): string {
  if (/awaiting wallet approval/i.test(progress))
    return "Approve the next request in your wallet.";
  if (/submitted|waiting for confirmation/i.test(progress))
    return "Waiting for confirmation…";
  if (/verified|complete|confirmed/i.test(progress))
    return "Your Space is ready.";
  return "Updating your Space…";
}

export function delegatedStateLabel(state: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "Active",
    AUTHORIZED: "Ready to start",
    EXHAUSTED: "Limit reached",
    EXPIRED: "Expired",
    REVOKE_PENDING: "Stopping…",
    STOPPED: "Stopped",
  };
  return labels[state] ?? "Needs attention";
}
