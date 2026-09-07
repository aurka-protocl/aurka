import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import type { Eip1193Transport } from "./solver/rpc.js";
import type { RegistryRiskReader } from "./risk-service.js";
const riskAbi = parseAbi([
  "function currentRiskMode(bytes32 policyId) view returns (uint8)",
  "function effectiveMaximumTradeValue(bytes32 policyId) view returns (uint256)",
  "function effectiveAssetBound(bytes32 policyId,address token) view returns ((address token,uint16 minimumWeightBps,uint16 maximumWeightBps,bool paused))",
]);
const policyAbi = parseAbi([
  "function assets(bytes32 policyId) view returns (address[])",
]);
/** Read all effective limits at one finalized block; fail closed on stale RPC state. */
export function createRegistryRiskReader(options: {
  rpc: Eip1193Transport;
  chainId: number;
  registry: Hex;
  policyRegistry: Hex;
  maximumAgeSeconds: number;
  now?: () => number;
}): RegistryRiskReader {
  return async (_positionId, policyId) => {
    const unavailable = {
      source: "UNAVAILABLE" as const,
      mode: null,
      maximumTradeValue: null,
      activeBounds: [],
      observedAt: null,
    };
    try {
      const chain = await options.rpc.request({
        method: "eth_chainId",
        params: [],
      });
      if (
        typeof chain !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(chain) ||
        BigInt(chain) !== BigInt(options.chainId)
      )
        return unavailable;
      const raw = await options.rpc.request({
        method: "eth_getBlockByNumber",
        params: ["finalized", false],
      });
      if (!raw || typeof raw !== "object") return unavailable;
      const block = raw as {
        number?: unknown;
        hash?: unknown;
        timestamp?: unknown;
      };
      if (
        typeof block.number !== "string" ||
        typeof block.hash !== "string" ||
        typeof block.timestamp !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(block.timestamp)
      )
        return unavailable;
      const timestamp = Number(BigInt(block.timestamp)),
        now = options.now?.() ?? Math.floor(Date.now() / 1000);
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp > now ||
        now - timestamp > options.maximumAgeSeconds
      )
        return unavailable;
      const call = async (to: Hex, data: Hex) => {
        const result = await options.rpc.request({
          method: "eth_call",
          params: [
            { to, data },
            { blockHash: block.hash, requireCanonical: true },
          ],
        });
        if (typeof result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(result))
          throw new Error("Malformed registry result");
        return result as Hex;
      };
      const id = policyId as Hex;
      const assets = decodeFunctionResult({
        abi: policyAbi,
        functionName: "assets",
        data: await call(
          options.policyRegistry,
          encodeFunctionData({
            abi: policyAbi,
            functionName: "assets",
            args: [id],
          }),
        ),
      });
      const mode = decodeFunctionResult({
        abi: riskAbi,
        functionName: "currentRiskMode",
        data: await call(
          options.registry,
          encodeFunctionData({
            abi: riskAbi,
            functionName: "currentRiskMode",
            args: [id],
          }),
        ),
      });
      const cap = decodeFunctionResult({
        abi: riskAbi,
        functionName: "effectiveMaximumTradeValue",
        data: await call(
          options.registry,
          encodeFunctionData({
            abi: riskAbi,
            functionName: "effectiveMaximumTradeValue",
            args: [id],
          }),
        ),
      });
      const bounds = [];
      for (const token of assets)
        bounds.push(
          decodeFunctionResult({
            abi: riskAbi,
            functionName: "effectiveAssetBound",
            data: await call(
              options.registry,
              encodeFunctionData({
                abi: riskAbi,
                functionName: "effectiveAssetBound",
                args: [id, token],
              }),
            ),
          }),
        );
      const modes = ["NORMAL", "CAUTIOUS", "SHOCK", "PAUSED"] as const;
      if (!modes[mode]) return unavailable;
      return {
        source: "REGISTRY",
        mode: modes[mode],
        maximumTradeValue: cap.toString(),
        activeBounds: bounds,
        observedAt: timestamp,
      };
    } catch {
      return unavailable;
    }
  };
}
