/* global console, process */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const CHAIN_ID = 11_155_111;
const EIP170_RUNTIME_LIMIT = 24_576;
const EIP3860_INITCODE_LIMIT = 49_152;
const CHAIN = defineChain({
  id: CHAIN_ID,
  name: "Ethereum Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] },
  },
  blockExplorers: {
    default: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  },
});
const manifestLocation =
  process.env.AURKA_SEPOLIA_MANIFEST_PATH ??
  process.env.AURKA_SEPOLIA_MANIFEST ??
  "deploy/sepolia/sepolia-deployment.json";
const MANIFEST_PATH = path.isAbsolute(manifestLocation)
  ? manifestLocation
  : path.join(ROOT, manifestLocation);
const UPSTREAM_MANIFEST_PATH = path.join(
  ROOT,
  "contracts/out-upstream/manifest.json",
);

const ARTIFACTS = {
  aqua: "contracts/out-upstream/Aqua.sol/Aqua.json",
  swapVM:
    "contracts/out-upstream/AurkaUpstreamAquaSwapVMRouter.sol/AurkaUpstreamAquaSwapVMRouter.json",
  policyRegistry:
    "contracts/out/AurkaPolicyRegistry.sol/AurkaPolicyRegistry.json",
  riskRegistry: "contracts/out/RiskModeRegistry.sol/RiskModeRegistry.json",
  router:
    "contracts/out/AurkaSepoliaSwapVMRouter.sol/AurkaSepoliaSwapVMRouter.json",
  orderValidator:
    "contracts/out/AurkaSepoliaOrderValidator.sol/AurkaSepoliaOrderValidator.json",
  tradeMath:
    "contracts/out/AurkaSepoliaTradeMath.sol/AurkaSepoliaTradeMath.json",
  upstreamExecutor:
    "contracts/out/AurkaSepoliaUpstreamExecutor.sol/AurkaSepoliaUpstreamExecutor.json",
  vaultFactory:
    "contracts/out/AurkaSpaceVaultFactory.sol/AurkaSpaceVaultFactory.json",
  mockERC20: "contracts/out/MockERC20.sol/MockERC20.json",
  mockPriceOracle: "contracts/out/MockPriceOracle.sol/MockPriceOracle.json",
  chainlinkPriceOracle:
    "contracts/out/ChainlinkPriceOracle.sol/ChainlinkPriceOracle.json",
};

