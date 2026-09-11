/* global URL, console, process */

import { readFileSync, writeFileSync } from "node:fs";

import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAbiItem,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  encodeDirectProgram,
  hashAquaBalances,
  hashAssetStates,
  hashIntent,
  hashProposal,
  hex,
} from "../dist/solver/hash.js";
import {
  buildUpstreamSwapVMData,
  hashUpstreamCalldata,
} from "../dist/solver/upstream.js";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const CHAIN_ID = 11_155_111;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;

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
  const raw = requireValue("AURKA_SEPOLIA_PRIVATE_KEY").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("AURKA_SEPOLIA_PRIVATE_KEY must be a 32-byte hex key");
  }
  return `0x${raw}`;
}

function artifact(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function rawPerValue(value_, decimals, price, priceDecimals) {
  return ceilDiv(
    value_ * 10n ** BigInt(decimals) * 10n ** BigInt(priceDecimals),
    price,
  );
}

function bytes32Address(token) {
  return `0x${token.slice(2).toLowerCase().padStart(64, "0")}`;
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

function receiptClient(client, hash, label) {
  return client.waitForTransactionReceipt({ hash }).then((receipt) => {
    if (receipt.status !== "success") throw new Error(`${label} reverted`);
    return {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
    };
  });
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

function bindingName(value_) {
  return (
    [
      "NONE",
      "TRANSACTION_CAP",
      "AVAILABLE_BALANCE",
      "CAPACITY_EXHAUSTED",
      "MINIMUM_WEIGHT",
      "MAXIMUM_WEIGHT",
    ][Number(value_)] ?? "NONE"
  );
}

function asFill(value_) {
  return {
    maximumSafeFill: BigInt(value_.maximumSafeFill),
    utilizationBefore: BigInt(value_.utilizationBefore),
    utilizationAfter: BigInt(value_.utilizationAfter),
    fees: {
      feeBpsScaled: BigInt(value_.fees.feeBpsScaled),
      baseFeeAmount: BigInt(value_.fees.baseFeeAmount),
      treasuryBaseFeeAmount: BigInt(value_.fees.treasuryBaseFeeAmount),
      premiumAmount: BigInt(value_.fees.premiumAmount),
      totalFeeAmount: BigInt(value_.fees.totalFeeAmount),
      treasuryAmount: BigInt(value_.fees.treasuryAmount),
      solverAmount: BigInt(value_.fees.solverAmount),
      protocolAmount: BigInt(value_.fees.protocolAmount),
    },
    traderOutputValue: BigInt(value_.traderOutputValue),
    treasuryOutputValue: BigInt(value_.treasuryOutputValue),
    bindingConstraint: Number(value_.bindingConstraint),
    bindingAsset: value_.bindingAsset,
    postTrade: value_.postTrade.map((item) => ({
      token: item.token,
      value: BigInt(item.value),
      minimumWeightBps: Number(item.minimumWeightBps),
      maximumWeightBps: Number(item.maximumWeightBps),
    })),
  };
}

async function main() {
  const manifestPath = path.join(
    ROOT,
    value("AURKA_SEPOLIA_MANIFEST_PATH") ??
      "deploy/sepolia/sepolia-deployment.json",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.chain?.id !== CHAIN_ID)
    throw new Error("wrong Sepolia manifest");
  if (!manifest.space?.createTransactionHash) {
    throw new Error("create the Sepolia Space before running trade acceptance");
  }
  if (manifest.acceptance?.swapVMTradeConfirmed) {
    console.log(
      JSON.stringify({ reused: true, trade: manifest.acceptance }, null, 2),
    );
    return;
  }

  const rpc = requireValue("AURKA_SEPOLIA_RPC_URL");
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
  const tradeMath = address(manifest.contracts.tradeMath.address, "trade math");
  const registry = address(
    manifest.contracts.policyRegistry.address,
    "policy registry",
  );
  const oracle = address(manifest.oracle.address, "oracle");
  const aqua = address(manifest.contracts.aqua.address, "Aqua");
  const swapVM = address(manifest.contracts.swapVM.address, "SwapVM");
  const usdc = address(manifest.tokens.usdc.address, "USDC");
  const weth = address(manifest.tokens.weth.address, "WETH");
  const policyId = manifest.space.policyId;
  const positionId = manifest.space.spaceId;
  const strategyHash = manifest.space.strategyHash;
  const vault = address(manifest.space.vault, "Space vault");

  const routerArtifact = artifact(
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  );
  const tradeMathArtifact = artifact(
    "contracts/out/AurkaSepoliaTradeMath.sol/AurkaSepoliaTradeMath.json",
  );
  const registryArtifact = artifact(
    "contracts/out/AurkaPolicyRegistry.sol/AurkaPolicyRegistry.json",
  );
  const oracleArtifact = artifact(
    "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  );
  const aquaArtifact = artifact("contracts/out-upstream/Aqua.sol/Aqua.json");
  const erc20Artifact = artifact("contracts/out/MockERC20.sol/MockERC20.json");
  const oracleContract = { address: oracle, abi: oracleArtifact.abi };
  const wethContract = { address: weth, abi: erc20Artifact.abi };
  const aquaContract = { address: aqua, abi: aquaArtifact.abi };

  let latestBlock = await publicClient.getBlock();
  const refreshTransactions = {};
  for (const [token, price, label, key] of [
    [usdc, 1n, "aurka-sepolia-usdc-price-v1", "usdc"],
    [weth, 3200n, "aurka-sepolia-weth-price-v1", "weth"],
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
    refreshTransactions[key] = await receiptClient(
      publicClient,
      hash,
      `refresh ${key} price`,
    );
    latestBlock = await publicClient.getBlock();
  }

  const [usdcRaw, wethRaw, policy, state, usdcRawBalance, wethRawBalance] =
    await Promise.all([
      publicClient.readContract({
        ...oracleContract,
        functionName: "getPrice",
        args: [usdc],
      }),
      publicClient.readContract({
        ...oracleContract,
        functionName: "getPrice",
        args: [weth],
      }),
      publicClient.readContract({
        address: registry,
        abi: registryArtifact.abi,
        functionName: "getPolicy",
        args: [policyId],
      }),
      publicClient.readContract({
        address: router,
        abi: routerArtifact.abi,
        functionName: "capacityState",
        args: [positionId, weth, usdc],
      }),
      publicClient.readContract({
        ...aquaContract,
        functionName: "rawBalances",
        args: [vault, swapVM, strategyHash, usdc],
      }),
      publicClient.readContract({
        ...aquaContract,
        functionName: "rawBalances",
        args: [vault, swapVM, strategyHash, weth],
      }),
    ]);
  if (BigInt(state.consumedValue) !== 0n) {
    const tradeEvent = getAbiItem({
      abi: routerArtifact.abi,
      name: "TradeExecuted",
    });
    const latest = await publicClient.getBlockNumber();
    const first = BigInt(manifest.space.createBlockNumber ?? latest - 100n);
    const logs = [];
    for (let from = first; from <= latest; from += 10n) {
      const to = from + 9n > latest ? latest : from + 9n;
      logs.push(
        ...(await publicClient.getLogs({
          address: router,
          event: tradeEvent,
          fromBlock: from,
          toBlock: to,
        })),
      );
    }
    const tradeLog = logs
      .filter(
        (item) =>
          item.args?.policyId?.toLowerCase() === policyId.toLowerCase() &&
          item.args?.positionIdHash?.toLowerCase() === positionId.toLowerCase(),
      )
      .at(-1);
    if (!tradeLog)
      throw new Error(
        "capacity is consumed but no TradeExecuted receipt was found",
      );
    manifest.acceptance = {
      ...manifest.acceptance,
      strategyCreated: true,
      swapVMTradeConfirmed: true,
      swapVMTrade: {
        transactionHash: tradeLog.transactionHash,
        blockNumber: tradeLog.blockNumber.toString(),
        trader: tradeLog.args.trader,
        inputToken: tradeLog.args.traderInputToken,
        outputToken: tradeLog.args.traderOutputToken,
        executedValue: tradeLog.args.traderInputValue.toString(),
        outputValue: tradeLog.args.traderOutputValue.toString(),
        treasuryOutputValue: tradeLog.args.treasuryOutputValue.toString(),
        totalFeeAmount: tradeLog.args.totalFeeAmount.toString(),
        capacityEpochId: tradeLog.args.capacityEpochId,
        recovered: true,
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      JSON.stringify(
        {
          recovered: true,
          transactionHash: tradeLog.transactionHash,
          blockNumber: tradeLog.blockNumber.toString(),
          executedValue: tradeLog.args.traderInputValue.toString(),
        },
        null,
        2,
      ),
    );
    return;
  }
  const usdcPrice = snapshot(usdc, usdcRaw);
  const wethPrice = snapshot(weth, wethRaw);
  const tokens = [usdc, weth];
  const balances = [BigInt(usdcRawBalance[0]), BigInt(wethRawBalance[0])];
  const balanceSnapshot = hashAquaBalances(tokens, balances);
  const assets = [
    {
      token: usdc,
      value: (balances[0] * usdcPrice.price) / 10n ** 6n,
      minimumWeightBps: 5500,
      maximumWeightBps: 10000,
    },
    {
      token: weth,
      value: (balances[1] * wethPrice.price) / 10n ** 18n,
      minimumWeightBps: 0,
      maximumWeightBps: 4500,
    },
  ];
  const portfolioPriceSnapshot = portfolioSnapshotHash(tokens, [
    usdcPrice,
    wethPrice,
  ]);
  const requestedValue = BigInt(value("AURKA_SEPOLIA_TRADE_VALUE") ?? "5000");
  const maxTrade = BigInt(policy.maximumTransactionValue);
  const fee = {
    baseFeeBps: Number(policy.fee.baseFeeBps),
    slopeBps: Number(policy.fee.slopeBps),
    maximumFeeBps: Number(policy.fee.maximumFeeBps),
    treasuryBaseFeeBps: Number(policy.fee.treasuryBaseFeeBps),
    solverFeeBps: Number(policy.fee.solverFeeBps),
    protocolFeeBps: Number(policy.fee.protocolFeeBps),
  };
  const priceInput = {
    traderInputToken: weth,
    traderOutputToken: usdc,
    traderInputReferencePrice: wethPrice,
    traderInputExecutionPrice: wethPrice,
    traderOutputReferencePrice: usdcPrice,
    traderOutputExecutionPrice: usdcPrice,
    approvedTraderInputSnapshotId: wethPrice.snapshotId,
    approvedTraderOutputSnapshotId: usdcPrice.snapshotId,
    traderInputAmount: rawPerValue(
      requestedValue,
      18,
      wethPrice.price,
      wethPrice.priceDecimals,
    ),
    traderOutputAmount: rawPerValue(
      requestedValue,
      6,
      usdcPrice.price,
      usdcPrice.priceDecimals,
    ),
    traderInputDecimals: 18,
    traderOutputDecimals: 6,
    valueDecimals: 0,
    currentTime: latestBlock.timestamp,
    maximumPriceAgeSeconds: Number(policy.priceMaxAgeSeconds),
    maximumPriceDeviationBps: Number(policy.maximumPriceDeviationBps),
  };
  const priceSnapshot = await publicClient.readContract({
    address: router,
    abi: routerArtifact.abi,
    functionName: "priceSnapshotHash",
    args: [priceInput],
  });
  const epoch = {
    positionIdHash: positionId,
    traderInputTokenId: bytes32Address(weth),
    traderOutputTokenId: bytes32Address(usdc),
    balanceSnapshot,
    priceSnapshot,
    portfolioPriceSnapshot,
    policyNonce: BigInt(policy.nonce),
    riskCertificateHash: ZERO_HASH,
    aquaStrategyHash: strategyHash,
    capacityBaseline: BigInt(state.capacityBaselineValue),
    consumedBefore: BigInt(state.consumedValue),
    chainId: BigInt(CHAIN_ID),
    verifyingContract: router,
    capacityEpochId: ZERO_HASH,
  };
  epoch.capacityEpochId = capacityEpochId(epoch);

  const reactivateHash = await walletClient.writeContract({
    account,
    address: router,
    abi: routerArtifact.abi,
    functionName: "activateCapacityEpoch",
    args: [policyId, epoch, priceInput],
  });
  const reactivateReceipt = await receiptClient(
    publicClient,
    reactivateHash,
    "reactivate Sepolia capacity epoch",
  );

  const tradeMathArgs = [
    assets,
    weth,
    usdc,
    requestedValue,
    maxTrade,
    epoch.capacityBaseline,
    epoch.consumedBefore,
    fee,
    priceInput,
    epoch,
    latestBlock.timestamp,
  ];
  let rawFill = await publicClient.readContract({
    address: tradeMath,
    abi: tradeMathArtifact.abi,
    functionName: "maximumSafeFill",
    args: tradeMathArgs,
  });
  let fill = asFill(rawFill);
  priceInput.traderInputAmount = rawPerValue(
    fill.maximumSafeFill,
    18,
    wethPrice.price,
    wethPrice.priceDecimals,
  );
  priceInput.traderOutputAmount = rawPerValue(
    fill.treasuryOutputValue,
    6,
    usdcPrice.price,
    usdcPrice.priceDecimals,
  );
  rawFill = await publicClient.readContract({
    address: tradeMath,
    abi: tradeMathArtifact.abi,
    functionName: "maximumSafeFill",
    args: tradeMathArgs,
  });
  fill = asFill(rawFill);

  const deadline = latestBlock.timestamp + 300n;
  const intent = {
    intentId: keccak256(stringToHex(`aurka-sepolia-live-trade-${Date.now()}`)),
    policyId,
    positionIdHash: positionId,
    trader: account.address,
    traderInputToken: weth,
    traderOutputToken: usdc,
    requestedValue,
    minimumTraderOutputValue: 1n,
    exactInput: true,
    allowPartialFill: false,
    deadline,
    nonce: BigInt(Date.now()),
    balanceSnapshot,
    priceSnapshot,
    aquaStrategyHash: strategyHash,
  };
  const snapshotForHash = { chainId: CHAIN_ID, verifyingContract: router };
  const intentHash = hashIntent(intent, snapshotForHash);
  const solverFeeAmount = rawPerValue(
    fill.fees.solverAmount,
    6,
    usdcPrice.price,
    usdcPrice.priceDecimals,
  );
  const protocolFeeAmount = rawPerValue(
    fill.fees.protocolAmount,
    6,
    usdcPrice.price,
    usdcPrice.priceDecimals,
  );
  const proposal = {
    intentHash,
    solver: account.address,
    balancesHash: balanceSnapshot,
    priceSnapshotHash: priceSnapshot,
    policyNonce: BigInt(policy.nonce),
    riskCertificateHash: ZERO_HASH,
    traderInputToken: weth,
    traderOutputToken: usdc,
    traderInputAmount: priceInput.traderInputAmount,
    traderOutputAmount:
      priceInput.traderOutputAmount - solverFeeAmount - protocolFeeAmount,
    solverFeeAmount,
    protocolFeeAmount,
    traderInputValue: fill.maximumSafeFill,
    traderOutputValue: fill.traderOutputValue,
    treasuryOutputValue: fill.treasuryOutputValue,
    feeBpsScaled: fill.fees.feeBpsScaled,
    baseFeeAmount: fill.fees.baseFeeAmount,
    treasuryBaseFeeAmount: fill.fees.treasuryBaseFeeAmount,
    optionSpacePremiumAmount: fill.fees.premiumAmount,
    totalFeeAmount: fill.fees.totalFeeAmount,
    treasuryAmount: fill.fees.treasuryAmount,
    solverAmount: fill.fees.solverAmount,
    protocolAmount: fill.fees.protocolAmount,
    feeToken: usdc,
    feePaymentMode: 0,
    initialPortfolioHash: hashAssetStates(assets),
    capacityBaselineValue: epoch.capacityBaseline,
    consumedBefore: epoch.consumedBefore,
    consumedAfter: epoch.consumedBefore + fill.maximumSafeFill,
    capacityEpochId: epoch.capacityEpochId,
    utilizationBefore: fill.utilizationBefore,
    utilizationAfter: fill.utilizationAfter,
    bindingConstraint: fill.bindingConstraint,
    bindingAsset: fill.bindingAsset ?? ZERO_ADDRESS,
    expectedPostStateHash: hashAssetStates(fill.postTrade),
    aquaStrategyHash: strategyHash,
    swapVMCalldataHash: ZERO_HASH,
    deadline,
  };
  const proposalHashInput = {
    ...proposal,
    bindingConstraint: bindingName(fill.bindingConstraint),
  };
  const snapshotForUpstream = {
    chainId: CHAIN_ID,
    verifyingContract: router,
    aquaStrategyHash: strategyHash,
    swapVMGuard: manifest.oneInch.executionHelpers.swapVMGuard,
    feeAccounting: { treasuryRecipient: vault },
    portfolio: {
      assets: assets.map((item, index) => ({
        ...item,
        balance: balances[index],
        decimals: index === 0 ? 6 : 18,
        price: index === 0 ? usdcPrice.price : wethPrice.price,
        priceDecimals:
          index === 0 ? usdcPrice.priceDecimals : wethPrice.priceDecimals,
      })),
    },
    priceProtection: {
      traderOutputDecimals: 6,
      traderOutputExecutionPrice: usdcPrice,
    },
  };
  const upstream = buildUpstreamSwapVMData(
    intent,
    proposalHashInput,
    snapshotForUpstream,
  );
  const directProgram = hex(
    encodeDirectProgram({
      policyId,
      positionIdHash: positionId,
      trader: account.address,
      inputToken: weth,
      outputToken: usdc,
      strategyHash,
      inputAmount: proposal.traderInputAmount,
      traderOutputAmount: proposal.traderOutputAmount,
      solverFeeAmount,
      protocolFeeAmount,
      inputValue: proposal.traderInputValue,
      traderOutputValue: proposal.traderOutputValue,
      treasuryOutputValue: proposal.treasuryOutputValue,
      capacityEpochId: epoch.capacityEpochId,
      intentHash,
    }),
  );
  proposal.swapVMCalldataHash = hashUpstreamCalldata(directProgram, upstream);
  const proposalHash = hashProposal(
    { ...proposal, bindingConstraint: bindingName(fill.bindingConstraint) },
    snapshotForHash,
  );
  const intentSignature = await account.sign({ hash: intentHash });
  const proposalSignature = await account.sign({ hash: proposalHash });

  const inputBalance = await publicClient.readContract({
    ...wethContract,
    functionName: "balanceOf",
    args: [account.address],
  });
  if (inputBalance < proposal.traderInputAmount) {
    const mintHash = await walletClient.writeContract({
      account,
      ...wethContract,
      functionName: "mint",
      args: [account.address, proposal.traderInputAmount - inputBalance],
    });
    await receiptClient(publicClient, mintHash, "mint trade input");
  }
  const approveHash = await walletClient.writeContract({
    account,
    ...wethContract,
    functionName: "approve",
    args: [router, proposal.traderInputAmount],
  });
  const approveReceipt = await receiptClient(
    publicClient,
    approveHash,
    "approve router input",
  );
  const tradeHash = await walletClient.writeContract({
    account,
    address: router,
    abi: routerArtifact.abi,
    functionName: "executeWithSwapVM",
    args: [
      intent,
      intentSignature,
      proposal,
      proposalSignature,
      assets,
      epoch,
      priceInput,
      directProgram,
      BigInt(upstream.makerTraits),
      upstream.orderData,
      upstream.takerTraitsAndData,
    ],
  });
  const tradeReceipt = await receiptClient(
    publicClient,
    tradeHash,
    "Sepolia SwapVM trade",
  );
  manifest.acceptance = {
    ...manifest.acceptance,
    strategyCreated: true,
    swapVMTradeConfirmed: true,
    swapVMTrade: {
      transactionHash: tradeReceipt.transactionHash,
      blockNumber: tradeReceipt.blockNumber,
      trader: account.address,
      solver: account.address,
      inputToken: weth,
      outputToken: usdc,
      executedValue: fill.maximumSafeFill.toString(),
      inputAmount: proposal.traderInputAmount.toString(),
      outputAmount: proposal.traderOutputAmount.toString(),
      capacityEpochId: epoch.capacityEpochId,
      reactivateTransactionHash: reactivateReceipt.transactionHash,
      reactivateBlockNumber: reactivateReceipt.blockNumber,
      approvalTransactionHash: approveReceipt.transactionHash,
      approvalBlockNumber: approveReceipt.blockNumber,
      priceRefreshTransactions: refreshTransactions,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        trader: account.address,
        transactionHash: tradeReceipt.transactionHash,
        blockNumber: tradeReceipt.blockNumber,
        executedValue: fill.maximumSafeFill.toString(),
        inputAmount: proposal.traderInputAmount.toString(),
        outputAmount: proposal.traderOutputAmount.toString(),
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
