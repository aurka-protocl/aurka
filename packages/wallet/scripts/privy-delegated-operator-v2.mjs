/* global process */

/*
 * Live operator callbacks for the dedicated delegated Privy wallet.
 *
 * This module is imported only by the server. It performs readback before
 * every delegated status request, removes the additional signer with owner
 * authorization, and sends recovery transfers with the owner authorization
 * path. It never exposes authorization keys to AURKA or the model.
 */
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
} from "viem";

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

// The policy must identify the frozen router entry point as well as its
// address.  The nested tuple components are not needed to compare the
// function selector, but the top-level ABI shape is kept explicit so a
// provider readback cannot silently downgrade to a target-only grant.
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

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function required(name) {
  const result = value(name);
  if (!result)
    throw new Error(`${name} is required for live delegated Privy operation`);
  return result;
}

function numberValue(name) {
  const result = Number(required(name));
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error(`${name} must be a non-negative safe integer`);
  return result;
}

function uintValue(name) {
  const result = required(name);
  if (!/^(0|[1-9][0-9]*)$/.test(result))
    throw new Error(`${name} must be a decimal unsigned integer`);
  return BigInt(result);
}

function address(name) {
  const result = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(result))
    throw new Error(`${name} must be an EVM address`);
  return result;
}

function validAddress(result, label) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(result))
    throw new Error(`${label} must be an EVM address`);
  return result;
}

function clientPromise() {
  return import("@privy-io/node").then(
    ({ PrivyClient }) =>
      new PrivyClient({
        appId: required("PRIVY_APP_ID"),
        appSecret: required("PRIVY_APP_SECRET"),
      }),
  );
}

let cachedClient;
async function client() {
  cachedClient ??= clientPromise();
  return cachedClient;
}

