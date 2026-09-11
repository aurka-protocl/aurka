/* global URL, console, process */

import { readFileSync } from "node:fs";

import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hashAquaBalances } from "../dist/solver/hash.js";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const CHAIN_ID = 11_155_111;
const ZERO_HASH = `0x${"00".repeat(32)}`;

function value(name) {
  const result = process.env[name]?.trim();
  return result || undefined;
}

function requireValue(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function address(value_, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value_ ?? "")) {
    throw new Error(`${label} must be an EVM address`);
  }
  return value_;
}

function privateKey() {
  const configured =
    value("AURKA_SEPOLIA_PRIVATE_KEY") ??
    value("DEPLOYER_PRIVATE_KEY") ??
    // Node's env-file parser preserves a leading blank-line character when
    // the existing repository .env has a whitespace-only separator.
    process.env["\nDEPLOYER_PRIVATE_KEY"]?.trim();
  if (!configured) {
    throw new Error(
      "AURKA_SEPOLIA_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY is required",
    );
  }
  const raw = configured.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("Sepolia private key must be a 32-byte hex key");
  }
  return `0x${raw}`;
}

function artifact(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function bytes32Address(token) {
  return `0x${token.slice(2).toLowerCase().padStart(64, "0")}`;
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function rawPerValue(value_, decimals, price, priceDecimals) {
  return ceilDiv(value_ * 10n ** BigInt(decimals + priceDecimals), price);
}

function normalizedValue(
  balance,
  decimals,
  price,
  priceDecimals,
  valueDecimals,
) {
  return (
    (balance * price * 10n ** BigInt(valueDecimals)) /
    10n ** BigInt(decimals + priceDecimals)
  );
}

function snapshot(token, raw) {
  return {
    token,
    snapshotId: raw[3],
    price: raw[0],
    priceDecimals: Number(raw[1]),
    observedAt: Number(raw[2]),
  };
}

function portfolioSnapshotHash(tokens, snapshots) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address[]" },
        {
          type: "tuple[]",
          components: [
            { name: "token", type: "address" },
            { name: "snapshotId", type: "bytes32" },
            { name: "price", type: "uint256" },
            { name: "priceDecimals", type: "uint8" },
            { name: "observedAt", type: "uint64" },
          ],
        },
      ],
      [tokens, snapshots],
    ),
  );
}

async function waitForSuccess(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

function capacityEpochId(epoch) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        epoch.positionIdHash,
        epoch.traderInputTokenId,
        epoch.traderOutputTokenId,
        epoch.balanceSnapshot,
        epoch.priceSnapshot,
        epoch.portfolioPriceSnapshot,
        epoch.policyNonce,
        epoch.riskCertificateHash,
        epoch.aquaStrategyHash,
        epoch.capacityBaseline,
        epoch.chainId,
        epoch.verifyingContract,
      ],
    ),
  );
}

