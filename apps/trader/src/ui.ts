import { AurkaError } from "@aurka/sdk";

const lifecycleLabels: Record<string, string> = {
  ACTIVE: "Ready to trade",
  DRAFT: "Draft",
  FAILED: "Setup failed",
  PAUSED: "Trading paused",
  PENDING: "Setup pending",
  PRICING_NEEDS_RENEWAL: "Price needs renewal",
  REACTIVATION_REQUIRED: "Trading needs reactivation",
};

const errorLabels: Record<string, string> = {
  ASSET_DECIMALS_MISMATCH:
    "This token configuration is inconsistent. Ask an administrator to review the Space.",
  AUTHORIZATION_PENDING:
    "The wallet authorization is still pending. Review the wallet request and try again.",
  AUTH_REQUIRED:
    "Connect and sign in with the wallet that owns this agent before continuing.",
  AUTH_CHALLENGE_INVALID:
    "The wallet login request expired or was already used. Start the login again.",
  AUTH_CHALLENGE_MISMATCH:
    "The wallet account or network changed while signing in. Connect the same Sepolia account and try again.",
  AUTH_SIGNATURE_INVALID:
    "The login signature was not created by the connected wallet. Reject any old wallet popup, reconnect the account, and try again.",
  AUTH_ORIGIN_INVALID:
    "The login page address is invalid. Reload the app from its normal address and try again.",
  AUTH_ORIGIN_NOT_ALLOWED:
    "This app address is not allowed for wallet login. Use the configured application address.",
  AUTH_UNAVAILABLE:
    "Wallet login is not configured on this service. Ask an administrator to check the API setup.",
  AUTH_ORIGIN_MISMATCH:
    "The login request came from a different app origin. Start the wallet login again from this page.",
  AGENT_NOT_FOUND:
    "That trading agent does not belong to the connected wallet.",
  AGENT_PROVISIONING_UNAVAILABLE:
    "A per-user Privy trading wallet could not be provisioned. Try again shortly.",
  AGENT_FAUCET_UNAVAILABLE:
    "Sepolia test funding is not configured on this deployment.",
  AGENT_FAUCET_COOLDOWN:
    "Test funding is rate-limited. Wait a moment before requesting it again.",
  AGENT_FUNDING_LIMIT: "The requested test balance is above the faucet limit.",
  AGENT_FUNDING_FAILED:
    "Test funding did not finish. Check the agent status and retry the unfinished amount.",
  AGENT_FUNDING_RECONCILIATION_REQUIRED:
    "A previous test-funding operation is still settling. Retry with the same amounts after it completes.",
  AGENT_FUNDING_INVALID: "Enter a non-zero test funding amount.",
  AGENT_ACTIVE:
    "Stop and revoke the active agent before changing its mandate or archiving it.",
  AGENT_FUNDS_REMAINING:
    "Recover the agent's WETH and USDC before archiving it.",
  AGENT_BALANCE_UNAVAILABLE:
    "The agent wallet balance could not be verified. Refresh status and try archiving again.",
  AGENT_ARCHIVE_FAILED:
    "The Privy execution signer could not be revoked, so the agent was not archived.",
  AGENT_RECONCILIATION_REQUIRED:
    "The provider result is uncertain. Reconcile the agent before trying to create another wallet.",
  DELEGATED_MINIMUM_RATE:
    "The proposed trade is below the minimum output/input rate you reviewed.",
  DELEGATED_APPROVAL_UNAVAILABLE:
    "The Privy agent wallet cannot approve its token allowance on this deployment. Check the delegated policy methods and settlement router.",
  DELEGATED_APPROVAL_FAILED:
    "Privy could not approve the agent wallet's token allowance. Check that the agent wallet has Sepolia ETH for gas and retry the approval step.",
  DELEGATED_AUTHORIZATION_REPLAYED:
    "That delegated approval was already used. Start the step again to create a fresh wallet signature.",
  DELEGATED_CONTROL_EXPIRED:
    "That control approval expired. Click the action again and approve the fresh wallet signature.",
  DELEGATED_CONTROL_MISMATCH:
    "The wallet approval did not match this delegated action. Start the action again and approve the exact request.",
  DELEGATED_EXPIRY_INVALID:
    "The delegated session expiry is invalid. Create a new session with the default short lifetime.",
  DELEGATED_EXPIRED:
    "This agent session has expired. Review the mandate and approve a new session before starting it again.",
  DELEGATED_DIRECTION:
    "The agent proposal used a different token direction than this session. Create a new session for the displayed pair.",
  DELEGATED_EXECUTION_FAILED:
    "Privy could not submit the delegated trade. Confirm the agent allowance was approved, the agent wallet has Sepolia ETH, and the Space still has capacity.",
  DELEGATED_EXHAUSTED:
    "This delegated session used its complete trade budget. Create a new session to continue.",
  DELEGATED_NOT_ACTIVE:
    "This delegated session is not running. Open the wizard and start it from its current step.",
  DELEGATED_NOT_STOPPED:
    "Stop and revoke the agent before recovering its test funds.",
  DELEGATED_POLICY_CHANGED:
    "The Privy policy changed while this session was open. Reconcile it, then create a fresh session.",
  DELEGATED_RECONCILIATION_REQUIRED:
    "A previous delegated transaction is still being checked. Reconcile the session before starting another trade.",
  DELEGATED_REVOKE_PENDING:
    "Privy revocation is still pending. Wait for it to settle, then retry Stop before recovering funds.",
  DELEGATED_RECOVERY_ASSET:
    "Choose a non-zero WETH or USDC balance to recover from the agent.",
  DELEGATED_RECOVERY_DESTINATION:
    "Recovery can only send funds back to the wallet that owns this agent.",
  DELEGATED_RECOVERY_RECONCILIATION_REQUIRED:
    "A recovery transaction is still settling. Refresh the agent status before trying again.",
  DELEGATED_RECOVERY_REPLAYED:
    "That recovery request was already used. Refresh the agent status to see the result.",
  DELEGATED_SPACE_INELIGIBLE:
    "The selected Space is not eligible for this delegated session. Choose an active Space with the displayed token pair.",
  DELEGATED_TRADE_CAP:
    "The agent proposal exceeded this session's per-trade limit. Create a session with a larger reviewed limit.",
  DELEGATED_UNAVAILABLE:
    "The Privy delegated wallet is not available on this deployment. Check the server-side wallet configuration.",
  DELEGATED_WALLET_MISMATCH:
    "The configured Privy agent wallet or policy changed. Reconcile it and create a fresh session.",
  DELEGATED_OWNER_BINDING_MISSING:
    "The Privy agent has no server-trusted owner binding. Configure the delegated owner address on the service.",
  DELEGATED_OWNER_UNAUTHORIZED:
    "This connected wallet is not the owner authorized for the Privy agent.",
  DELEGATED_SESSION_NOT_FOUND:
    "This delegated session is no longer available. Create a new session.",
  CHAIN_MISMATCH:
    "Your wallet is on the wrong network. Switch to the network shown in the app and try again.",
  COMMITMENT_MISMATCH:
    "The reviewed trade is out of date. Request a fresh quote before signing.",
  FORK_CONTEXT_MISMATCH:
    "This test-network session is out of date. Reload the app before retrying.",
  FUNDING_CONFIGURATION_UNAVAILABLE:
    "Space funding is unavailable on this deployment. Ask an administrator to review the setup.",
  INSUFFICIENT_FUNDING:
    "The owner wallet does not have enough demo USDC/WETH for this Space. Claim the free Sepolia demo tokens on the Funding step, then try again.",
  INFEASIBLE_BOUNDS:
    "Those portfolio limits cannot be satisfied with the selected funding.",
  INVALID_FUNDING_AMOUNT:
    "Enter positive token amounts with the precision shown in the form.",
  INVALID_SIGNATURE:
    "The wallet signature could not be verified. Review the request and try again.",
  OWNER_WALLET_SIGNATURE_TIMEOUT:
    "Your browser wallet did not answer the signing request. Check for a hidden wallet popup, finish or reject it, and try again with the owner wallet on Sepolia.",
  INTERNAL_ERROR: "The service could not complete that request. Try again.",
  INVALID_RESPONSE: "The service returned an unexpected response. Try again.",
  INVALID_REQUEST: "Review the request details and try again.",
  NETWORK_ERROR:
    "AURKA could not reach the service. Check that it is running and try again.",
  NOT_FOUND: "That page or record is no longer available.",
  PRICING_NEEDS_RENEWAL:
    "This Space needs owner-assisted price recovery before it can trade again.",
  PRICING_RENEWAL_REQUIRED:
    "This Space needs owner-assisted price recovery before it can trade again.",
  REQUEST_TOO_LARGE: "That request is too large. Shorten it and try again.",
  SIMULATION_FAILED:
    "The reviewed trade did not pass the settlement simulation. Request a fresh quote.",
  SPACE_NOT_FOUND: "That Space could not be found. Choose another Space.",
  SPACE_NOT_ACTIVE:
    "This Space is not ready to trade. Review its current status.",
  SPACE_OWNER_MISMATCH:
    "The connected wallet is not the owner of this Space. Reconnect the owner wallet.",
  SPACE_PAUSED: "Trading is paused for this Space. Review its owner settings.",
  SNAPSHOT_STALE:
    "The Space changed while this request was open. Request a fresh quote.",
  TIMEOUT:
    "The service took too long to respond. Check the status and try again.",
  UNSUPPORTED_ASSET: "That token is not supported by this Space.",
  UNSUPPORTED_ASSET_SET: "That token pair is not supported by this Space.",
};