function absolute(relativePath) {
  return path.join(ROOT, relativePath);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function env(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function address(value, name) {
  check(
    /^0x[0-9a-fA-F]{40}$/.test(value ?? ""),
    `${name} must be a 20-byte address`,
  );
  return value;
}

function hexPrivateKey(value) {
  check(
    /^0x[0-9a-fA-F]{64}$/.test(value ?? ""),
    "AURKA_SEPOLIA_PRIVATE_KEY must be a 32-byte hex key",
  );
  return value;
}

function artifact(name) {
  const relativePath = ARTIFACTS[name];
  check(relativePath, `Unknown artifact ${name}`);
  const filePath = absolute(relativePath);
  check(
    existsSync(filePath),
    `Missing ${relativePath}; run pnpm contracts:build-upstream && forge build first`,
  );
  const value = JSON.parse(readFileSync(filePath, "utf8"));
  const bytecode = value.bytecode?.object;
  check(
    bytecode && bytecode !== "0x",
    `${relativePath} has no creation bytecode`,
  );
  return {
    abi: value.abi,
    bytecode: bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`,
    deployedBytecode: value.deployedBytecode?.object ?? "0x",
    relativePath,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bytecodeFingerprint(value) {
  const creationBytecode = value.bytecode.slice(2);
  const deployedBytecode = value.deployedBytecode.startsWith("0x")
    ? value.deployedBytecode.slice(2)
    : value.deployedBytecode;
  return {
    path: value.relativePath,
    creationBytecodeSha256: sha256Hex(Buffer.from(creationBytecode, "hex")),
    deployedBytecodeSha256: sha256Hex(
      Buffer.from(deployedBytecode || "", "hex"),
    ),
    deployedBytecodeBytes: Math.floor(deployedBytecode.length / 2),
    creationBytecodeBytes: Math.floor(creationBytecode.length / 2),
  };
}

function sizeGate(value) {
  const fingerprint = bytecodeFingerprint(value);
  return {
    ...fingerprint,
    runtimeLimit: EIP170_RUNTIME_LIMIT,
    initcodeLimit: EIP3860_INITCODE_LIMIT,
    runtimePass: fingerprint.deployedBytecodeBytes <= EIP170_RUNTIME_LIMIT,
    initcodePass: fingerprint.creationBytecodeBytes <= EIP3860_INITCODE_LIMIT,
    pass:
      fingerprint.deployedBytecodeBytes <= EIP170_RUNTIME_LIMIT &&
      fingerprint.creationBytecodeBytes <= EIP3860_INITCODE_LIMIT,
  };
}

function loadArtifacts() {
  return Object.fromEntries(
    Object.keys(ARTIFACTS).map((name) => [name, artifact(name)]),
  );
}

function loadUpstreamManifest() {
  check(
    existsSync(UPSTREAM_MANIFEST_PATH),
    "Missing contracts/out-upstream/manifest.json; run pnpm contracts:build-upstream",
  );
  return JSON.parse(readFileSync(UPSTREAM_MANIFEST_PATH, "utf8"));
}

function priceConfiguration() {
  const mode = (env("AURKA_SEPOLIA_PRICE_MODE") ?? "mock").toLowerCase();
  check(
    mode === "mock" || mode === "chainlink",
    "AURKA_SEPOLIA_PRICE_MODE must be mock or chainlink",
  );
  const usdcFeed = env("AURKA_SEPOLIA_CHAINLINK_USDC_USD");
  const ethFeed = env("AURKA_SEPOLIA_CHAINLINK_ETH_USD");
  if (mode === "chainlink") {
    address(usdcFeed, "AURKA_SEPOLIA_CHAINLINK_USDC_USD");
    address(ethFeed, "AURKA_SEPOLIA_CHAINLINK_ETH_USD");
  }
  return { mode, usdcFeed, ethFeed };
}

function staticPlan() {
  const artifacts = loadArtifacts();
  const upstream = loadUpstreamManifest();
  const prices = priceConfiguration();
  return {
    chain: {
      name: CHAIN.name,
      id: CHAIN_ID,
      explorer: CHAIN.blockExplorers.default.url,
    },
    deployment: {
      manifest: path.relative(ROOT, MANIFEST_PATH),
      writeOptIn: "AURKA_SEPOLIA_DEPLOY=true",
      privateKeyVariable: "AURKA_SEPOLIA_PRIVATE_KEY",
      priceMode: prices.mode,
    },
    oneInch: {
      aquaArtifact: ARTIFACTS.aqua,
      swapVMArtifact: ARTIFACTS.swapVM,
      upstreamManifest: upstream,
      sponsorRecommendedRelease: {
        branch: "release/1.0.2",
        commit: "32c687c2b73101fc26549e48fa1ff8a4d73afbac",
        reviewStatus:
          "comparison-required-before-claiming-production-equivalence",
      },
    },
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([name, value]) => [
        name,
        bytecodeFingerprint(value),
      ]),
    ),
    sizeChecks: {
      router: sizeGate(artifacts.router),
      upstreamSwapVM: sizeGate(artifacts.swapVM),
      vaultFactory: sizeGate(artifacts.vaultFactory),
      orderValidator: sizeGate(artifacts.orderValidator),
      tradeMath: sizeGate(artifacts.tradeMath),
      upstreamExecutor: sizeGate(artifacts.upstreamExecutor),
    },
    order: [
      "MockERC20 USDC (6 decimals)",
      "MockERC20 WETH (18 decimals)",
      "1inch Aqua",
      "AURKA upstream SwapVM wrapper",
      "AURKA policy registry",
      "AURKA risk registry",
      "AURKA Sepolia order validator and settlement math",
      "AURKA Sepolia upstream executor",
      "AURKA reduced SwapVM router",
      "upstreamExecutor.initializeRouter(router)",
      "AURKA Space vault factory",
      prices.mode === "mock"
        ? "AURKA MockPriceOracle (explicit demo pricing)"
        : "AURKA ChainlinkPriceOracle",
      "policyRegistry.setInitializationFactory(factory)",
    ],
    limitations: [
      "This profile deploys contracts and mock assets only; it does not create a Privy wallet or policy.",
      "A real Aqua strategy/trade and hosted Sepolia runtime still require funded external accounts and acceptance execution.",
      "The current upstream artifact is pinned to the repository commit recorded in contracts/out-upstream/manifest.json; release/1.0.2 equivalence is not inferred.",
      "The legacy AurkaSwapVMRouter remains an oversized local regression artifact; Sepolia uses the reduced upstream-only router and its separately deployed execution helpers.",
    ],
  };
}

async function waitForReceipt(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  check(receipt.status === "success", `${label} transaction reverted: ${hash}`);
  return receipt;
}

async function deployContract(
  walletClient,
  publicClient,
  account,
  definition,
  name,
  args,
) {
  const hash = await walletClient.deployContract({
    account,
    abi: definition.abi,
    bytecode: definition.bytecode,
    args,
  });
  const receipt = await waitForReceipt(publicClient, hash, `deploy ${name}`);
  check(
    receipt.contractAddress,
    `${name} deployment returned no contract address`,
  );
  return {
    address: receipt.contractAddress,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

async function writeContract(
  walletClient,
  publicClient,
  account,
  contract,
  functionName,
  args,
) {
  const hash = await walletClient.writeContract({
    account,
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
  const receipt = await waitForReceipt(publicClient, hash, functionName);
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
  };
}

async function deploySepolia() {
  check(
    env("AURKA_SEPOLIA_DEPLOY") === "true",
    "Refusing to broadcast: set AURKA_SEPOLIA_DEPLOY=true after reviewing the Sepolia plan",
  );
  const rpcUrl = env("AURKA_SEPOLIA_RPC_URL");
  check(rpcUrl, "AURKA_SEPOLIA_RPC_URL is required for deployment");
  const privateKey = hexPrivateKey(env("AURKA_SEPOLIA_PRIVATE_KEY"));
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(rpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: CHAIN,
    transport: http(rpcUrl),
  });
  const observedChainId = await publicClient.getChainId();
  check(
    observedChainId === CHAIN_ID,
    `RPC chain ID is ${observedChainId}, expected ${CHAIN_ID}`,
  );
  const artifacts = loadArtifacts();
  const routerSize = sizeGate(artifacts.router);
  check(
    routerSize.pass,
    `Refusing to broadcast: AURKA router is ${routerSize.deployedBytecodeBytes} bytes runtime / ${routerSize.creationBytecodeBytes} bytes initcode; EIP limits are ${EIP170_RUNTIME_LIMIT}/${EIP3860_INITCODE_LIMIT}. Reduce or split the router first`,
  );
  const prices = priceConfiguration();
  const swapVMOwner = address(
    env("AURKA_SEPOLIA_SWAPVM_OWNER_ADDRESS") ?? account.address,
    "AURKA_SEPOLIA_SWAPVM_OWNER_ADDRESS",
  );

  const contracts = {};
  const deploy = async (name, args) => {
    const result = await deployContract(
      walletClient,
      publicClient,
      account,
      artifacts[name],
      name,
      args,
    );
    contracts[name] = { ...result, abi: artifacts[name].abi };
    console.log(`${name}: ${result.address} (${result.transactionHash})`);
    return contracts[name];
  };

  const usdc = await deploy("mockERC20", ["AURKA Demo USDC", 6]);
  const weth = await deploy("mockERC20", ["AURKA Demo WETH", 18]);
  const aqua = await deploy("aqua", []);
  const swapVM = await deploy("swapVM", [
    aqua.address,
    weth.address,
    swapVMOwner,
  ]);
  const policyRegistry = await deploy("policyRegistry", []);
  const riskRegistry = await deploy("riskRegistry", [policyRegistry.address]);
  const orderValidator = await deploy("orderValidator", []);
  const tradeMath = await deploy("tradeMath", []);
  const upstreamExecutor = await deploy("upstreamExecutor", [
    swapVM.address,
    aqua.address,
    policyRegistry.address,
    orderValidator.address,
  ]);
  const router = await deploy("router", [
    policyRegistry.address,
    riskRegistry.address,
    aqua.address,
    swapVM.address,
    tradeMath.address,
    upstreamExecutor.address,
  ]);
  const executorSetup = await writeContract(
    walletClient,
    publicClient,
    account,
    { address: upstreamExecutor.address, abi: artifacts.upstreamExecutor.abi },
    "initializeRouter",
    [router.address],
  );
  console.log(`initializeRouter: ${executorSetup.transactionHash}`);
  const swapVMGuard = await publicClient.readContract({
    address: upstreamExecutor.address,
    abi: artifacts.upstreamExecutor.abi,
    functionName: "swapVMGuard",
  });
  const vaultFactory = await deploy("vaultFactory", [
    policyRegistry.address,
    router.address,
    aqua.address,
    usdc.address,
    weth.address,
  ]);
  const oracle = await deploy(
    prices.mode === "mock" ? "mockPriceOracle" : "chainlinkPriceOracle",
    prices.mode === "mock"
      ? []
      : [[usdc.address, weth.address], [prices.usdcFeed, prices.ethFeed], 0],
  );

  const factorySetup = await writeContract(
    walletClient,
    publicClient,
    account,
    { address: policyRegistry.address, abi: artifacts.policyRegistry.abi },
    "setInitializationFactory",
    [vaultFactory.address],
  );
  console.log(`setInitializationFactory: ${factorySetup.transactionHash}`);

  let priceSetup;
  if (prices.mode === "mock") {
    const block = await publicClient.getBlock({
      blockNumber: BigInt(contracts.oracle.blockNumber),
    });
    const oracleContract = {
      address: oracle.address,
      abi: artifacts.mockPriceOracle.abi,
    };
    const usdcPrice = await writeContract(
      walletClient,
      publicClient,
      account,
      oracleContract,
      "setPrice",
      [
        usdc.address,
        1n,
        0,
        block.timestamp,
        keccak256(stringToHex("aurka-sepolia-usdc-price-v1")),
      ],
    );
    const wethPrice = await writeContract(
      walletClient,
      publicClient,
      account,
      oracleContract,
      "setPrice",
      [
        weth.address,
        3200n,
        0,
        block.timestamp,
        keccak256(stringToHex("aurka-sepolia-weth-price-v1")),
      ],
    );
    priceSetup = {
      usdc: usdcPrice,
      weth: wethPrice,
      settlementPriceDecimals: 0,
    };
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    chain: {
      name: CHAIN.name,
      id: CHAIN_ID,
      explorer: CHAIN.blockExplorers.default.url,
      rpcConfigured: true,
    },
    deployer: { address: account.address },
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, value]) => [
        name,
        {
          address: value.address,
          transactionHash: value.transactionHash,
          blockNumber: value.blockNumber,
        },
      ]),
    ),
    tokens: {
      usdc: {
        address: usdc.address,
        decimals: 6,
        mock: true,
        faucet: "MockERC20.mint (operator-controlled)",
      },
      weth: {
        address: weth.address,
        decimals: 18,
        mock: true,
        faucet: "MockERC20.mint (operator-controlled)",
      },
    },
    oracle: {
      address: oracle.address,
      mode: prices.mode,
      mock: prices.mode === "mock",
      ...(prices.mode === "chainlink"
        ? { feeds: { usdcUsd: prices.usdcFeed, ethUsd: prices.ethFeed } }
        : { setup: priceSetup }),
    },
    oneInch: {
      aqua: {
        address: aqua.address,
        source: "1inch/aqua artifact",
        artifact: ARTIFACTS.aqua,
      },
      swapVM: {
        address: swapVM.address,
        source: "AURKA wrapper over pinned 1inch SwapVM artifact",
        artifact: ARTIFACTS.swapVM,
        sourceManifest: path.relative(ROOT, UPSTREAM_MANIFEST_PATH),
        sponsorRecommendedRelease:
          "release/1.0.2@32c687c2b73101fc26549e48fa1ff8a4d73afbac",
        equivalenceReviewed: false,
      },
      executionHelpers: {
        orderValidator: orderValidator.address,
        tradeMath: tradeMath.address,
        upstreamExecutor: upstreamExecutor.address,
        swapVMGuard,
        executorRouterInitialization: executorSetup.transactionHash,
      },
    },
    privy: {
      chainId: CHAIN_ID,
      router: router.address,
      inputToken: weth.address,
      outputToken: usdc.address,
      provisioning: "pending",
    },
    acceptance: {
      strategyCreated: false,
      swapVMTradeConfirmed: false,
      privyDelegatedTradeConfirmed: false,
      graphIndexed: false,
    },
    artifactFingerprints: Object.fromEntries(
      Object.entries(artifacts).map(([name, value]) => [
        name,
        bytecodeFingerprint(value),
      ]),
    ),
    safety: {
      mainnetAddressesCopied: false,
      deployerKeyStored: false,
      mockAssetsLabeled: true,
      mockPricesLabeled: prices.mode === "mock",
    },
  };
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Sepolia manifest: ${path.relative(ROOT, MANIFEST_PATH)}`);
  return manifest;
}

async function checkSepolia() {
  const plan = staticPlan();
  const rpcUrl = env("AURKA_SEPOLIA_RPC_URL");
  const report = {
    ...plan,
    checks: { artifacts: "pass", chain: "not-run", manifest: "not-found" },
  };
  if (existsSync(MANIFEST_PATH)) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    check(
      manifest.chain?.id === CHAIN_ID,
      "Sepolia manifest has the wrong chain ID",
    );
    report.checks.manifest = "pass";
    report.manifest = {
      path: path.relative(ROOT, MANIFEST_PATH),
      contracts: manifest.contracts,
      acceptance: manifest.acceptance,
    };
  }
  if (rpcUrl) {
    const client = createPublicClient({
      chain: CHAIN,
      transport: http(rpcUrl),
    });
    const chainId = await client.getChainId();
    check(
      chainId === CHAIN_ID,
      `RPC chain ID is ${chainId}, expected ${CHAIN_ID}`,
    );
    report.checks.chain = "pass";
  }
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const command = process.argv[2] ?? "plan";
  if (command === "plan") {
    console.log(JSON.stringify(staticPlan(), null, 2));
    return;
  }
  if (command === "check") {
    await checkSepolia();
    return;
  }
  if (command === "deploy") {
    await deploySepolia();
    return;
  }
  throw new Error(`Unknown command ${command}; use plan, check, or deploy`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
