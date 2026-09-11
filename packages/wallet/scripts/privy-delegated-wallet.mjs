/*
 * Idempotent operator command for the dedicated AURKA demo wallet.
 *
 * `check` is read-only. `provision` is the only mode allowed to create a
 * wallet, and it still requires PRIVY_DELEGATED_PROVISION=true. The script
 * never prints app secrets, authorization contexts, private keys, or policy
 * bodies.
 */
import process from "node:process";

import { verifyAuthorizationKeyQuorums } from "./privy-delegated-key-quorums.mjs";

const erc20ApproveAbi = [
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

const erc20TransferAbi = [
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

const required = [
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_DELEGATED_OWNER_ID",
  "PRIVY_DELEGATED_SIGNER_ID",
  "PRIVY_DELEGATED_POLICY_ID",
  "PRIVY_DELEGATED_RECOVERY_POLICY_ID",
  "PRIVY_DELEGATED_ROUTER",
  "PRIVY_DELEGATED_INPUT_TOKEN",
  "PRIVY_DELEGATED_OUTPUT_TOKEN",
  "PRIVY_DELEGATED_MAX_INPUT_AMOUNT",
  "PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT",
  "PRIVY_DELEGATED_POLICY_VALID_UNTIL",
  "PRIVY_DELEGATED_OWNER_ADDRESS",
  "PRIVY_DELEGATED_SIGNER_ADDRESS",
];

const authorizationRequired = [
  "PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY",
  "PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY",
];

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function fail(message) {
  process.stderr.write(`Privy delegated wallet: ${message}\n`);
  process.exitCode = 2;
}

function summary(wallet, policy, recoveryPolicy) {
  const signer = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers.find(
        (item) => item?.signer_id === value("PRIVY_DELEGATED_SIGNER_ID"),
      )
    : undefined;
  return {
    wallet: {
      id: wallet.id,
      address: wallet.address,
      chain_type: wallet.chain_type,
      owner_id: wallet.owner_id,
      policy_ids: wallet.policy_ids,
      delegated_signer_id: signer?.signer_id ?? null,
      delegated_override_policy_ids: signer?.override_policy_ids ?? [],
    },
    policy: {
      id: policy.id,
      name: policy.name,
      chain_type: policy.chain_type,
      version: policy.version,
      rule_count: Array.isArray(policy.rules) ? policy.rules.length : 0,
      rule_methods: Array.isArray(policy.rules)
        ? policy.rules.map((rule) => ({
            name: rule.name,
            action: rule.action,
            method: rule.method,
          }))
        : [],
    },
    recovery_policy: {
      id: recoveryPolicy.id,
      name: recoveryPolicy.name,
      chain_type: recoveryPolicy.chain_type,
      version: recoveryPolicy.version,
      rule_count: Array.isArray(recoveryPolicy.rules)
        ? recoveryPolicy.rules.length
        : 0,
      rule_methods: Array.isArray(recoveryPolicy.rules)
        ? recoveryPolicy.rules.map((rule) => ({
            name: rule.name,
            action: rule.action,
            method: rule.method,
          }))
        : [],
    },
  };
}

function condition(rule, fieldSource, field, operator, expected) {
  return (
    Array.isArray(rule?.conditions) &&
    rule.conditions.some(
      (item) =>
        item?.field_source === fieldSource &&
        item?.field === field &&
        item?.operator === operator &&
        (Array.isArray(item.value) ? item.value : [item.value]).some(
          (candidate) =>
            String(candidate).toLowerCase() === String(expected).toLowerCase(),
        ),
    )
  );
}

function abiFunction(item, abi, functionName) {
  if (!Array.isArray(item?.abi) || item.abi.length !== 1) return false;
  const expected = abi[0];
  const actual = item.abi[0];
  return (
    actual?.type === "function" &&
    actual?.name === functionName &&
    Array.isArray(actual.inputs) &&
    actual.inputs.length === expected.inputs.length &&
    actual.inputs.every(
      (input, index) =>
        input?.name === expected.inputs[index].name &&
        input?.type === expected.inputs[index].type,
    ) &&
    actual.stateMutability === expected.stateMutability
  );
}

function calldataCondition(rule, field, operator, expected, abi, functionName) {
  return (
    condition(rule, "ethereum_calldata", field, operator, expected) &&
    Array.isArray(rule?.conditions) &&
    rule.conditions.some(
      (item) =>
        item?.field_source === "ethereum_calldata" &&
        item?.field === field &&
        item?.operator === operator &&
        abiFunction(item, abi, functionName),
    )
  );
}

function exactIds(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((id) => !actual.includes(id))
  )
    throw new Error(`${label} contains an unexpected attachment`);
}

function assertOnlyAllowMethods(rules, allowed, label) {
  if (
    rules.some((rule) => rule?.action === "ALLOW" && !allowed.has(rule.method))
  )
    throw new Error(`${label} contains an unexpected ALLOW method`);
}

function transactionRule(rule, method, to) {
  const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
  return (
    rule?.action === "ALLOW" &&
    rule?.method === method &&
    condition(
      rule,
      "ethereum_transaction",
      "chain_id",
      "eq",
      `0x${chainId.toString(16)}`,
    ) &&
    condition(rule, "ethereum_transaction", "to", "eq", to) &&
    condition(rule, "ethereum_transaction", "value", "eq", "0x0")
  );
}

function routerMethod() {
  const configured =
    value("PRIVY_DELEGATED_ROUTER_METHOD") ?? "executeWithSwapVM";
  if (configured !== "execute" && configured !== "executeWithSwapVM")
    throw new Error(
      "PRIVY_DELEGATED_ROUTER_METHOD must be execute or executeWithSwapVM",
    );
  return configured;
}

function routerExecutionAbi() {
  return [
    {
      type: "function",
      name: routerMethod(),
      stateMutability: "nonpayable",
      inputs: [
        { name: "intent", type: "tuple" },
        { name: "intentSignature", type: "bytes" },
        { name: "proposal", type: "tuple" },
        { name: "proposalSignature", type: "bytes" },
        { name: "assets", type: "tuple[]" },
        { name: "epoch", type: "tuple" },
        { name: "priceInput", type: "tuple" },
        { name: "directProgram", type: "bytes" },
        ...(routerMethod() === "executeWithSwapVM"
          ? [
              { name: "makerTraits", type: "uint256" },
              { name: "orderData", type: "bytes" },
              { name: "takerTraitsAndData", type: "bytes" },
            ]
          : []),
      ],
    },
  ];
}

function exactRouterRule(rule, method) {
  return (
    transactionRule(rule, method, value("PRIVY_DELEGATED_ROUTER")) &&
    calldataCondition(
      rule,
      "function_name",
      "eq",
      routerMethod(),
      routerExecutionAbi(),
      routerMethod(),
    )
  );
}

function exactApprovalRule(rule, method) {
  const router = value("PRIVY_DELEGATED_ROUTER");
  const maximum = value("PRIVY_DELEGATED_MAX_INPUT_AMOUNT");
  const inputToken = value("PRIVY_DELEGATED_INPUT_TOKEN");
  return (
    router &&
    maximum &&
    inputToken &&
    transactionRule(rule, method, inputToken) &&
    calldataCondition(
      rule,
      "function_name",
      "eq",
      "approve",
      erc20ApproveAbi,
      "approve",
    ) &&
    calldataCondition(
      rule,
      "approve.spender",
      "eq",
      router,
      erc20ApproveAbi,
      "approve",
    ) &&
    calldataCondition(
      rule,
      "approve.amount",
      "lte",
      maximum,
      erc20ApproveAbi,
      "approve",
    )
  );
}

function exactRecoveryRule(rule, method, token) {
  const owner = value("PRIVY_DELEGATED_OWNER_ADDRESS");
  const maximum = value("PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT");
  return (
    owner &&
    maximum &&
    transactionRule(rule, method, token) &&
    calldataCondition(
      rule,
      "function_name",
      "eq",
      "transfer",
      erc20TransferAbi,
      "transfer",
    ) &&
    calldataCondition(
      rule,
      "transfer.to",
      "eq",
      owner,
      erc20TransferAbi,
      "transfer",
    ) &&
    calldataCondition(
      rule,
      "transfer.amount",
      "lte",
      maximum,
      erc20TransferAbi,
      "transfer",
    )
  );
}

function assertReadback(
  wallet,
  policy,
  recoveryPolicy,
  { requireSigner = true } = {},
) {
  const ownerId = value("PRIVY_DELEGATED_OWNER_ID");
  const signerId = value("PRIVY_DELEGATED_SIGNER_ID");
  const policyId = value("PRIVY_DELEGATED_POLICY_ID");
  const recoveryPolicyId = value("PRIVY_DELEGATED_RECOVERY_POLICY_ID");
  if (wallet.chain_type !== "ethereum")
    throw new Error("wallet is not an Ethereum wallet");
  if (wallet.owner_id !== ownerId)
    throw new Error(
      "wallet owner_id does not match the approved owner key quorum",
    );
  if (
    !Array.isArray(wallet.policy_ids) ||
    wallet.policy_ids.length !== 1 ||
    !wallet.policy_ids.includes(recoveryPolicyId)
  )
    throw new Error("wallet does not have the approved owner recovery policy");
  const signer = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers.find((item) => item?.signer_id === signerId)
    : undefined;
  if (
    requireSigner &&
    (!Array.isArray(wallet.additional_signers) ||
      wallet.additional_signers.length !== 1 ||
      !signer)
  )
    throw new Error("approved delegated additional signer is not attached");
  if (signer) {
    try {
      exactIds(
        signer.override_policy_ids,
        [policyId],
        "Delegated signer policy override",
      );
    } catch {
      throw new Error(
        "delegated signer does not have the approved policy override",
      );
    }
  }
  if (
    policy.id !== policyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0" ||
    policy.owner_id !== ownerId ||
    recoveryPolicy.id !== recoveryPolicyId ||
    recoveryPolicy.chain_type !== "ethereum" ||
    recoveryPolicy.version !== "1.0" ||
    recoveryPolicy.owner_id !== ownerId
  )
    throw new Error(
      "read-back policy identities do not match the approved owner and delegated policies",
    );
  const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
  const router = value("PRIVY_DELEGATED_ROUTER");
  const inputToken = value("PRIVY_DELEGATED_INPUT_TOKEN");
  const outputToken = value("PRIVY_DELEGATED_OUTPUT_TOKEN");
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const typedRules = rules.filter(
    (rule) =>
      rule?.action === "ALLOW" && rule?.method === "eth_signTypedData_v4",
  );
  const typedRule = typedRules.find(
    (rule) =>
      condition(
        rule,
        "ethereum_typed_data_domain",
        "chainId",
        "eq",
        String(chainId),
      ) &&
      condition(
        rule,
        "ethereum_typed_data_domain",
        "verifyingContract",
        "eq",
        router,
      ),
  );
  const method =
    value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast"
      ? "eth_signTransaction"
      : "eth_sendTransaction";
  const methodRules = rules.filter(
    (rule) =>
      rule?.action === "ALLOW" &&
      (rule.method === method || rule.method === "*"),
  );
  const sendRules = methodRules.filter((rule) => exactRouterRule(rule, method));
  const approvalRules = methodRules.filter((rule) =>
    transactionRule(rule, method, inputToken),
  );
  const recoveryRules = Array.isArray(recoveryPolicy.rules)
    ? recoveryPolicy.rules.filter(
        (rule) =>
          rule?.action === "ALLOW" &&
          (rule.method === method || rule.method === "*"),
      )
    : [];
  assertOnlyAllowMethods(
    rules,
    new Set(["eth_signTypedData_v4", method]),
    "Delegated execution policy",
  );
  assertOnlyAllowMethods(
    Array.isArray(recoveryPolicy.rules) ? recoveryPolicy.rules : [],
    new Set([method]),
    "Owner recovery policy",
  );
  const recoveryInputRules = recoveryRules.filter((rule) =>
    transactionRule(rule, method, inputToken),
  );
  const recoveryOutputRules = recoveryRules.filter((rule) =>
    transactionRule(rule, method, outputToken),
  );
  if (
    typedRules.length !== 1 ||
    !typedRule ||
    methodRules.length !== 2 ||
    sendRules.length !== 1 ||
    approvalRules.length !== 1 ||
    !exactApprovalRule(approvalRules[0], method) ||
    recoveryRules.length !== 2 ||
    recoveryInputRules.length !== 1 ||
    recoveryOutputRules.length !== 1 ||
    !exactRecoveryRule(recoveryInputRules[0], method, inputToken) ||
    !exactRecoveryRule(recoveryOutputRules[0], method, outputToken)
  )
    throw new Error(
      "read-back policies contain a broad grant or are missing an exact reviewed rule",
    );
}

function policyTemplate() {
  const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
  const router =
    value("PRIVY_DELEGATED_ROUTER") ?? "<SET_PRIVY_DELEGATED_ROUTER>";
  const inputToken =
    value("PRIVY_DELEGATED_INPUT_TOKEN") ?? "<SET_PRIVY_DELEGATED_INPUT_TOKEN>";
  const outputToken =
    value("PRIVY_DELEGATED_OUTPUT_TOKEN") ??
    "<SET_PRIVY_DELEGATED_OUTPUT_TOKEN>";
  const owner =
    value("PRIVY_DELEGATED_OWNER_ADDRESS") ??
    "<SET_PRIVY_DELEGATED_OWNER_ADDRESS>";
  const maximumInput =
    value("PRIVY_DELEGATED_MAX_INPUT_AMOUNT") ??
    "<SET_PRIVY_DELEGATED_MAX_INPUT_AMOUNT>";
  const maximumRecovery =
    value("PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT") ??
    "<SET_PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT>";
  const transactionMethod =
    value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast"
      ? "eth_signTransaction"
      : "eth_sendTransaction";
  return {
    execution: {
      name: `AURKA delegated ${routerMethod()} settlement`,
      version: "1.0",
      chain_type: "ethereum",
      rules: [
        {
          name: "delegated intent signatures",
          action: "ALLOW",
          method: "eth_signTypedData_v4",
          conditions: [
            {
              field_source: "ethereum_typed_data_domain",
              field: "chainId",
              operator: "eq",
              value: String(chainId),
            },
            {
              field_source: "ethereum_typed_data_domain",
              field: "verifyingContract",
              operator: "eq",
              value: router,
            },
          ],
        },
        {
          name: `direct settlement ${routerMethod()} only`,
          action: "ALLOW",
          method: transactionMethod,
          conditions: [
            {
              field_source: "ethereum_transaction",
              field: "to",
              operator: "eq",
              value: router,
            },
            {
              field_source: "ethereum_transaction",
              field: "value",
              operator: "eq",
              value: "0x0",
            },
            {
              field_source: "ethereum_transaction",
              field: "chain_id",
              operator: "eq",
              value: `0x${chainId.toString(16)}`,
            },
            {
              field_source: "ethereum_calldata",
              field: "function_name",
              abi: routerExecutionAbi(),
              operator: "eq",
              value: routerMethod(),
            },
          ],
        },
        {
          name: "exact input-token approval only",
          action: "ALLOW",
          method: transactionMethod,
          conditions: [
            {
              field_source: "ethereum_transaction",
              field: "to",
              operator: "eq",
              value: inputToken,
            },
            {
              field_source: "ethereum_transaction",
              field: "value",
              operator: "eq",
              value: "0x0",
            },
            {
              field_source: "ethereum_transaction",
              field: "chain_id",
              operator: "eq",
              value: `0x${chainId.toString(16)}`,
            },
            {
              field_source: "ethereum_calldata",
              field: "function_name",
              abi: erc20ApproveAbi,
              operator: "eq",
              value: "approve",
            },
            {
              field_source: "ethereum_calldata",
              field: "approve.spender",
              abi: erc20ApproveAbi,
              operator: "eq",
              value: router,
            },
            {
              field_source: "ethereum_calldata",
              field: "approve.amount",
              abi: erc20ApproveAbi,
              operator: "lte",
              value: maximumInput,
            },
          ],
        },
      ],
    },
    owner_recovery: {
      name: "AURKA owner recovery transfers only",
      version: "1.0",
      chain_type: "ethereum",
      rules: [inputToken, outputToken].map((token) => ({
        name: `owner recovery to configured owner: ${token}`,
        action: "ALLOW",
        method: transactionMethod,
        conditions: [
          {
            field_source: "ethereum_transaction",
            field: "to",
            operator: "eq",
            value: token,
          },
          {
            field_source: "ethereum_transaction",
            field: "value",
            operator: "eq",
            value: "0x0",
          },
          {
            field_source: "ethereum_transaction",
            field: "chain_id",
            operator: "eq",
            value: `0x${chainId.toString(16)}`,
          },
          {
            field_source: "ethereum_calldata",
            field: "function_name",
            abi: erc20TransferAbi,
            operator: "eq",
            value: "transfer",
          },
          {
            field_source: "ethereum_calldata",
            field: "transfer.to",
            abi: erc20TransferAbi,
            operator: "eq",
            value: owner,
          },
          {
            field_source: "ethereum_calldata",
            field: "transfer.amount",
            abi: erc20TransferAbi,
            operator: "lte",
            value: maximumRecovery,
          },
        ],
      })),
    },
    note: "The wallet base policy is owner-recovery-only; the delegated additional signer receives only the execution override. AURKA separately enforces session budgets, exact calldata, nonce, simulation, and receipt reconciliation.",
  };
}

async function main() {
  const command =
    process.argv[2] === "provision"
      ? "provision"
      : process.argv[2] === "template"
        ? "template"
        : process.argv[2] === "deny-test"
          ? "deny-test"
          : "check";
  if (command === "template") {
    process.stdout.write(`${JSON.stringify(policyTemplate(), null, 2)}\n`);
    return;
  }
  const missing = [...required, ...authorizationRequired].filter(
    (name) => !value(name),
  );
  if (command !== "provision" && !value("PRIVY_DELEGATED_WALLET_ID"))
    missing.push("PRIVY_DELEGATED_WALLET_ID");
  if (missing.length) {
    process.stdout.write(
      `${JSON.stringify({ configured: false, missing }, null, 2)}\n`,
    );
    if (command === "provision")
      fail("set all required variables before provisioning");
    return;
  }
  if (
    command === "provision" &&
    value("PRIVY_DELEGATED_PROVISION") !== "true"
  ) {
    fail(
      "provisioning is opt-in; set PRIVY_DELEGATED_PROVISION=true for this one command",
    );
    return;
  }
  const { PrivyClient } = await import("@privy-io/node");
  const client = new PrivyClient({
    appId: value("PRIVY_APP_ID"),
    appSecret: value("PRIVY_APP_SECRET"),
  });
  const keyQuorums = await verifyAuthorizationKeyQuorums(client);
  let wallet;
  const configuredWalletId = value("PRIVY_DELEGATED_WALLET_ID");
  if (configuredWalletId) {
    wallet = await client.wallets().get(configuredWalletId);
  } else if (command === "provision") {
    wallet = await client.wallets().create({
      chain_type: "ethereum",
      display_name: "AURKA delegated agent wallet",
      external_id: "aurka-delegated-agent-v1",
      owner_id: value("PRIVY_DELEGATED_OWNER_ID"),
      policy_ids: [value("PRIVY_DELEGATED_RECOVERY_POLICY_ID")],
      additional_signers: [
        {
          signer_id: value("PRIVY_DELEGATED_SIGNER_ID"),
          override_policy_ids: [value("PRIVY_DELEGATED_POLICY_ID")],
        },
      ],
      idempotency_key: "aurka-delegated-agent-wallet-v1",
    });
  } else {
    process.stdout.write(
      `${JSON.stringify(
        {
          configured: false,
          reason: "PRIVY_DELEGATED_WALLET_ID is not set; no wallet was created",
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const policy = await client
    .policies()
    .get(value("PRIVY_DELEGATED_POLICY_ID"));
  const recoveryPolicy = await client
    .policies()
    .get(value("PRIVY_DELEGATED_RECOVERY_POLICY_ID"));
  assertReadback(wallet, policy, recoveryPolicy, {
    requireSigner: command === "provision",
  });
  if (command === "deny-test") {
    const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
    try {
      await client
        .wallets()
        .ethereum()
        .signTypedData(value("PRIVY_DELEGATED_WALLET_ID"), {
          params: {
            typed_data: {
              domain: {
                name: "AURKA Direct Settlement",
                version: "1",
                chain_id: chainId,
                verifying_contract:
                  "0x0000000000000000000000000000000000000001",
              },
              types: {
                Intent: [{ name: "intentId", type: "bytes32" }],
              },
              primary_type: "Intent",
              message: { intentId: `0x${"00".repeat(32)}` },
            },
          },
          authorization_context: {
            authorization_private_keys: [
              value("PRIVY_DELEGATED_AUTHORIZATION_PRIVATE_KEY"),
            ],
          },
          idempotency_key: "aurka-delegated-policy-denial-v1",
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/policy|permission|forbidden|not allowed|denied/i.test(message))
        throw error;
      process.stdout.write(
        `${JSON.stringify({ configured: true, denied: true, reason: "Privy policy rejected the prohibited typed-data domain" }, null, 2)}\n`,
      );
      return;
    }
    throw new Error(
      "Privy policy unexpectedly allowed the prohibited typed-data domain",
    );
  }
  process.stdout.write(
    `${JSON.stringify({ configured: true, key_quorums: keyQuorums, ...summary(wallet, policy, recoveryPolicy) }, null, 2)}\n`,
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Privy check failed"),
);