async function main() {
  const manifestPath = path.join(
    ROOT,
    value("AURKA_SEPOLIA_MANIFEST_PATH") ??
      "deploy/sepolia/sepolia-deployment.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.chain?.id !== CHAIN_ID) {
    throw new Error("Sepolia manifest has the wrong chain ID");
  }
  if (!manifest.space?.createTransactionHash) {
    throw new Error("create the Sepolia Space before reactivating capacity");
  }

  const rpc = value("AURKA_SEPOLIA_RPC_URL") ?? requireValue("SEPOLIA_RPC_URL");
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = privateKeyToAccount(privateKey());
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpc),
  });

  const router = address(manifest.contracts.router.address, "router");
  const registry = address(
    manifest.contracts.policyRegistry.address,
    "policy registry",
  );
  const riskRegistry = address(
    manifest.contracts.riskRegistry.address,
    "risk registry",
  );
  const oracle = address(manifest.oracle.address, "oracle");
  const aqua = address(manifest.contracts.aqua.address, "Aqua");
  const tradeMath = address(manifest.contracts.tradeMath.address, "trade math");
  const swapVM = address(manifest.contracts.swapVM.address, "SwapVM");
  const vault = address(manifest.space.vault, "Space vault");
  const policyId = manifest.space.policyId;
  const positionId = manifest.space.spaceId;
  const strategyHash = manifest.space.strategyHash;

  const routerArtifact = artifact(
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  );
  const registryArtifact = artifact(
    "contracts/out/AurkaPolicyRegistry.sol/AurkaPolicyRegistry.json",
  );
  const riskArtifact = artifact(
    "contracts/out/RiskModeRegistry.sol/RiskModeRegistry.json",
  );
  const oracleArtifact = artifact(
    "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  );
  const aquaArtifact = artifact("contracts/out-upstream/Aqua.sol/Aqua.json");
  const tradeMathArtifact = artifact(
    "contracts/out/AurkaSepoliaTradeMath.sol/AurkaSepoliaTradeMath.json",
  );

  const routerContract = { address: router, abi: routerArtifact.abi };
  const registryContract = { address: registry, abi: registryArtifact.abi };
  const riskContract = { address: riskRegistry, abi: riskArtifact.abi };
  const oracleContract = { address: oracle, abi: oracleArtifact.abi };
  const aquaContract = { address: aqua, abi: aquaArtifact.abi };

  const priceRefreshTransactions = {};
  const shouldRefreshMockPrices =
    manifest.oracle.mode === "mock" &&
    value("AURKA_SEPOLIA_REFRESH_PRICES") !== "false" &&
    value("AURKA_SEPOLIA_DRY_RUN") !== "true";
  if (shouldRefreshMockPrices) {
    let latestBlock = await publicClient.getBlock();
    for (const [token, price, label, key] of [
      [manifest.tokens.usdc.address, 1n, "aurka-sepolia-usdc-price-v1", "usdc"],
      [
        manifest.tokens.weth.address,
        3200n,
        "aurka-sepolia-weth-price-v1",
        "weth",
      ],
    ]) {
      const hash = await walletClient.writeContract({
        account,
        ...oracleContract,
        functionName: "setPrice",
        args: [
          token,
          price,
          0,
          latestBlock.timestamp,
          keccak256(stringToHex(label)),
        ],
      });
      priceRefreshTransactions[key] = await waitForSuccess(
        publicClient,
        hash,
        `refresh ${key} price`,
      );
      latestBlock = await publicClient.getBlock();
    }
  }

  const [block, policy, state, tokens, riskActive, effectiveMaximum] =
    await Promise.all([
      publicClient.getBlock(),
      publicClient.readContract({
        ...registryContract,
        functionName: "getPolicy",
        args: [policyId],
      }),
      publicClient.readContract({
        ...routerContract,
        functionName: "capacityState",
        args: [
          positionId,
          manifest.tokens.weth.address,
          manifest.tokens.usdc.address,
        ],
      }),
      publicClient.readContract({
        ...registryContract,
        functionName: "assets",
        args: [policyId],
      }),
      publicClient.readContract({
        ...riskContract,
        functionName: "isRiskActive",
        args: [policyId],
      }),
      publicClient.readContract({
        ...riskContract,
        functionName: "effectiveMaximumTradeValue",
        args: [policyId],
      }),
    ]);

  if (
    account.address.toLowerCase() !== policy.governance.toLowerCase() &&
    account.address.toLowerCase() !== policy.treasury.toLowerCase()
  ) {
    throw new Error(
      `reactivation signer ${account.address} is not the Space governance or treasury`,
    );
  }
  if (tokens.length < 2)
    throw new Error("the policy must manage at least two assets");

  const priceRows = await Promise.all(
    tokens.map((token) =>
      publicClient.readContract({
        ...oracleContract,
        functionName: "getPrice",
        args: [token],
      }),
    ),
  );
  const prices = tokens.map((token, index) =>
    snapshot(token, priceRows[index]),
  );
  const inputToken = address(manifest.tokens.weth.address, "WETH");
  const outputToken = address(manifest.tokens.usdc.address, "USDC");
  const inputPrice = prices.find(
    (item) => item.token.toLowerCase() === inputToken.toLowerCase(),
  );
  const outputPrice = prices.find(
    (item) => item.token.toLowerCase() === outputToken.toLowerCase(),
  );
  if (!inputPrice || !outputPrice) {
    throw new Error("the policy asset list does not contain WETH and USDC");
  }

  const balances = await Promise.all(
    tokens.map((token) =>
      publicClient.readContract({
        ...aquaContract,
        functionName: "rawBalances",
        args: [vault, swapVM, strategyHash, token],
      }),
    ),
  );
  const rawBalances = balances.map((item) => BigInt(item[0]));
  const assetRows = await Promise.all(
    tokens.map(async (token, index) => {
      const [hard, active] = await Promise.all([
        publicClient.readContract({
          ...registryContract,
          functionName: "assetBounds",
          args: [policyId, token],
        }),
        publicClient.readContract({
          ...riskContract,
          functionName: "effectiveAssetBound",
          args: [policyId, token],
        }),
      ]);
      const price = prices[index];
      return {
        token,
        value: normalizedValue(
          rawBalances[index],
          Number(hard.decimals),
          price.price,
          price.priceDecimals,
          0,
        ),
        minimumWeightBps: Number(active.minimumWeightBps),
        maximumWeightBps: Number(active.maximumWeightBps),
        decimals: Number(hard.decimals),
      };
    }),
  );

  let riskCertificateHash = ZERO_HASH;
  if (riskActive) {
    const activeRisk = await publicClient.readContract({
      ...riskContract,
      functionName: "rawActiveRisk",
      args: [policyId],
    });
    riskCertificateHash = activeRisk.certificateHash;
  }
  const priceInput = {
    traderInputToken: inputToken,
    traderOutputToken: outputToken,
    traderInputReferencePrice: inputPrice,
    traderInputExecutionPrice: inputPrice,
    traderOutputReferencePrice: outputPrice,
    traderOutputExecutionPrice: outputPrice,
    approvedTraderInputSnapshotId: inputPrice.snapshotId,
    approvedTraderOutputSnapshotId: outputPrice.snapshotId,
    traderInputAmount: rawPerValue(
      BigInt(effectiveMaximum),
      18,
      inputPrice.price,
      inputPrice.priceDecimals,
    ),
    traderOutputAmount: rawPerValue(
      BigInt(effectiveMaximum),
      6,
      outputPrice.price,
      outputPrice.priceDecimals,
    ),
    traderInputDecimals: 18,
    traderOutputDecimals: 6,
    valueDecimals: 0,
    currentTime: block.timestamp,
    maximumPriceAgeSeconds: Number(policy.priceMaxAgeSeconds),
    maximumPriceDeviationBps: Number(policy.maximumPriceDeviationBps),
  };
  const priceSnapshot = await publicClient.readContract({
    ...routerContract,
    functionName: "priceSnapshotHash",
    args: [priceInput],
  });
  const portfolioPriceSnapshot = portfolioSnapshotHash(tokens, prices);
  const balanceSnapshot = hashAquaBalances(tokens, rawBalances);
  const fee = {
    baseFeeBps: Number(policy.fee.baseFeeBps),
    slopeBps: Number(policy.fee.slopeBps),
    maximumFeeBps: Number(policy.fee.maximumFeeBps),
    treasuryBaseFeeBps: Number(policy.fee.treasuryBaseFeeBps),
    solverFeeBps: Number(policy.fee.solverFeeBps),
    protocolFeeBps: Number(policy.fee.protocolFeeBps),
  };
  const upperEpoch = {
    positionIdHash: positionId,
    traderInputTokenId: bytes32Address(inputToken),
    traderOutputTokenId: bytes32Address(outputToken),
    balanceSnapshot,
    priceSnapshot,
    portfolioPriceSnapshot,
    policyNonce: BigInt(policy.nonce),
    riskCertificateHash,
    aquaStrategyHash: strategyHash,
    capacityBaseline: BigInt(effectiveMaximum),
    consumedBefore: 0n,
    chainId: BigInt(CHAIN_ID),
    verifyingContract: router,
    capacityEpochId: ZERO_HASH,
  };
  upperEpoch.capacityEpochId = capacityEpochId(upperEpoch);
  const fill = await publicClient.readContract({
    address: tradeMath,
    abi: tradeMathArtifact.abi,
    functionName: "maximumSafeFill",
    args: [
      assetRows.map(
        ({ token, value: assetValue, minimumWeightBps, maximumWeightBps }) => ({
          token,
          value: assetValue,
          minimumWeightBps,
          maximumWeightBps,
        }),
      ),
      inputToken,
      outputToken,
      BigInt(effectiveMaximum),
      BigInt(effectiveMaximum),
      BigInt(effectiveMaximum),
      0n,
      fee,
      priceInput,
      upperEpoch,
      block.timestamp,
    ],
  });
  const capacityBaseline = BigInt(fill.maximumSafeFill);
  if (capacityBaseline === 0n) {
    throw new Error(
      "current portfolio has no safe directional capacity; rebalance the Space before reactivating",
    );
  }
  const epoch = { ...upperEpoch, capacityBaseline, capacityEpochId: ZERO_HASH };
  epoch.capacityEpochId = capacityEpochId(epoch);

  const summary = {
    account: account.address,
    chainId: CHAIN_ID,
    policyId,
    positionId,
    previousCapacityEpochId: state.capacityEpochId,
    previousConsumedValue: state.consumedValue.toString(),
    newCapacityEpochId: epoch.capacityEpochId,
    capacityBaseline: capacityBaseline.toString(),
    balanceSnapshot,
    priceSnapshot,
    portfolioPriceSnapshot,
    riskCertificateHash,
    effectiveMaximumTransactionValue: effectiveMaximum.toString(),
    priceRefreshTransactions,
    dryRun: value("AURKA_SEPOLIA_DRY_RUN") === "true",
  };

  const simulation = await publicClient.simulateContract({
    account,
    ...routerContract,
    functionName: "activateCapacityEpoch",
    args: [policyId, epoch, priceInput],
  });
  if (value("AURKA_SEPOLIA_DRY_RUN") === "true") {
    console.log(JSON.stringify({ ...summary, simulated: true }, null, 2));
    return;
  }

  console.log(JSON.stringify({ ...summary, simulated: true }, null, 2));
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("capacity reactivation reverted");
  console.log(
    JSON.stringify(
      {
        ...summary,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        consumedValue: "0",
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
