import { beforeAll, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

const operatorState = vi.hoisted(() => ({
  wallet: undefined as
    | {
        address: string;
        chain_type: "ethereum";
        owner_id: string;
        policy_ids: string[];
        additional_signers: {
          signer_id: string;
          override_policy_ids: string[];
        }[];
      }
    | undefined,
  executionPolicy: undefined as Record<string, unknown> | undefined,
  recoveryPolicy: undefined as Record<string, unknown> | undefined,
  signTransaction: vi.fn(),
  sendTransaction: vi.fn(),
}));

type DelegatedOperator = {
  getDelegatedExecutionPolicy(input: {
    walletId: string;
  }): Promise<Record<string, unknown>>;
  revokeDelegatedSigner(input: {
    walletId: string;
    signerId: string;
    policyId: string;
  }): Promise<void>;
  recoverDelegatedFunds(input: Record<string, unknown>): Promise<{
    transactionHash: string;
  }>;
};

vi.mock("@privy-io/node", () => ({
  PrivyClient: class {
    constructor() {
      return {
        wallets: () => ({
          get: async () => operatorState.wallet,
          update: async (_walletId: string, input: Record<string, unknown>) => {
            operatorState.wallet = {
              ...operatorState.wallet!,
              additional_signers: input.additional_signers as {
                signer_id: string;
                override_policy_ids: string[];
              }[],
            };
            return operatorState.wallet;
          },
          ethereum: () => ({
            signTransaction: operatorState.signTransaction,
            sendTransaction: operatorState.sendTransaction,
          }),
        }),
        policies: () => ({
          get: async (policyId: string) =>
            policyId === "recovery-policy"
              ? operatorState.recoveryPolicy
              : operatorState.executionPolicy,
        }),
      };
    }
  },
}));

const OWNER_ID = "owner-quorum";
const SIGNER_ID = "agent-quorum";
const EXECUTION_POLICY_ID = "execution-policy";
const RECOVERY_POLICY_ID = "recovery-policy";
const ROUTER = `0x${"11".repeat(20)}`;
const INPUT = `0x${"22".repeat(20)}`;
const OUTPUT = `0x${"33".repeat(20)}`;
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];
const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

function transactionConditions(to: string) {
  return [
    {
      field_source: "ethereum_transaction",
      field: "chain_id",
      operator: "eq",
      value: "0x7a69",
    },
    {
      field_source: "ethereum_transaction",
      field: "to",
      operator: "eq",
      value: to,
    },
    {
      field_source: "ethereum_transaction",
      field: "value",
      operator: "eq",
      value: "0x0",
    },
  ];
}

function condition(
  field: string,
  abi: readonly unknown[],
  operator: string,
  value: string,
) {
  return {
    field_source: "ethereum_calldata",
    field,
    abi,
    operator,
    value,
  };
}

function exactApprovalRule() {
  return {
    action: "ALLOW",
    method: "eth_signTransaction",
    conditions: [
      ...transactionConditions(INPUT),
      condition("function_name", APPROVE_ABI, "eq", "approve"),
      condition("approve.spender", APPROVE_ABI, "eq", ROUTER),
      condition("approve.amount", APPROVE_ABI, "lte", "100"),
    ],
  };
}

function exactRecoveryRule(token: string, owner: string) {
  return {
    action: "ALLOW",
    method: "eth_signTransaction",
    conditions: [
      ...transactionConditions(token),
      condition("function_name", TRANSFER_ABI, "eq", "transfer"),
      condition("transfer.to", TRANSFER_ABI, "eq", owner),
      condition("transfer.amount", TRANSFER_ABI, "lte", "1000"),
    ],
  };
}

