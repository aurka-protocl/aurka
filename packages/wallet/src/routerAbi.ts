// Generated from the pinned Solidity ABI; regenerate when the contract changes.
const executeAbi = {
  type: "function",
  name: "execute",
  inputs: [
    {
      name: "intent",
      type: "tuple",
      internalType: "struct AurkaSwapVMRouter.Intent",
      components: [
        {
          name: "intentId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "policyId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "positionIdHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "trader",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderInputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderOutputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "requestedValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "minimumTraderOutputValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "exactInput",
          type: "bool",
          internalType: "bool",
        },
        {
          name: "allowPartialFill",
          type: "bool",
          internalType: "bool",
        },
        {
          name: "deadline",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "nonce",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "balanceSnapshot",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "priceSnapshot",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "aquaStrategyHash",
          type: "bytes32",
          internalType: "bytes32",
        },
      ],
    },
    {
      name: "intentSignature",
      type: "bytes",
      internalType: "bytes",
    },
    {
      name: "proposal",
      type: "tuple",
      internalType: "struct AurkaSwapVMRouter.Proposal",
      components: [
        {
          name: "intentHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "solver",
          type: "address",
          internalType: "address",
        },
        {
          name: "balancesHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "priceSnapshotHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "policyNonce",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "riskCertificateHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "traderInputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderOutputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderInputAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "traderOutputAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "solverFeeAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "protocolFeeAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "traderInputValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "traderOutputValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "treasuryOutputValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "feeBpsScaled",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "baseFeeAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "treasuryBaseFeeAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "optionSpacePremiumAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "totalFeeAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "treasuryAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "solverAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "protocolAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "feeToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "feePaymentMode",
          type: "uint8",
          internalType: "uint8",
        },
        {
          name: "initialPortfolioHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "capacityBaselineValue",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "consumedBefore",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "consumedAfter",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "capacityEpochId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "utilizationBefore",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "utilizationAfter",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "bindingConstraint",
          type: "uint8",
          internalType: "uint8",
        },
        {
          name: "bindingAsset",
          type: "address",
          internalType: "address",
        },
        {
          name: "expectedPostStateHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "aquaStrategyHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "swapVMCalldataHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "deadline",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      name: "proposalSignature",
      type: "bytes",
      internalType: "bytes",
    },
    {
      name: "assets",
      type: "tuple[]",
      internalType: "struct PortfolioBounds.AssetState[]",
      components: [
        {
          name: "token",
          type: "address",
          internalType: "address",
        },
        {
          name: "value",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "minimumWeightBps",
          type: "uint16",
          internalType: "uint16",
        },
        {
          name: "maximumWeightBps",
          type: "uint16",
          internalType: "uint16",
        },
      ],
    },
    {
      name: "epoch",
      type: "tuple",
      internalType: "struct DirectSettlement.CapacityEpoch",
      components: [
        {
          name: "positionIdHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "traderInputTokenId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "traderOutputTokenId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "balanceSnapshot",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "priceSnapshot",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "portfolioPriceSnapshot",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "policyNonce",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "riskCertificateHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "aquaStrategyHash",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "capacityBaseline",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "consumedBefore",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "chainId",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "verifyingContract",
          type: "address",
          internalType: "address",
        },
        {
          name: "capacityEpochId",
          type: "bytes32",
          internalType: "bytes32",
        },
      ],
    },
    {
      name: "priceInput",
      type: "tuple",
      internalType: "struct PriceProtection.SettlementInput",
      components: [
        {
          name: "traderInputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderOutputToken",
          type: "address",
          internalType: "address",
        },
        {
          name: "traderInputReferencePrice",
          type: "tuple",
          internalType: "struct PriceProtection.Snapshot",
          components: [
            {
              name: "token",
              type: "address",
              internalType: "address",
            },
            {
              name: "snapshotId",
              type: "bytes32",
              internalType: "bytes32",
            },
            {
              name: "price",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "priceDecimals",
              type: "uint8",
              internalType: "uint8",
            },
            {
              name: "observedAt",
              type: "uint64",
              internalType: "uint64",
            },
          ],
        },
        {
          name: "traderInputExecutionPrice",
          type: "tuple",
          internalType: "struct PriceProtection.Snapshot",
          components: [
            {
              name: "token",
              type: "address",
              internalType: "address",
            },
            {
              name: "snapshotId",
              type: "bytes32",
              internalType: "bytes32",
            },
            {
              name: "price",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "priceDecimals",
              type: "uint8",
              internalType: "uint8",
            },
            {
              name: "observedAt",
              type: "uint64",
              internalType: "uint64",
            },
          ],
        },
        {
          name: "traderOutputReferencePrice",
          type: "tuple",
          internalType: "struct PriceProtection.Snapshot",
          components: [
            {
              name: "token",
              type: "address",
              internalType: "address",
            },
            {
              name: "snapshotId",
              type: "bytes32",
              internalType: "bytes32",
            },
            {
              name: "price",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "priceDecimals",
              type: "uint8",
              internalType: "uint8",
            },
            {
              name: "observedAt",
              type: "uint64",
              internalType: "uint64",
            },
          ],
        },
        {
          name: "traderOutputExecutionPrice",
          type: "tuple",
          internalType: "struct PriceProtection.Snapshot",
          components: [
            {
              name: "token",
              type: "address",
              internalType: "address",
            },
            {
              name: "snapshotId",
              type: "bytes32",
              internalType: "bytes32",
            },
            {
              name: "price",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "priceDecimals",
              type: "uint8",
              internalType: "uint8",
            },
            {
              name: "observedAt",
              type: "uint64",
              internalType: "uint64",
            },
          ],
        },
        {
          name: "approvedTraderInputSnapshotId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "approvedTraderOutputSnapshotId",
          type: "bytes32",
          internalType: "bytes32",
        },
        {
          name: "traderInputAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "traderOutputAmount",
          type: "uint256",
          internalType: "uint256",
        },
        {
          name: "traderInputDecimals",
          type: "uint8",
          internalType: "uint8",
        },
        {
          name: "traderOutputDecimals",
          type: "uint8",
          internalType: "uint8",
        },
        {
          name: "valueDecimals",
          type: "uint8",
          internalType: "uint8",
        },
        {
          name: "currentTime",
          type: "uint64",
          internalType: "uint64",
        },
        {
          name: "maximumPriceAgeSeconds",
          type: "uint64",
          internalType: "uint64",
        },
        {
          name: "maximumPriceDeviationBps",
          type: "uint256",
          internalType: "uint256",
        },
      ],
    },
    {
      name: "directProgram",
      type: "bytes",
      internalType: "bytes",
    },
  ],
  outputs: [
    {
      name: "intentHash",
      type: "bytes32",
      internalType: "bytes32",
    },
    {
      name: "proposalHash",
      type: "bytes32",
      internalType: "bytes32",
    },
    {
      name: "executedValue",
      type: "uint256",
      internalType: "uint256",
    },
  ],
  stateMutability: "nonpayable",
} as const;

/** The final TASK99-013 router keeps the signed AURKA prefix and appends the
 * pinned upstream SwapVM order/taker fields. Keep both entry points explicit;
 * callers must select the one committed by their deployment manifest. */
const executeWithSwapVMAbi = {
  ...executeAbi,
  name: "executeWithSwapVM",
  inputs: [
    ...executeAbi.inputs,
    { name: "makerTraits", type: "uint256" },
    { name: "orderData", type: "bytes" },
    { name: "takerTraitsAndData", type: "bytes" },
  ],
} as const;

export const routerAbi = [executeAbi, executeWithSwapVMAbi] as const;
