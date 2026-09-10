/*
 * Idempotent operator command for the dedicated AURKA demo wallet.
 *
 * `check` is read-only. `provision` is the only mode allowed to create a
 * wallet, and it still requires PRIVY_DELEGATED_PROVISION=true. The script
 * never prints app secrets, authorization contexts, private keys, or policy
 * bodies.
 */
import process from "node:process";

const required = [
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_DELEGATED_OWNER_ID",
  "PRIVY_DELEGATED_SIGNER_ID",
  "PRIVY_DELEGATED_POLICY_ID",
  "PRIVY_DELEGATED_ROUTER",
];

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function fail(message) {
  process.stderr.write(`Privy delegated wallet: ${message}\n`);
  process.exitCode = 2;
}

function summary(wallet, policy) {
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
  };
}

function assertReadback(wallet, policy) {
  const ownerId = value("PRIVY_DELEGATED_OWNER_ID");
  const signerId = value("PRIVY_DELEGATED_SIGNER_ID");
  const policyId = value("PRIVY_DELEGATED_POLICY_ID");
  if (wallet.chain_type !== "ethereum")
    throw new Error("wallet is not an Ethereum wallet");
  if (wallet.owner_id !== ownerId)
    throw new Error(
      "wallet owner_id does not match the approved owner key quorum",
    );
  if (
    !Array.isArray(wallet.policy_ids) ||
    !wallet.policy_ids.includes(policyId)
  )
    throw new Error("wallet does not have the approved policy attached");
  const signer = Array.isArray(wallet.additional_signers)
    ? wallet.additional_signers.find((item) => item?.signer_id === signerId)
    : undefined;
  if (!signer)
    throw new Error("approved delegated additional signer is not attached");
  if (
    !Array.isArray(signer.override_policy_ids) ||
    !signer.override_policy_ids.includes(policyId)
  )
    throw new Error(
      "delegated signer does not have the approved policy override",
    );
  if (
    policy.id !== policyId ||
    policy.chain_type !== "ethereum" ||
    policy.version !== "1.0"
  )
    throw new Error(
      "read-back policy identity is not the approved Ethereum policy",
    );
  if (policy.owner_id !== ownerId)
    throw new Error(
      "policy owner_id does not match the approved owner key quorum",
    );
  const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
  const router = value("PRIVY_DELEGATED_ROUTER").toLowerCase();
  const condition = (rule, fieldSource, field, expected) =>
    Array.isArray(rule?.conditions) &&
    rule.conditions.some(
      (item) =>
        item?.field_source === fieldSource &&
        item?.field === field &&
        item?.operator === "eq" &&
        (Array.isArray(item.value) ? item.value : [item.value]).some(
          (candidate) =>
            String(candidate).toLowerCase() === expected.toLowerCase(),
        ),
    );
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  const typedRule = rules.find(
    (rule) =>
      rule?.action === "ALLOW" &&
      rule?.method === "eth_signTypedData_v4" &&
      condition(
        rule,
        "ethereum_typed_data_domain",
        "chainId",
        String(chainId),
      ) &&
      condition(
        rule,
        "ethereum_typed_data_domain",
        "verifyingContract",
        router,
      ),
  );
  const sendRule = rules.find(
    (rule) =>
      rule?.action === "ALLOW" &&
      rule?.method === "eth_sendTransaction" &&
      condition(
        rule,
        "ethereum_transaction",
        "chain_id",
        `0x${chainId.toString(16)}`,
      ) &&
      condition(rule, "ethereum_transaction", "to", router) &&
      condition(rule, "ethereum_transaction", "value", "0x0"),
  );
  if (!typedRule || !sendRule)
    throw new Error(
      "read-back policy is missing the exact chain/domain/router allow rules",
    );
}

function policyTemplate() {
  const chainId = Number(value("PRIVY_DELEGATED_CHAIN_ID") ?? "31337");
  const router =
    value("PRIVY_DELEGATED_ROUTER") ?? "<SET_PRIVY_DELEGATED_ROUTER>";
  return {
    name: "AURKA delegated direct settlement",
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
        name: "direct settlement execute only",
        action: "ALLOW",
        method: "eth_sendTransaction",
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
        ],
      },
    ],
    note: "Privy policy is target/method scoped. AURKA enforces session budget, exact calldata, assets, allowance, nonce, and simulation locally before every send.",
  };
}

async function main() {
  const command =
    process.argv[2] === "provision"
      ? "provision"
      : process.argv[2] === "template"
        ? "template"
        : "check";
  if (command === "template") {
    process.stdout.write(`${JSON.stringify(policyTemplate(), null, 2)}\n`);
    return;
  }
  const missing = required.filter((name) => !value(name));
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
  let wallet;
  const configuredWalletId = value("PRIVY_DELEGATED_WALLET_ID");
  if (configuredWalletId) {
    wallet = await client.wallets.get(configuredWalletId);
  } else if (command === "provision") {
    wallet = await client.wallets.create({
      chain_type: "ethereum",
      display_name: "AURKA delegated agent wallet",
      external_id: "aurka-delegated-agent-v1",
      owner_id: value("PRIVY_DELEGATED_OWNER_ID"),
      policy_ids: [value("PRIVY_DELEGATED_POLICY_ID")],
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
  const policy = await client.policies.get(value("PRIVY_DELEGATED_POLICY_ID"));
  assertReadback(wallet, policy);
  process.stdout.write(
    `${JSON.stringify({ configured: true, ...summary(wallet, policy) }, null, 2)}\n`,
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Privy check failed"),
);