describe("bundled delegated operator composition", () => {
  const account = privateKeyToAccount(`0x${"02".repeat(32)}`);
  let operator: DelegatedOperator;

  beforeAll(async () => {
    process.env.PRIVY_APP_ID = "test-app";
    process.env.PRIVY_APP_SECRET = "test-secret";
    process.env.PRIVY_DELEGATED_WALLET_ID = "wallet-1";
    process.env.PRIVY_DELEGATED_OWNER_ID = OWNER_ID;
    process.env.PRIVY_DELEGATED_SIGNER_ID = SIGNER_ID;
    process.env.PRIVY_DELEGATED_POLICY_ID = EXECUTION_POLICY_ID;
    process.env.PRIVY_DELEGATED_RECOVERY_POLICY_ID = RECOVERY_POLICY_ID;
    process.env.PRIVY_DELEGATED_CHAIN_ID = "31337";
    process.env.PRIVY_DELEGATED_ROUTER = ROUTER;
    process.env.PRIVY_DELEGATED_INPUT_TOKEN = INPUT;
    process.env.PRIVY_DELEGATED_OUTPUT_TOKEN = OUTPUT;
    process.env.PRIVY_DELEGATED_MAX_INPUT_AMOUNT = "100";
    process.env.PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT = "1000";
    process.env.PRIVY_DELEGATED_POLICY_VALID_UNTIL = "2000000000";
    process.env.PRIVY_DELEGATED_OWNER_ADDRESS = account.address;
    process.env.PRIVY_DELEGATED_SIGNER_ADDRESS = `0x${"44".repeat(20)}`;
    process.env.PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY = "owner-key";
    process.env.PRIVY_DELEGATED_BROADCAST_MODE = "sign-and-broadcast";

    operatorState.wallet = {
      address: account.address,
      chain_type: "ethereum",
      owner_id: OWNER_ID,
      policy_ids: [RECOVERY_POLICY_ID],
      additional_signers: [
        { signer_id: SIGNER_ID, override_policy_ids: [EXECUTION_POLICY_ID] },
      ],
    };
    operatorState.executionPolicy = {
      id: EXECUTION_POLICY_ID,
      chain_type: "ethereum",
      version: "1.0",
      owner_id: OWNER_ID,
      rules: [
        {
          action: "ALLOW",
          method: "eth_signTypedData_v4",
          conditions: [
            {
              field_source: "ethereum_typed_data_domain",
              field: "chainId",
              operator: "eq",
              value: "31337",
            },
            {
              field_source: "ethereum_typed_data_domain",
              field: "verifyingContract",
              operator: "eq",
              value: ROUTER,
            },
          ],
        },
        {
          action: "ALLOW",
          method: "eth_signTransaction",
          conditions: transactionConditions(ROUTER),
        },
        exactApprovalRule(),
      ],
    };
    operatorState.recoveryPolicy = {
      id: RECOVERY_POLICY_ID,
      chain_type: "ethereum",
      version: "1.0",
      owner_id: OWNER_ID,
      rules: [
        exactRecoveryRule(INPUT, account.address),
        exactRecoveryRule(OUTPUT, account.address),
      ],
    };
    operatorState.signTransaction.mockImplementation(
      async (
        _walletId: string,
        input: { params: { transaction: Record<string, string> } },
      ) => ({
        encoding: "rlp",
        signed_transaction: await account.signTransaction({
          to: input.params.transaction.to as `0x${string}`,
          data: input.params.transaction.data as `0x${string}`,
          value: BigInt(String(input.params.transaction.value)),
          nonce: Number(BigInt(String(input.params.transaction.nonce))),
          gas: BigInt(String(input.params.transaction.gas_limit)),
          gasPrice: BigInt(String(input.params.transaction.gas_price)),
          chainId: Number(BigInt(String(input.params.transaction.chain_id))),
        }),
      }),
    );
    operatorState.sendTransaction.mockResolvedValue({
      caip2: "eip155:31337",
      hash: `0x${"99".repeat(32)}`,
    });
    const operatorModuleUrl = new URL(
      "../scripts/privy-delegated-operator.mjs",
      import.meta.url,
    ).href;
    operator = (await import(
      operatorModuleUrl
    )) as unknown as DelegatedOperator;
  });

  it("reads revoked status after signer removal and recovers over the local sign-and-broadcast route", async () => {
    await expect(
      operator.getDelegatedExecutionPolicy({ walletId: "wallet-1" }),
    ).resolves.toMatchObject({
      revoked: false,
      walletAddress: account.address,
    });

    await operator.revokeDelegatedSigner({
      walletId: "wallet-1",
      signerId: SIGNER_ID,
      policyId: EXECUTION_POLICY_ID,
    });

    await expect(
      operator.getDelegatedExecutionPolicy({ walletId: "wallet-1" }),
    ).resolves.toMatchObject({ revoked: true, walletAddress: account.address });

    const rawHash = `0x${"aa".repeat(32)}`;
    const result = await operator.recoverDelegatedFunds({
      walletId: "wallet-1",
      ownerAddress: account.address,
      destination: account.address,
      assets: [{ token: INPUT, amount: "10" }],
      authorizationHash: `0x${"bb".repeat(32)}`,
      rpc: {
        request: async (method: string) => {
          if (method === "eth_chainId") return "0x7a69";
          if (method === "eth_getTransactionCount") return "0x0";
          if (method === "eth_estimateGas") return "0x5208";
          if (method === "eth_gasPrice") return "0x1";
          if (method === "eth_sendRawTransaction") return rawHash;
          throw new Error(`unexpected RPC method ${method}`);
        },
      },
    });

    expect(result).toEqual({ transactionHash: rawHash });
    expect(operatorState.signTransaction).toHaveBeenCalledOnce();
    expect(operatorState.sendTransaction).not.toHaveBeenCalled();
  });

  it("rejects a target-only approval grant during policy readback", async () => {
    operatorState.wallet!.additional_signers = [
      { signer_id: SIGNER_ID, override_policy_ids: [EXECUTION_POLICY_ID] },
    ];
    operatorState.executionPolicy!.rules = [
      ...(operatorState.executionPolicy!.rules as unknown[]).slice(0, 2),
      {
        action: "ALLOW",
        method: "eth_signTransaction",
        conditions: transactionConditions(INPUT),
      },
    ];
    await expect(
      operator.getDelegatedExecutionPolicy({ walletId: "wallet-1" }),
    ).rejects.toThrow("broad grant");
  });

  it("rejects alternate signing methods and extra signer policy attachments", async () => {
    operatorState.wallet!.additional_signers = [
      { signer_id: SIGNER_ID, override_policy_ids: [EXECUTION_POLICY_ID] },
    ];
    operatorState.executionPolicy!.rules = [
      ...(operatorState.executionPolicy!.rules as unknown[]).slice(0, 2),
      exactApprovalRule(),
      { action: "ALLOW", method: "personal_sign", conditions: [] },
    ];
    await expect(
      operator.getDelegatedExecutionPolicy({ walletId: "wallet-1" }),
    ).rejects.toThrow("unexpected ALLOW method");

    operatorState.executionPolicy!.rules = (
      operatorState.executionPolicy!.rules as unknown[]
    ).slice(0, 3);
    operatorState.wallet!.additional_signers = [
      {
        signer_id: SIGNER_ID,
        override_policy_ids: [EXECUTION_POLICY_ID, "unreviewed-policy"],
      },
    ];
    await expect(
      operator.getDelegatedExecutionPolicy({ walletId: "wallet-1" }),
    ).rejects.toThrow("policy override readback mismatch");
  });
});
