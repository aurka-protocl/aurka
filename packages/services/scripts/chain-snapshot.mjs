import assert from "node:assert/strict";
import {
  calculateAssetValueExact,
  calculatePortfolioValuation,
  computeCapacityEpochId,
  computePortfolioPriceSnapshotHash,
  computeSettlementPriceSnapshotHash,
} from "@aurka/shared";
import {
  ServiceError,
  hashBytes,
  hashCanonical,
  hashAquaBalances,
} from "../dist/index.js";
export const CHAIN_ID = 31337;
export const POSITION_ID = "position:local-settlement-e2e";
export const POLICY_ID = hashBytes("policy:local-settlement-e2e");
export const POSITION_ID_HASH = hashBytes(POSITION_ID);
export const STRATEGY_HASH = hashBytes("strategy:local-settlement-e2e");
const ZERO_HASH = `0x${"00".repeat(32)}`;
const MAX_VALUE = 50000n;
export const DEFAULT_SPACE = {
  positionId: POSITION_ID,
  policyId: POLICY_ID,
  positionIdHash: POSITION_ID_HASH,
  strategyHash: STRATEGY_HASH,
};
export const SECOND_SPACE = {
  positionId: "position:local-settlement-e2e-secondary",
  policyId: hashBytes("policy:local-settlement-e2e-secondary"),
  positionIdHash: hashBytes("position:local-settlement-e2e-secondary"),
  strategyHash: hashBytes("strategy:local-settlement-e2e-secondary"),
};
function check(condition, message) {
  assert.ok(condition, message);
}
async function read(client, contract, functionName, args) {
  return client.readContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  });
}
function asObject(value, index, field) {
  if (value && typeof value === "object" && field in value) return value[field];
  return value?.[index];
}