async function walletFor(walletId) {
  const configured = required("PRIVY_DELEGATED_WALLET_ID");
  if (walletId !== configured)
    throw new Error("Delegated wallet id does not match configuration");
  const wallet = await (await client()).wallets().get(walletId);
  if (wallet.chain_type !== "ethereum")
    throw new Error("Privy delegated wallet is not Ethereum");
  if (wallet.owner_id !== required("PRIVY_DELEGATED_OWNER_ID"))
    throw new Error("Privy wallet owner readback mismatch");
  return wallet;
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
  const chainId = numberValue("PRIVY_DELEGATED_CHAIN_ID");
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

function exactApprovalRule(rule, method) {
  const router = address("PRIVY_DELEGATED_ROUTER");
  const maximum = required("PRIVY_DELEGATED_MAX_INPUT_AMOUNT");
  return (
    transactionRule(rule, method, address("PRIVY_DELEGATED_INPUT_TOKEN")) &&
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
  const owner = address("PRIVY_DELEGATED_OWNER_ADDRESS");
  const maximum = required("PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT");
  return (
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

function transactionMethod() {
  return value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast"
    ? "eth_signTransaction"
    : "eth_sendTransaction";
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

function exactRouterRule(rule, method) {
  return (
    transactionRule(rule, method, address("PRIVY_DELEGATED_ROUTER")) &&
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

function assertExecutionPolicy(wallet, policy, requireSigner) {
  const ownerId = required("PRIVY_DELEGATED_OWNER_ID");
  const signerId = required("PRIVY_DELEGATED_SIGNER_ID");
  const policyId = required("PRIVY_DELEGATED_POLICY_ID");
  const recoveryPolicyId = required("PRIVY_DELEGATED_RECOVERY_POLICY_ID");
  const chainId = numberValue("PRIVY_DELEGATED_CHAIN_ID");
  const router = address("PRIVY_DELEGATED_ROUTER");
  const inputToken = address("PRIVY_DELEGATED_INPUT_TOKEN");
  const selectedRouterMethod = routerMethod();
  if (wallet.chain_type !== "ethereum")
    throw new Error("Privy delegated wallet is not Ethereum");
  if (wallet.owner_id !== ownerId)
    throw new Error("Privy wallet owner readback mismatch");
  if (
    !Array.isArray(wallet.policy_ids) ||
    wallet.policy_ids.length !== 1 ||
    !wallet.policy_ids.includes(recoveryPolicyId)
  )
    throw new Error(
      "Privy delegated wallet is missing the owner recovery policy",
    );
  if (
    policy.id !== policyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0" ||
    policy.owner_id !== ownerId
  )
    throw new Error("Privy delegated policy identity readback mismatch");
  const signers = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers
    : [];
  if (signers.some((item) => item?.signer_id !== signerId))
    throw new Error("Privy wallet has an unexpected additional signer");
  if (signers.length > 1)
    throw new Error("Privy wallet has unexpected additional signers");
  const signer = signers.find((item) => item?.signer_id === signerId);
  if (requireSigner && !signer)
    throw new Error("Privy delegated signer is not attached to the wallet");
  if (signer) {
    try {
      exactIds(
        signer.override_policy_ids,
        [policyId],
        "Delegated signer policy override",
      );
    } catch {
      throw new Error(
        "Privy delegated signer policy override readback mismatch",
      );
    }
  }

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const method = transactionMethod();
  assertOnlyAllowMethods(
    rules,
    new Set(["eth_signTypedData_v4", method]),
    "Delegated execution policy",
  );
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
  const methodRules = rules.filter(
    (rule) =>
      rule?.action === "ALLOW" &&
      (rule.method === method || rule.method === "*"),
  );
  const routerRules = methodRules.filter((rule) =>
    exactRouterRule(rule, method),
  );
  const approvalRules = methodRules.filter((rule) =>
    transactionRule(rule, method, inputToken),
  );
  if (
    typedRules.length !== 1 ||
    !typedRule ||
    methodRules.length !== 2 ||
    routerRules.length !== 1 ||
    approvalRules.length !== 1 ||
    !exactApprovalRule(approvalRules[0], method)
  )
    throw new Error(
      "Privy policy contains a broad grant or is missing the reviewed typed-data, router, and exact approval rules",
    );
  return { signer, routerMethod: selectedRouterMethod };
}

function assertRecoveryPolicy(wallet, policy) {
  const ownerId = required("PRIVY_DELEGATED_OWNER_ID");
  const policyId = required("PRIVY_DELEGATED_RECOVERY_POLICY_ID");
  if (
    !Array.isArray(wallet.policy_ids) ||
    wallet.policy_ids.length !== 1 ||
    !wallet.policy_ids.includes(policyId)
  )
    throw new Error(
      "Privy owner recovery policy is not attached to the wallet",
    );
  if (
    policy.id !== policyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0" ||
    policy.owner_id !== ownerId
  )
    throw new Error("Privy owner recovery policy identity readback mismatch");
  const method = transactionMethod();
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  assertOnlyAllowMethods(rules, new Set([method]), "Owner recovery policy");
  const allowed = rules.filter(
    (rule) =>
      rule?.action === "ALLOW" &&
      (rule.method === method || rule.method === "*"),
  );
  const inputToken = address("PRIVY_DELEGATED_INPUT_TOKEN");
  const outputToken = address("PRIVY_DELEGATED_OUTPUT_TOKEN");
  const inputRules = allowed.filter((rule) =>
    transactionRule(rule, method, inputToken),
  );
  const outputRules = allowed.filter((rule) =>
    transactionRule(rule, method, outputToken),
  );
  if (
    allowed.length !== 2 ||
    inputRules.length !== 1 ||
    outputRules.length !== 1 ||
    !exactRecoveryRule(inputRules[0], method, inputToken) ||
    !exactRecoveryRule(outputRules[0], method, outputToken)
  )
    throw new Error(
      "Privy owner policy must allow only exact reviewed recovery transfers",
    );
}

function policyFingerprint(policy) {
  return keccak256(
    stringToHex(
      JSON.stringify({
        id: policy.id,
        version: policy.version,
        chainType: policy.chain_type,
        rules: policy.rules ?? [],
      }),
    ),
  );
}

export async function getDelegatedExecutionPolicy({ walletId }) {
  const wallet = await walletFor(walletId);
  const privy = await client();
  const policy = await privy
    .policies()
    .get(required("PRIVY_DELEGATED_POLICY_ID"));
  const recoveryPolicy = await privy
    .policies()
    .get(required("PRIVY_DELEGATED_RECOVERY_POLICY_ID"));
  const execution = assertExecutionPolicy(wallet, policy, false);
  assertRecoveryPolicy(wallet, recoveryPolicy);
  const chainId = numberValue("PRIVY_DELEGATED_CHAIN_ID");
  return {
    walletId,
    walletAddress: addressFromWallet(wallet),
    signerAddress: address("PRIVY_DELEGATED_SIGNER_ADDRESS"),
    policyId: policy.id,
    chainId,
    router: address("PRIVY_DELEGATED_ROUTER"),
    inputToken: address("PRIVY_DELEGATED_INPUT_TOKEN"),
    outputToken: address("PRIVY_DELEGATED_OUTPUT_TOKEN"),
    maximumInputAmount: required("PRIVY_DELEGATED_MAX_INPUT_AMOUNT"),
    validUntil: numberValue("PRIVY_DELEGATED_POLICY_VALID_UNTIL"),
    paused: policy.paused === true,
    revoked: policy.revoked === true || !execution.signer,
    fingerprint: policyFingerprint(policy),
    allowedMethods: ["eth_call", "eth_signTypedData_v4", transactionMethod()],
    routerMethod: execution.routerMethod,
  };
}

function addressFromWallet(wallet) {
  return validAddress(
    wallet.address,
    "Privy delegated wallet address readback",
  );
}

function ownerAuthorization() {
  const key = required("PRIVY_DELEGATED_OWNER_AUTHORIZATION_PRIVATE_KEY");
  return { authorization_private_keys: [key] };
}

function hex(result) {
  return `0x${result.toString(16)}`;
}

function quantity(result, label) {
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result))
    throw new Error(`Malformed ${label}`);
  return BigInt(result);
}

async function recoveryTransaction(rpc, wallet, token, destination, amount) {
  if (!rpc || typeof rpc.request !== "function")
    throw new Error("A canonical RPC route is required for local recovery");
  const chainId = BigInt(numberValue("PRIVY_DELEGATED_CHAIN_ID"));
  const actualChain = quantity(
    await rpc.request("eth_chainId", []),
    "recovery chain ID",
  );
  if (actualChain !== chainId) throw new Error("Recovery RPC chain mismatch");
  const data = encodeFunctionData({
    abi: erc20TransferAbi,
    functionName: "transfer",
    args: [destination, amount],
  });
  const base = {
    from: addressFromWallet(wallet),
    to: token,
    data,
    value: "0x0",
  };
  const nonce = quantity(
    await rpc.request("eth_getTransactionCount", [base.from, "pending"]),
    "recovery transaction nonce",
  );
  const gas = quantity(
    await rpc.request("eth_estimateGas", [base]),
    "recovery gas limit",
  );
  const gasPrice = quantity(
    await rpc.request("eth_gasPrice", []),
    "recovery gas price",
  );
  return {
    ...base,
    nonce: hex(nonce),
    chain_id: hex(chainId),
    gas_limit: hex(gas),
    gas_price: hex(gasPrice),
  };
}

async function signAndBroadcastRecovery(
  walletId,
  wallet,
  transaction,
  rpc,
  authorizationHash,
) {
  const signed = await (
    await client()
  )
    .wallets()
    .ethereum()
    .signTransaction(walletId, {
      params: { transaction },
      authorization_context: ownerAuthorization(),
      idempotency_key: `aurka-d-recovery:${authorizationHash}`,
    });
  if (
    signed?.encoding !== "rlp" ||
    typeof signed?.signed_transaction !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(signed.signed_transaction)
  )
    throw new Error("Privy returned no trustworthy recovery transaction");
  let parsed;
  let signer;
  try {
    signer = await recoverTransactionAddress({
      serializedTransaction: signed.signed_transaction,
    });
    parsed = parseTransaction(signed.signed_transaction);
  } catch {
    throw new Error("Privy returned an invalid recovery transaction");
  }
  if (
    signer.toLowerCase() !== wallet.address.toLowerCase() ||
    parsed.to?.toLowerCase() !== transaction.to.toLowerCase() ||
    (parsed.data ?? "0x").toLowerCase() !== transaction.data.toLowerCase() ||
    (parsed.value ?? 0n) !== 0n ||
    parsed.nonce !== Number(BigInt(transaction.nonce)) ||
    parsed.chainId !== Number(BigInt(transaction.chain_id)) ||
    parsed.gas !== BigInt(transaction.gas_limit) ||
    parsed.gasPrice !== BigInt(transaction.gas_price)
  )
    throw new Error("Privy changed the reviewed recovery transaction");
  const hash = await rpc.request("eth_sendRawTransaction", [
    signed.signed_transaction,
  ]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new Error("Recovery broadcast returned no trustworthy hash");
  return hash;
}

export async function revokeDelegatedSigner({ walletId, signerId, policyId }) {
  if (signerId !== required("PRIVY_DELEGATED_SIGNER_ID"))
    throw new Error("Delegated signer id does not match configuration");
  if (policyId !== required("PRIVY_DELEGATED_POLICY_ID"))
    throw new Error("Delegated policy id does not match configuration");
  const wallet = await walletFor(walletId);
  const signers = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers.filter((item) => item?.signer_id !== signerId)
    : [];
  await (await client()).wallets().update(walletId, {
    additional_signers: signers,
    authorization_context: ownerAuthorization(),
  });
  const confirmed = await walletFor(walletId);
  if (
    !Array.isArray(confirmed.additional_signers) ||
    confirmed.additional_signers.some((item) => item?.signer_id === signerId)
  )
    throw new Error("Privy delegated signer revoke was not confirmed");
}

export async function recoverDelegatedFunds({
  walletId,
  ownerAddress,
  destination,
  assets,
  authorizationHash,
  rpc,
}) {
  const configuredOwner = address("PRIVY_DELEGATED_OWNER_ADDRESS");
  validAddress(ownerAddress, "Recovery owner");
  validAddress(destination, "Recovery destination");
  if (ownerAddress.toLowerCase() !== configuredOwner.toLowerCase())
    throw new Error(
      "Recovery owner does not match the configured owner address",
    );
  if (destination.toLowerCase() !== configuredOwner.toLowerCase())
    throw new Error("Recovery destination is not the configured owner address");
  if (!/^0x[0-9a-fA-F]{64}$/.test(authorizationHash))
    throw new Error("Recovery authorization hash is malformed");
  if (!Array.isArray(assets) || assets.length !== 1)
    throw new Error(
      "Live Privy recovery accepts one exact token transfer per authorization",
    );
  const allowed = new Set([
    address("PRIVY_DELEGATED_INPUT_TOKEN").toLowerCase(),
    address("PRIVY_DELEGATED_OUTPUT_TOKEN").toLowerCase(),
  ]);
  const asset = assets[0];
  if (!asset || !allowed.has(String(asset.token).toLowerCase()))
    throw new Error("Recovery token is not in the reviewed pair");
  if (
    !/^(0|[1-9][0-9]*)$/.test(String(asset.amount)) ||
    BigInt(asset.amount) <= 0n
  )
    throw new Error("Recovery amount must be a positive decimal integer");
  if (BigInt(asset.amount) > uintValue("PRIVY_DELEGATED_MAX_RECOVERY_AMOUNT"))
    throw new Error("Recovery amount exceeds the owner policy cap");
  const token = validAddress(asset.token, "Recovery token");
  const wallet = await walletFor(walletId);
  const recoveryPolicy = await (
    await client()
  )
    .policies()
    .get(required("PRIVY_DELEGATED_RECOVERY_POLICY_ID"));
  assertRecoveryPolicy(wallet, recoveryPolicy);
  const transaction = await recoveryTransaction(
    rpc,
    wallet,
    token,
    destination,
    BigInt(asset.amount),
  );
  if (value("PRIVY_DELEGATED_BROADCAST_MODE") === "sign-and-broadcast")
    return {
      transactionHash: await signAndBroadcastRecovery(
        walletId,
        wallet,
        transaction,
        rpc,
        authorizationHash,
      ),
    };
  const chainId = numberValue("PRIVY_DELEGATED_CHAIN_ID");
  const result = await (
    await client()
  )
    .wallets()
    .ethereum()
    .sendTransaction(walletId, {
      caip2: `eip155:${chainId}`,
      params: { transaction },
      authorization_context: ownerAuthorization(),
      idempotency_key: `aurka-d-recovery:${authorizationHash}`,
    });
  if (
    result?.caip2 !== `eip155:${chainId}` ||
    typeof result?.hash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(result.hash)
  )
    throw new Error("Privy recovery returned no trustworthy transaction hash");
  return { transactionHash: result.hash };
}