const GENERIC_SUPPORT_CODE = "AURKA-UNEXPECTED-ERROR";

function withSupportCode(fallback: string): string {
  return `${fallback} Support code: ${GENERIC_SUPPORT_CODE}.`;
}

export function lifecycleLabel(state: string): string {
  return lifecycleLabels[state] ?? "Needs attention";
}

export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** Keep provider and server internals out of user-facing error surfaces. */
export function userFacingError(
  error: unknown,
  fallback = "That request could not be completed. Try again.",
): string {
  if (error instanceof AurkaError)
    return errorLabels[error.code] ?? withSupportCode(fallback);
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return errorLabels[error.code] ?? withSupportCode(fallback);
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return withSupportCode(fallback);
  if (/network|fetch failed|failed to fetch/i.test(message))
    return errorLabels.NETWORK_ERROR;
  if (
    /provider account .* differs from the connected app account/i.test(message)
  )
    return "The selected browser wallet account changed. Reconnect the wallet and try again.";
  if (/timed out|timeout|aborted/i.test(message)) return errorLabels.TIMEOUT;
  if (/not found|does not exist/i.test(message))
    return "That record could not be found. Choose another option and try again.";
  if (/internal service error|internal error/i.test(message))
    return errorLabels.INTERNAL_ERROR;
  return withSupportCode(fallback);
}

export function setupProgressLabel(progress: string): string {
  if (/awaiting wallet approval/i.test(progress))
    return "Approve the next wallet request when you are ready.";
  if (/submitted|waiting for confirmation/i.test(progress))
    return "Waiting for the test network to confirm your Space.";
  if (/verified|complete|confirmed/i.test(progress))
    return "Space setup confirmed.";
  return "Updating your Space…";
}

export function delegatedStateLabel(state: string): string {
  const labels: Record<string, string> = {
    ACTIVE: "Running",
    AUTHORIZED: "Authorized",
    EXHAUSTED: "Budget exhausted",
    EXPIRED: "Expired",
    REVOKE_PENDING: "Revocation pending",
    STOPPED: "Stopped",
  };
  return labels[state] ?? "Needs attention";
}