function bytes32Address(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function pow10(decimals) {
  return 10n ** BigInt(decimals);
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function valueToRaw(value, asset) {
  return ceilDiv(
    value * pow10(asset.decimals) * pow10(asset.priceDecimals),
    asset.price * pow10(0),
  );
}

export function policyFrom(raw) {
  const fee = raw?.fee ?? raw?.[9];
  return {
    treasury: asObject(raw, 0, "treasury"),
    governance: asObject(raw, 1, "governance"),
    maximumTransactionValue: BigInt(
      asObject(raw, 3, "maximumTransactionValue"),
    ),
    nonce: BigInt(asObject(raw, 4, "nonce")),
    priceMaxAgeSeconds: Number(asObject(raw, 5, "priceMaxAgeSeconds")),
    maximumPriceDeviationBps: Number(
      asObject(raw, 6, "maximumPriceDeviationBps"),
    ),
    paused: Boolean(asObject(raw, 7, "paused")),
    fee: {
      baseFeeBps: Number(asObject(fee, 0, "baseFeeBps")),
      slopeBps: Number(asObject(fee, 1, "slopeBps")),
      maximumFeeBps: Number(asObject(fee, 2, "maximumFeeBps")),
      treasuryBaseFeeBps: Number(asObject(fee, 3, "treasuryBaseFeeBps")),
      solverFeeBps: Number(asObject(fee, 4, "solverFeeBps")),
      protocolFeeBps: Number(asObject(fee, 5, "protocolFeeBps")),
      treasuryFeeRecipient: asObject(fee, 6, "treasuryFeeRecipient"),
      protocolFeeRecipient: asObject(fee, 7, "protocolFeeRecipient"),
    },
  };
}

export class LocalChainSnapshotProvider {
  constructor(
    publicClient,
    contracts,
    solverAddress,
    space = DEFAULT_SPACE,
    chainId = CHAIN_ID,
  ) {
    this.publicClient = publicClient;
    this.contracts = contracts;
    this.solverAddress = solverAddress;
    this.space = space;
    this.chainId = chainId;
  }

  async getPositionSnapshot(positionId) {
    const snapshot = await this.currentSnapshot();
    if (positionId !== snapshot.positionId)
      throw new ServiceError("INVALID_SNAPSHOT", "Unknown local position");
    return snapshot;
  }

  async prepareIntent(input) {
    const snapshot = await this.currentSnapshot();
    if (input.positionId !== snapshot.positionId)
      throw new ServiceError("INVALID_SNAPSHOT", "Unknown local position");
    const intent = {
      intentId: hashBytes(JSON.stringify(input)),
      policyId: snapshot.policyId,
      positionIdHash: this.space.positionIdHash,
      trader: input.trader,
      traderInputToken: input.traderInputToken,
      traderOutputToken: input.traderOutputToken,
      requestedValue: input.requestedValue,
      minimumTraderOutputValue: input.minimumTraderOutputValue,
      exactInput: false,
      allowPartialFill: true,
      deadline: input.deadline,
      nonce: input.nonce,
      balanceSnapshot: snapshot.balancesHash,
      priceSnapshot: computeSettlementPriceSnapshotHash(
        snapshot.priceProtection,
      ),
      aquaStrategyHash: snapshot.aquaStrategyHash,
    };
    await this.getSnapshot(intent);
    return intent;
  }

  async prepareTokenIntent(input) {
    const snapshot = await this.currentSnapshot();
    if (input.positionId !== snapshot.positionId)
      throw new ServiceError("INVALID_SNAPSHOT", "Unknown local position");
    const asset = snapshot.portfolio.assets.find(
      (candidate) =>
        candidate.token.toLowerCase() === input.traderInputToken.toLowerCase(),
    );
    if (!asset)
      throw new ServiceError(
        "INVALID_SNAPSHOT",
        "The selected input token is not managed by this Space",
      );
    let requestedValue;
    try {
      requestedValue = calculateAssetValueExact(
        {
          balance: input.requestedTraderInputAmount,
          decimals: asset.decimals,
          price: asset.price,
          priceDecimals: asset.priceDecimals,
        },
        snapshot.portfolio.valueDecimals,
      );
    } catch (error) {
      throw new ServiceError(
        "UNREPRESENTABLE_AMOUNT",
        error instanceof Error
          ? error.message
          : "Token amount cannot be represented in settlement value units",
        400,
      );
    }
    if (requestedValue === 0n)
      throw new ServiceError(
        "UNREPRESENTABLE_AMOUNT",
        "Enter a larger token amount; it is below one settlement value unit",
        400,
      );
    return this.prepareIntent({
      positionId: input.positionId,
      trader: input.trader,
      traderInputToken: input.traderInputToken,
      traderOutputToken: input.traderOutputToken,
      requestedValue: requestedValue.toString(),
      minimumTraderOutputValue: input.minimumTraderOutputValue,
      nonce: input.nonce,
      deadline: input.deadline,
    });
  }

  async getSnapshot(intent) {
    const snapshot = await this.currentSnapshot();
    if (intent.policyId.toLowerCase() !== snapshot.policyId.toLowerCase())
      throw new ServiceError("INVALID_SNAPSHOT", "Unknown policy");
    if (
      intent.positionIdHash.toLowerCase() !==
      this.space.positionIdHash.toLowerCase()
    )
      throw new ServiceError("INVALID_SNAPSHOT", "Unknown position");
    if (
      intent.aquaStrategyHash.toLowerCase() !==
      snapshot.aquaStrategyHash.toLowerCase()
    )
      throw new ServiceError("INVALID_SNAPSHOT", "Unauthorized Aqua strategy");
    if (
      intent.traderInputToken.toLowerCase() !==
        snapshot.capacityEpoch.traderInputToken.toLowerCase() ||
      intent.traderOutputToken.toLowerCase() !==
        snapshot.capacityEpoch.traderOutputToken.toLowerCase()
    )
      throw new ServiceError(
        "INVALID_SNAPSHOT",
        "Unsupported local settlement direction",
      );
    if (
      intent.balanceSnapshot.toLowerCase() !==
      snapshot.balancesHash.toLowerCase()
    )
      throw new ServiceError("INVALID_SNAPSHOT", "Balance snapshot is stale");
    if (
      intent.priceSnapshot.toLowerCase() !==
      computeSettlementPriceSnapshotHash(snapshot.priceProtection).toLowerCase()
    )
      throw new ServiceError("INVALID_SNAPSHOT", "Price snapshot is stale");
    return snapshot;
  }

  async currentSnapshot() {
    const { policyRegistry, aqua, oracle, router, erc20Abi } = this.contracts;
    const block = await this.publicClient.getBlock();
    const pinnedClient = {
      readContract: (request) =>
        this.publicClient.readContract({
          ...request,
          blockNumber: block.number,
        }),
    };
    const rawPolicy = await read(pinnedClient, policyRegistry, "getPolicy", [
      this.space.policyId,
    ]);
    const chainPolicy = policyFrom(rawPolicy);
    const tokenAddresses = await read(pinnedClient, policyRegistry, "assets", [
      this.space.policyId,
    ]);
    const fee = chainPolicy.fee;
    const aquaApp = await read(pinnedClient, router, "aquaApp", []);
    const managedAssets = [];
    const prices = [];
    const balances = [];
    for (const tokenAddress of tokenAddresses) {
      const symbol = await read(
        pinnedClient,
        { address: tokenAddress, abi: erc20Abi },
        "symbol",
      );
      const boundsRaw = await read(
        pinnedClient,
        policyRegistry,
        "assetBounds",
        [this.space.policyId, tokenAddress],
      );
      const priceRaw = await read(pinnedClient, oracle, "getPrice", [
        tokenAddress,
      ]);
      const balanceRaw = await read(pinnedClient, aqua, "rawBalances", [
        chainPolicy.treasury,
        aquaApp,
        this.space.strategyHash,
        tokenAddress,
      ]);
      const bounds = {
        decimals: Number(asObject(boundsRaw, 0, "decimals")),
        minimumWeightBps: Number(asObject(boundsRaw, 1, "minimumWeightBps")),
        maximumWeightBps: Number(asObject(boundsRaw, 2, "maximumWeightBps")),
      };
      const price = {
        token: tokenAddress,
        snapshotId: asObject(priceRaw, 3, "snapshotId"),
        price: BigInt(asObject(priceRaw, 0, "price")),
        priceDecimals: Number(asObject(priceRaw, 1, "priceDecimals")),
        observedAt: Number(asObject(priceRaw, 2, "observedAt")),
      };
      const balance = BigInt(asObject(balanceRaw, 0, "balance"));
      managedAssets.push({
        token: tokenAddress,
        symbol,
        balance,
        decimals: bounds.decimals,
        price: price.price,
        priceDecimals: price.priceDecimals,
        minimumWeightBps: bounds.minimumWeightBps,
        maximumWeightBps: bounds.maximumWeightBps,
      });
      prices.push(price);
      balances.push(balance);
    }
    const portfolio = calculatePortfolioValuation(managedAssets, 0);
    const inputAsset = managedAssets.find(
      (asset) => asset.token.toLowerCase() === tokenAddresses[1].toLowerCase(),
    );
    const outputAsset = managedAssets.find(
      (asset) => asset.token.toLowerCase() === tokenAddresses[0].toLowerCase(),
    );
    check(inputAsset && outputAsset, "Local settlement pair is not managed");
    const inputPrice = prices.find(
      (price) => price.token.toLowerCase() === inputAsset.token.toLowerCase(),
    );
    const outputPrice = prices.find(
      (price) => price.token.toLowerCase() === outputAsset.token.toLowerCase(),
    );
    check(inputPrice && outputPrice, "Local settlement prices are incomplete");
    const blockTimestamp = Number(block.timestamp);
    const priceProtection = {
      traderInputReferencePrice: inputPrice,
      traderInputExecutionPrice: inputPrice,
      traderOutputReferencePrice: outputPrice,
      traderOutputExecutionPrice: outputPrice,
      approvedTraderInputSnapshotId: inputPrice.snapshotId,
      approvedTraderOutputSnapshotId: outputPrice.snapshotId,
      // These provisional values are replaced by the proposal-specific raw
      // amounts in buildRouterTransactionRequest. They are still derived from
      // the deployed token scales and approved prices.
      traderInputAmount: valueToRaw(MAX_VALUE, inputAsset),
      traderOutputAmount: valueToRaw(MAX_VALUE, outputAsset),
      traderInputDecimals: inputAsset.decimals,
      traderOutputDecimals: outputAsset.decimals,
      valueDecimals: 0,
      nowSeconds: blockTimestamp,
      maximumPriceAgeSeconds: chainPolicy.priceMaxAgeSeconds,
      maximumPriceDeviationBps: chainPolicy.maximumPriceDeviationBps,
    };
    const priceSnapshot = computeSettlementPriceSnapshotHash(priceProtection);
    const portfolioPriceSnapshot = computePortfolioPriceSnapshotHash(prices);
    const balancesHash = hashAquaBalances(
      managedAssets.map((asset) => asset.token),
      balances,
    );
    const capacityEpoch = {
      positionId: this.space.positionId,
      traderInputToken: inputAsset.token,
      traderOutputToken: outputAsset.token,
      balanceSnapshot: balancesHash,
      priceSnapshot,
      portfolioPriceSnapshot,
      policyNonce: chainPolicy.nonce,
      riskCertificateHash: ZERO_HASH,
      aquaStrategyHash: this.space.strategyHash,
      capacityBaselineValue: chainPolicy.maximumTransactionValue,
      consumedBefore: 0n,
      chainId: BigInt(this.chainId),
      verifyingContract: router.address,
    };
    const portfolioSnapshot = {
      positionId: this.space.positionId,
      blockNumber: block.number.toString(),
      observedAt: blockTimestamp,
      nav: portfolio.nav.toString(),
      valueDecimals: portfolio.valueDecimals,
      assets: portfolio.assets.map((asset) => ({
        token: asset.token,
        symbol: asset.symbol,
        decimals: asset.decimals,
        balance: asset.balance.toString(),
        price: asset.price.toString(),
        priceDecimals: asset.priceDecimals,
        value: asset.value.toString(),
        weightBps: Number(asset.weightBps),
      })),
      snapshotHash: hashCanonical(portfolio),
    };
    return {
      positionId: this.space.positionId,
      chainId: this.chainId,
      verifyingContract: router.address,
      policyId: this.space.policyId,
      policy: {
        maximumTransactionValue: chainPolicy.maximumTransactionValue,
        assets: managedAssets.map((asset) => ({
          token: asset.token,
          minimumWeightBps: asset.minimumWeightBps,
          maximumWeightBps: asset.maximumWeightBps,
        })),
      },
      fee: {
        baseFeeBps: fee.baseFeeBps,
        slopeBps: fee.slopeBps,
        maximumFeeBps: fee.maximumFeeBps,
        treasuryBaseFeeBps: fee.treasuryBaseFeeBps,
        solverFeeBps: fee.solverFeeBps,
        protocolFeeBps: fee.protocolFeeBps,
      },
      feeAccounting: {
        feeToken: outputAsset.token,
        feePaymentMode: "OUTPUT_TOKEN",
        treasuryRecipient: chainPolicy.treasury,
        solverRecipient: this.solverAddress,
        protocolRecipient: fee.protocolFeeRecipient,
      },
      riskMode: "NORMAL",
      riskCertificateHash: ZERO_HASH,
      policyNonce: chainPolicy.nonce.toString(),
      paused: chainPolicy.paused,
      chainPolicy,
      portfolio,
      portfolioSnapshot,
      capacityEpoch,
      capacityEpochId: computeCapacityEpochId(capacityEpoch),
      priceProtection,
      snapshotBlock: block.number,
      aquaStrategyHash: this.space.strategyHash,
      aquaApp,
      balancesHash,
      rawAmountsForValue: (traderInputValue, treasuryOutputValue) => ({
        traderInputAmount: valueToRaw(traderInputValue, inputAsset),
        traderOutputAmount: valueToRaw(treasuryOutputValue, outputAsset),
      }),
      outputAmountForValue: (value) => valueToRaw(value, outputAsset),
    };
  }
}

export function positionForSnapshot(snapshot, registry, treasury) {
  return {
    id: snapshot.positionId,
    name: "AURKA local settlement E2E treasury",
    chainId: snapshot.chainId,
    owner: snapshot.chainPolicy.governance,
    treasury: snapshot.chainPolicy.treasury ?? treasury,
    policy: {
      id: snapshot.policyId,
      chainId: snapshot.chainId,
      registry,
      treasury: snapshot.chainPolicy.treasury ?? treasury,
      governance: snapshot.chainPolicy.governance,
      assets: snapshot.portfolio.assets.map((asset) => ({
        token: asset.token,
        symbol: asset.symbol ?? "ASSET",
        decimals: asset.decimals,
        minimumWeightBps: Number(asset.minimumWeightBps),
        maximumWeightBps: Number(asset.maximumWeightBps),
      })),
      maximumTransactionValue:
        snapshot.policy.maximumTransactionValue.toString(),
      quoteTtlSeconds: 60,
      priceMaxAgeSeconds: snapshot.priceProtection.maximumPriceAgeSeconds,
      maximumPriceDeviationBps: Number(
        snapshot.priceProtection.maximumPriceDeviationBps,
      ),
      fee: {
        baseFeeBps: Number(snapshot.fee.baseFeeBps),
        slopeBps: Number(snapshot.fee.slopeBps),
        maximumFeeBps: Number(snapshot.fee.maximumFeeBps),
        treasuryBaseFeeBps: Number(snapshot.fee.treasuryBaseFeeBps),
        solverFeeBps: Number(snapshot.fee.solverFeeBps),
        protocolFeeBps: Number(snapshot.fee.protocolFeeBps),
        treasuryFeeRecipient: snapshot.chainPolicy.fee.treasuryFeeRecipient,
        protocolFeeRecipient: snapshot.feeAccounting.protocolRecipient,
      },
      nonce: snapshot.policyNonce,
      paused: snapshot.chainPolicy.paused,
    },
    riskMode: "NORMAL",
    currentPortfolio: snapshot.portfolioSnapshot,
    createdAt: snapshot.priceProtection.nowSeconds,
    updatedAt: snapshot.priceProtection.nowSeconds,
  };
}

export function contractEpoch(snapshot) {
  return {
    positionIdHash: hashBytes(snapshot.positionId),
    traderInputTokenId: bytes32Address(snapshot.capacityEpoch.traderInputToken),
    traderOutputTokenId: bytes32Address(
      snapshot.capacityEpoch.traderOutputToken,
    ),
    balanceSnapshot: snapshot.capacityEpoch.balanceSnapshot,
    priceSnapshot: snapshot.capacityEpoch.priceSnapshot,
    portfolioPriceSnapshot: snapshot.capacityEpoch.portfolioPriceSnapshot,
    policyNonce: snapshot.capacityEpoch.policyNonce,
    riskCertificateHash: snapshot.capacityEpoch.riskCertificateHash,
    aquaStrategyHash: snapshot.capacityEpoch.aquaStrategyHash,
    capacityBaseline: snapshot.capacityEpoch.capacityBaselineValue,
    consumedBefore: snapshot.capacityEpoch.consumedBefore,
    chainId: snapshot.capacityEpoch.chainId,
    verifyingContract: snapshot.capacityEpoch.verifyingContract,
    capacityEpochId: snapshot.capacityEpochId,
  };
}

export function contractPriceInput(snapshot) {
  const price = snapshot.priceProtection;
  return {
    traderInputToken: price.traderInputReferencePrice.token,
    traderOutputToken: price.traderOutputReferencePrice.token,
    traderInputReferencePrice: price.traderInputReferencePrice,
    traderInputExecutionPrice: price.traderInputExecutionPrice,
    traderOutputReferencePrice: price.traderOutputReferencePrice,
    traderOutputExecutionPrice: price.traderOutputExecutionPrice,
    approvedTraderInputSnapshotId: price.approvedTraderInputSnapshotId,
    approvedTraderOutputSnapshotId: price.approvedTraderOutputSnapshotId,
    traderInputAmount: price.traderInputAmount,
    traderOutputAmount: price.traderOutputAmount,
    traderInputDecimals: price.traderInputDecimals,
    traderOutputDecimals: price.traderOutputDecimals,
    valueDecimals: price.valueDecimals,
    currentTime: BigInt(price.nowSeconds),
    maximumPriceAgeSeconds: price.maximumPriceAgeSeconds,
    maximumPriceDeviationBps: price.maximumPriceDeviationBps,
  };
}
