/**
 * AURKA-005 router ABI pin consumed by every service-side encoder. Solidity
 * remains the executable authority; this manifest makes selector and argument
 * ordering reviewable without allowing callers to provide arbitrary calldata.
 */
export const AURKA_ROUTER_ABI_VERSION = "AURKA-005" as const;
export const AURKA_ROUTER_EXECUTE_SELECTOR = "0xd93c3663" as const;
export const AURKA_ROUTER_EXECUTE_ARGUMENTS = [
  "Intent",
  "bytes intentSignature",
  "Proposal",
  "bytes proposalSignature",
  "AssetState[] assets",
  "CapacityEpoch epoch",
  "SettlementInput priceInput",
  "bytes directProgram",
] as const;

export type AurkaRouterAbiVersion = typeof AURKA_ROUTER_ABI_VERSION;
