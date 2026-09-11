/* global URL, console, process */

import { readFileSync, writeFileSync } from "node:fs";

import path from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../..",
);
const CHAIN_ID = 11_155_111;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const EIP712_MAKER_TRAITS =
  (1n << 254n) |
  (1n << 250n) |
  (1n << 246n) |
  (60n << 208n) |
  (60n << 192n) |
  (40n << 176n) |
  (40n << 160n);

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

function word(value_) {
  return toHex(value_, { size: 32 });
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
  if (manifest.space?.createTransactionHash) {
    console.log(
      JSON.stringify(
        {
          reused: true,
          space: manifest.space,
        },
        null,
        2,
      ),
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

  const usdc = address(manifest.tokens.usdc.address, "USDC address");
  const weth = address(manifest.tokens.weth.address, "WETH address");
  const router = address(manifest.contracts.router.address, "router address");
  const factory = address(
    manifest.contracts.vaultFactory.address,
    "vault factory address",
  );
  const oracle = address(manifest.oracle.address, "oracle address");
  const guard = address(
    manifest.oneInch.executionHelpers.swapVMGuard,
    "SwapVM guard address",
  );
  const aqua = address(manifest.contracts.aqua.address, "Aqua address");

  const tokenArtifact = artifact("contracts/out/MockERC20.sol/MockERC20.json");
  const oracleArtifact = artifact(
    "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  );
  const routerArtifact = artifact(
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  );
  const factoryArtifact = artifact(
    "contracts/out/AurkaSpaceVaultFactory.sol/AurkaSpaceVaultFactory.json",
  );
  const erc20 = { abi: tokenArtifact.abi };
  const usdcContract = { address: usdc, ...erc20 };
  const wethContract = { address: weth, ...erc20 };
  const oracleContract = { address: oracle, abi: oracleArtifact.abi };

  const spaceId = value("AURKA_SEPOLIA_SPACE_ID")
    ? value("AURKA_SEPOLIA_SPACE_ID")
    : keccak256(stringToHex("aurka-sepolia-space-v1"));
  const policyId = value("AURKA_SEPOLIA_POLICY_ID")
    ? value("AURKA_SEPOLIA_POLICY_ID")
    : keccak256(stringToHex("aurka-sepolia-policy-v1"));
  const usdcAmount = BigInt(
    value("AURKA_SEPOLIA_SPACE_USDC_AMOUNT") ?? "60000000000",
  );
  const wethAmount = BigInt(
    value("AURKA_SEPOLIA_SPACE_WETH_AMOUNT") ?? "12500000000000000000",
  );
  const maximumTransactionValue = BigInt(
    value("AURKA_SEPOLIA_MAX_TRADE_VALUE") ?? "5000",
  );
  if (usdcAmount <= 0n || wethAmount <= 0n || maximumTransactionValue <= 0n) {
    throw new Error("Space funding and trade cap must be positive");
  }

  const priceRefreshTransactions = {};
  let latestBlock = await publicClient.getBlock();
  if (manifest.oracle.mode === "mock") {
    const refreshPrice = async (token, price, snapshotLabel, key) => {
      const hash = await walletClient.writeContract({
        account,
        ...oracleContract,
        functionName: "setPrice",
        args: [
          token,
          price,
          0,
          latestBlock.timestamp,
          keccak256(stringToHex(snapshotLabel)),
        ],
      });
      priceRefreshTransactions[key] = await receiptClient(
        publicClient,
        hash,
        `refresh ${key} price`,
      );
      latestBlock = await publicClient.getBlock();
    };
    await refreshPrice(usdc, 1n, "aurka-sepolia-usdc-price-v1", "usdc");
    await refreshPrice(weth, 3200n, "aurka-sepolia-weth-price-v1", "weth");
  }
  const [usdcRaw, wethRaw] = await Promise.all([
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
  ]);
  const usdcPrice = snapshot(usdc, usdcRaw);
  const wethPrice = snapshot(weth, wethRaw);
  const priceSnapshots = [usdcPrice, wethPrice];

  const vault = await publicClient.readContract({
    address: factory,
    abi: factoryArtifact.abi,
    functionName: "vaultAddress",
    args: [account.address, spaceId],
  });
  const tokenA = weth.toLowerCase() < usdc.toLowerCase() ? weth : usdc;
  const tokenB = tokenA.toLowerCase() === weth.toLowerCase() ? usdc : weth;
  const inputUnit = rawPerValue(
    1n,
    18,
    wethPrice.price,
    wethPrice.priceDecimals,
  );
  const outputUnit = rawPerValue(
    1n,
    6,
    usdcPrice.price,
    usdcPrice.priceDecimals,
  );
  const scaledOutput = outputUnit * 1_000_000n + 1n;
  const scaledInput = inputUnit * 1_000_000n;
  const program = concatHex([
    "0x9040",
    word(
      tokenA.toLowerCase() === usdc.toLowerCase() ? scaledOutput : scaledInput,
    ),
    word(
      tokenB.toLowerCase() === usdc.toLowerCase() ? scaledOutput : scaledInput,
    ),
    "0x5301",
    tokenA.toLowerCase() === weth.toLowerCase() ? "0x80" : "0x00",
  ]);
  const orderData = concatHex([tokenA, tokenB, guard, program]);
  const strategy = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    [{ maker: vault, traits: EIP712_MAKER_TRAITS, data: orderData }],
  );
  const strategyHash = keccak256(strategy);
  const balanceSnapshot = keccak256(
    encodeAbiParameters(
      [{ type: "address[]" }, { type: "uint256[]" }],
      [
        [usdc, weth],
        [usdcAmount, wethAmount],
      ],
    ),
  );
  const portfolioPriceSnapshot = keccak256(
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
      [[usdc, weth], priceSnapshots],
    ),
  );
  const tradeInputAmount = rawPerValue(
    maximumTransactionValue,
    18,
    wethPrice.price,
    wethPrice.priceDecimals,
  );
  const tradeOutputAmount = rawPerValue(
    maximumTransactionValue,
    6,
    usdcPrice.price,
    usdcPrice.priceDecimals,
  );
  const priceInput = {
    traderInputToken: weth,
    traderOutputToken: usdc,
    traderInputReferencePrice: wethPrice,
    traderInputExecutionPrice: wethPrice,
    traderOutputReferencePrice: usdcPrice,
    traderOutputExecutionPrice: usdcPrice,
    approvedTraderInputSnapshotId: wethPrice.snapshotId,
    approvedTraderOutputSnapshotId: usdcPrice.snapshotId,
    traderInputAmount: tradeInputAmount,
    traderOutputAmount: tradeOutputAmount,
    traderInputDecimals: 18,
    traderOutputDecimals: 6,
    valueDecimals: 0,
    currentTime: latestBlock.timestamp,
    maximumPriceAgeSeconds: 120,
    maximumPriceDeviationBps: 100,
  };
  const priceSnapshotHash = await publicClient.readContract({
    address: router,
    abi: routerArtifact.abi,
    functionName: "priceSnapshotHash",
    args: [priceInput],
  });
  const capacityEpoch = {
    positionIdHash: spaceId,
    traderInputTokenId: bytes32Address(weth),
    traderOutputTokenId: bytes32Address(usdc),
    balanceSnapshot,
    priceSnapshot: priceSnapshotHash,
    portfolioPriceSnapshot,
    // createPolicyFromFactory starts at nonce 1, then increments once for
    // settlement configuration and once for price protection.
    policyNonce: 3n,
    riskCertificateHash: ZERO_HASH,
    aquaStrategyHash: strategyHash,
    capacityBaseline: 0n,
    consumedBefore: 0n,
    chainId: BigInt(CHAIN_ID),
    verifyingContract: router,
    capacityEpochId: ZERO_HASH,
  };
  const assets = [
    {
      token: usdc,
      decimals: 6,
      minimumWeightBps: 5500,
      maximumWeightBps: 10000,
    },
    { token: weth, decimals: 18, minimumWeightBps: 0, maximumWeightBps: 4500 },
  ];
  const fee = {
    baseFeeBps: 20,
    slopeBps: 80,
    maximumFeeBps: 100,
    treasuryBaseFeeBps: 10,
    solverFeeBps: 5,
    protocolFeeBps: 5,
    treasuryFeeRecipient: vault,
    protocolFeeRecipient: account.address,
  };

  const [usdcBalance, wethBalance, usdcAllowance, wethAllowance] =
    await Promise.all([
      publicClient.readContract({
        ...usdcContract,
        functionName: "balanceOf",
        args: [account.address],
      }),
      publicClient.readContract({
        ...wethContract,
        functionName: "balanceOf",
        args: [account.address],
      }),
      publicClient.readContract({
        ...usdcContract,
        functionName: "allowance",
        args: [account.address, factory],
      }),
      publicClient.readContract({
        ...wethContract,
        functionName: "allowance",
        args: [account.address, factory],
      }),
    ]);
  const setupTransactions = { priceRefresh: priceRefreshTransactions };
  if (usdcBalance < usdcAmount) {
    const hash = await walletClient.writeContract({
      account,
      ...usdcContract,
      functionName: "mint",
      args: [account.address, usdcAmount - usdcBalance],
    });
    setupTransactions.mintUsdc = await receiptClient(
      publicClient,
      hash,
      "mint USDC",
    );
  }
  if (wethBalance < wethAmount) {
    const hash = await walletClient.writeContract({
      account,
      ...wethContract,
      functionName: "mint",
      args: [account.address, wethAmount - wethBalance],
    });
    setupTransactions.mintWeth = await receiptClient(
      publicClient,
      hash,
      "mint WETH",
    );
  }
  if (usdcAllowance < usdcAmount) {
    const hash = await walletClient.writeContract({
      account,
      ...usdcContract,
      functionName: "approve",
      args: [factory, usdcAmount],
    });
    setupTransactions.approveUsdc = await receiptClient(
      publicClient,
      hash,
      "approve USDC",
    );
  }
  if (wethAllowance < wethAmount) {
    const hash = await walletClient.writeContract({
      account,
      ...wethContract,
      functionName: "approve",
      args: [factory, wethAmount],
    });
    setupTransactions.approveWeth = await receiptClient(
      publicClient,
      hash,
      "approve WETH",
    );
  }
  const createSpace = await walletClient.writeContract({
    account,
    address: factory,
    abi: factoryArtifact.abi,
    functionName: "createAndInitializeSpace",
    args: [
      {
        spaceId,
        policyId,
        strategyHash,
        strategy,
        owner: account.address,
        usdcAmount,
        wethAmount,
        assets,
        maximumTransactionValue,
        fee,
        priceOracle: oracle,
        priceMaxAgeSeconds: 120,
        maximumPriceDeviationBps: 100,
        capacityEpoch,
        priceInput,
      },
    ],
  });
  const createReceipt = await receiptClient(
    publicClient,
    createSpace,
    "create and initialize Sepolia Space",
  );
  const code = await publicClient.getCode({ address: vault });
  if (!code || code === "0x")
    throw new Error("Space vault has no deployed code");
  manifest.space = {
    spaceId,
    policyId,
    owner: account.address,
    vault,
    strategyHash,
    strategy,
    aqua,
    funding: {
      usdcAmount: usdcAmount.toString(),
      wethAmount: wethAmount.toString(),
    },
    maximumTransactionValue: maximumTransactionValue.toString(),
    setupTransactions,
    createTransactionHash: createReceipt.transactionHash,
    createBlockNumber: createReceipt.blockNumber,
  };
  manifest.acceptance = {
    ...manifest.acceptance,
    strategyCreated: true,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        owner: account.address,
        spaceId,
        policyId,
        vault,
        strategyHash,
        createTransactionHash: createReceipt.transactionHash,
        createBlockNumber: createReceipt.blockNumber,
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
