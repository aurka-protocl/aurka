// Generated from the pinned Solidity ABI; regenerate when the contract changes.
export const riskRegistryAbi = [
  {
    type: "function",
    name: "submitRiskCertificate",
    inputs: [
      {
        name: "certificate",
        type: "tuple",
        internalType: "struct RiskModeRegistry.RiskCertificate",
        components: [
          {
            name: "policyId",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "riskMode",
            type: "uint8",
            internalType: "enum RiskModeRegistry.RiskMode",
          },
          {
            name: "activeBoundsHash",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "maximumTradeValue",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "sourceDigest",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "reasonCode",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "issuedAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "expiresAt",
            type: "uint64",
            internalType: "uint64",
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "watchtower",
            type: "address",
            internalType: "address",
          },
          {
            name: "watchtowerAuthorizationEpoch",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "policyNonce",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
      {
        name: "activeBounds",
        type: "tuple[]",
        internalType: "struct RiskModeRegistry.ActiveAssetBound[]",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
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
          {
            name: "paused",
            type: "bool",
            internalType: "bool",
          },
        ],
      },
      {
        name: "signature",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "certificateHash",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "nonpayable",
  },
] as const;
