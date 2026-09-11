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
  CHAIN_MISMATCH:
    "Your wallet is on the wrong network. Switch to the network shown in the app and try again.",
  COMMITMENT_MISMATCH:
    "The reviewed trade is out of date. Request a fresh quote before signing.",
  FORK_CONTEXT_MISMATCH:
    "This test-network session is out of date. Reload the app before retrying.",
  FUNDING_CONFIGURATION_UNAVAILABLE:
    "Space funding is unavailable on this deployment. Ask an administrator to review the setup.",
  INFEASIBLE_BOUNDS:
    "Those portfolio limits cannot be satisfied with the selected funding.",
  INVALID_FUNDING_AMOUNT:
    "Enter positive token amounts with the precision shown in the form.",
  INVALID_SIGNATURE:
    "The wallet signature could not be verified. Review the request and try again.",
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
  const message = error instanceof Error ? error.message.trim() : "";
  if (!message) return withSupportCode(fallback);
  if (/network|fetch failed|failed to fetch/i.test(message))
    return errorLabels.NETWORK_ERROR;
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
