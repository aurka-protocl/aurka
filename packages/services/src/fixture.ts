import {
  calculatePortfolioValuation,
  computeCapacityEpochId,
  computePortfolioPriceSnapshotHash,
  computeSettlementPriceSnapshotHash,
  type AtomicSettlementIntent,
  type AtomicSettlementProposal,
  type CapacityEpoch,
  type FeeAccounting,
  type FinancialFeeConfig,
  type FinancialPolicy,
  type PortfolioSnapshot,
  type PriceSnapshot,
  type RiskMode,
  type SettlementPriceProtection,
} from "@aurka/shared";

import {
  hashAquaBalances,
  hashAssetStates,
  hashCanonical,
  hashBytes,
  hashIntent,
} from "./solver/hash.js";
import { calculateSolverFill } from "./solver/direct.js";
import type {
  RouterSimulator,
  SolverSnapshot,
  SolverSnapshotProvider,
} from "./solver/types.js";

export const FIXTURE_ADDRESSES = {
  usdc: "0x1111111111111111111111111111111111111111",
  weth: "0x2222222222222222222222222222222222222222",
  link: "0x3333333333333333333333333333333333333333",
  trader: "0x4444444444444444444444444444444444444444",
  solver: "0x5555555555555555555555555555555555555555",
  protocol: "0x6666666666666666666666666666666666666666",
  router: "0x7777777777777777777777777777777777777777",
  registry: "0x8888888888888888888888888888888888888888",
  risk: "0x9999999999999999999999999999999999999999",
  treasury: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;

export const FIXTURE_POLICY_ID = `0x${"01".repeat(32)}`;
export const FIXTURE_POSITION_ID = "position:canonical";
export const FIXTURE_POSITION_ID_HASH = hashBytes(FIXTURE_POSITION_ID);
export const FIXTURE_BALANCE_SNAPSHOT = hashAquaBalances(
  [FIXTURE_ADDRESSES.usdc, FIXTURE_ADDRESSES.weth, FIXTURE_ADDRESSES.link],
  [600_000n, 300_000n, 100_000n],
);
export const FIXTURE_PRICE_SNAPSHOT = `0x${"04".repeat(32)}`;
export const FIXTURE_RISK_CERTIFICATE_HASH = `0x${"00".repeat(32)}`;
export const FIXTURE_AQUA_STRATEGY_HASH = `0x${"05".repeat(32)}`;

export interface FixtureOptions {
  readonly nowSeconds?: number;
  readonly blockNumber?: bigint;
  readonly positionId?: string;
  readonly policyId?: string;
}

export interface FixtureBundle {
  readonly snapshot: SolverSnapshot;
  readonly intent: AtomicSettlementIntent;
}

function price(
  token: string,
  snapshotId: string,
  observedAt: number,
): PriceSnapshot {
  return { token, snapshotId, price: 1n, priceDecimals: 0, observedAt };
}

function snapshotFromPortfolio(
  positionId: string,
  portfolio: ReturnType<typeof calculatePortfolioValuation>,
  blockNumber: bigint,
  observedAt: number,
): PortfolioSnapshot {
  return {
    positionId,
    blockNumber: blockNumber.toString(),
    observedAt,
    nav: portfolio.nav.toString(),
    valueDecimals: portfolio.valueDecimals,
    assets: portfolio.assets.map((asset) => ({
      token: asset.token,
      symbol: asset.symbol ?? asset.token.slice(0, 8),
      decimals: asset.decimals,
      balance: asset.balance.toString(),
      price: asset.price.toString(),
      priceDecimals: asset.priceDecimals,
      value: asset.value.toString(),
      weightBps: Number(asset.weightBps),
    })),
    snapshotHash: hashCanonical(portfolio),
  };
}

export function createCanonicalFixture(
  options: FixtureOptions = {},
): FixtureBundle {
  const nowSeconds = options.nowSeconds ?? 200;
  const blockNumber = options.blockNumber ?? 100n;
  const positionId = options.positionId ?? FIXTURE_POSITION_ID;
  const policyId = options.policyId ?? FIXTURE_POLICY_ID;
  const assets = [
    {
      token: FIXTURE_ADDRESSES.usdc,
      symbol: "USDC",
      balance: 600_000n,
      decimals: 0,
      price: 1n,
      priceDecimals: 0,
      minimumWeightBps: 5_500,
      maximumWeightBps: 10_000,
    },
    {
      token: FIXTURE_ADDRESSES.weth,
      symbol: "WETH",
      balance: 300_000n,
      decimals: 0,
      price: 1n,
      priceDecimals: 0,
      minimumWeightBps: 0,
      maximumWeightBps: 3_500,
    },
    {
      token: FIXTURE_ADDRESSES.link,
      symbol: "LINK",
      balance: 100_000n,
      decimals: 0,
      price: 1n,
      priceDecimals: 0,
      minimumWeightBps: 0,
      maximumWeightBps: 1_500,
    },
  ] as const;
  const portfolio = calculatePortfolioValuation(assets, 0);
  const policy: FinancialPolicy = {
    maximumTransactionValue: 50_000n,
    assets: assets.map(({ token, minimumWeightBps, maximumWeightBps }) => ({
      token,
      minimumWeightBps,
      maximumWeightBps,
    })),
  };
  const fee: FinancialFeeConfig = {
    baseFeeBps: 20,
    slopeBps: 80,
    maximumFeeBps: 100,
    treasuryBaseFeeBps: 10,
    solverFeeBps: 5,
    protocolFeeBps: 5,
  };
  const feeAccounting: FeeAccounting = {
    feeToken: FIXTURE_ADDRESSES.usdc,
    feePaymentMode: "OUTPUT_TOKEN",
    treasuryRecipient: FIXTURE_ADDRESSES.treasury,
    solverRecipient: FIXTURE_ADDRESSES.solver,
    protocolRecipient: FIXTURE_ADDRESSES.protocol,
  };
  const capacityEpochDraft: CapacityEpoch = {
    positionId,
    traderInputToken: FIXTURE_ADDRESSES.weth,
    traderOutputToken: FIXTURE_ADDRESSES.usdc,
    balanceSnapshot: FIXTURE_BALANCE_SNAPSHOT,
    priceSnapshot: FIXTURE_PRICE_SNAPSHOT,
    portfolioPriceSnapshot: `0x${"00".repeat(32)}`,
    policyNonce: 1n,
    riskCertificateHash: FIXTURE_RISK_CERTIFICATE_HASH,
    aquaStrategyHash: FIXTURE_AQUA_STRATEGY_HASH,
    capacityBaselineValue: 50_000n,
    consumedBefore: 0n,
    chainId: 31337n,
    verifyingContract: FIXTURE_ADDRESSES.router,
  };
  const inputReference = price(
    FIXTURE_ADDRESSES.weth,
    `0x${"11".repeat(32)}`,
    nowSeconds,
  );
  const outputReference = price(
    FIXTURE_ADDRESSES.usdc,
    `0x${"22".repeat(32)}`,
    nowSeconds,
  );
  const priceProtection: SettlementPriceProtection = {
    traderInputReferencePrice: inputReference,
    traderInputExecutionPrice: inputReference,
    traderOutputReferencePrice: outputReference,
    traderOutputExecutionPrice: outputReference,
    approvedTraderInputSnapshotId: inputReference.snapshotId,
    approvedTraderOutputSnapshotId: outputReference.snapshotId,
    traderInputAmount: 50_000n,
    traderOutputAmount: 49_816n,
    traderInputDecimals: 0,
    traderOutputDecimals: 0,
    valueDecimals: 0,
    nowSeconds,
    maximumPriceAgeSeconds: 120,
    maximumPriceDeviationBps: 100,
  };
  const balancesHash = FIXTURE_BALANCE_SNAPSHOT;
  const priceSnapshot = computeSettlementPriceSnapshotHash(priceProtection);
  const portfolioPriceSnapshot = computePortfolioPriceSnapshotHash([
    outputReference,
    inputReference,
    price(FIXTURE_ADDRESSES.link, `0x${"33".repeat(32)}`, nowSeconds),
  ]);
  const capacityEpoch: CapacityEpoch = {
    ...capacityEpochDraft,
    priceSnapshot,
    portfolioPriceSnapshot,
  };
  const capacityEpochId = computeCapacityEpochId(capacityEpoch);
  const snapshot: SolverSnapshot = {
    positionId,
    chainId: 31337,
    verifyingContract: FIXTURE_ADDRESSES.router,
    policyId,
    policy,
    fee,
    feeAccounting,
    riskMode: "NORMAL" satisfies RiskMode,
    riskCertificateHash: FIXTURE_RISK_CERTIFICATE_HASH,
    policyNonce: "1",
    portfolio,
    portfolioSnapshot: snapshotFromPortfolio(
      positionId,
      portfolio,
      blockNumber,
      nowSeconds,
    ),
    capacityEpoch,
    capacityEpochId,
    priceProtection,
    snapshotBlock: blockNumber,
    aquaStrategyHash: FIXTURE_AQUA_STRATEGY_HASH,
    balancesHash,
    rawAmountsForValue: (traderInputValue, treasuryOutputValue) => ({
      traderInputAmount: traderInputValue,
      traderOutputAmount: treasuryOutputValue,
    }),
    outputAmountForValue: (value) => value,
  };
  const intent: AtomicSettlementIntent = {
    intentId: hashBytes(`intent:${positionId}`),
    policyId,
    positionIdHash: hashBytes(positionId),
    trader: FIXTURE_ADDRESSES.trader,
    traderInputToken: FIXTURE_ADDRESSES.weth,
    traderOutputToken: FIXTURE_ADDRESSES.usdc,
    requestedValue: "200000",
    minimumTraderOutputValue: "49700",
    exactInput: false,
    allowPartialFill: true,
    deadline: nowSeconds + 60,
    nonce: "1",
    balanceSnapshot: FIXTURE_BALANCE_SNAPSHOT,
    priceSnapshot,
    aquaStrategyHash: FIXTURE_AQUA_STRATEGY_HASH,
  };
  return { snapshot, intent };
}

export class FixtureProvider implements SolverSnapshotProvider {
  constructor(
    private readonly bundle: FixtureBundle = createCanonicalFixture(),
  ) {}

  async getSnapshot(intent: AtomicSettlementIntent): Promise<SolverSnapshot> {
    if (intent.policyId !== this.bundle.snapshot.policyId)
      throw new Error("Unknown policy");
    if (intent.positionIdHash !== hashBytes(this.bundle.snapshot.positionId))
      throw new Error("Unknown position");
    if (intent.aquaStrategyHash !== this.bundle.snapshot.aquaStrategyHash)
      throw new Error("Unauthorized Aqua strategy");
    if (
      intent.traderInputToken.toLowerCase() !==
        this.bundle.snapshot.capacityEpoch.traderInputToken.toLowerCase() ||
      intent.traderOutputToken.toLowerCase() !==
        this.bundle.snapshot.capacityEpoch.traderOutputToken.toLowerCase()
    )
      throw new Error("Unsupported fixture direction");
    if (
      intent.balanceSnapshot.toLowerCase() !==
      this.bundle.snapshot.balancesHash.toLowerCase()
    )
      throw new Error("Balance snapshot is stale");
    if (
      intent.priceSnapshot.toLowerCase() !==
      computeSettlementPriceSnapshotHash(
        this.bundle.snapshot.priceProtection,
      ).toLowerCase()
    )
      throw new Error("Price snapshot is stale");
    return this.bundle.snapshot;
  }
}

export class DeterministicRouterSimulator implements RouterSimulator {
  async simulate(
    intent: AtomicSettlementIntent,
    proposal: AtomicSettlementProposal,
    snapshot: SolverSnapshot,
  ) {
    if (proposal.intentHash !== hashIntent(intent, snapshot))
      return {
        status: "REVERTED" as const,
        gasEstimate: 0n,
        reason: "intent commitment mismatch",
      };
    if (proposal.deadline < snapshot.priceProtection.nowSeconds)
      return {
        status: "STALE" as const,
        gasEstimate: 0n,
        reason: "proposal expired",
      };
    try {
      const fill = calculateSolverFill(snapshot, intent);
      const rawAmounts = snapshot.rawAmountsForValue?.(
        fill.executedValue,
        fill.treasuryOutputValue,
      ) ?? {
        traderInputAmount: snapshot.priceProtection.traderInputAmount,
        traderOutputAmount: snapshot.priceProtection.traderOutputAmount,
      };
      const outputAmountForValue =
        snapshot.outputAmountForValue ?? ((value: bigint) => value);
      const solverFeeAmount = outputAmountForValue(fill.fees.solverAmount);
      const protocolFeeAmount = outputAmountForValue(fill.fees.protocolAmount);
      const traderOutputAmount =
        BigInt(rawAmounts.traderOutputAmount) -
        solverFeeAmount -
        protocolFeeAmount;
      if (
        proposal.balancesHash !== snapshot.balancesHash ||
        proposal.priceSnapshotHash !==
          computeSettlementPriceSnapshotHash(snapshot.priceProtection) ||
        proposal.policyNonce !== snapshot.policyNonce ||
        proposal.riskCertificateHash !== snapshot.riskCertificateHash ||
        proposal.capacityEpochId !== snapshot.capacityEpochId ||
        proposal.capacityBaselineValue !==
          snapshot.capacityEpoch.capacityBaselineValue.toString() ||
        proposal.consumedBefore !==
          snapshot.capacityEpoch.consumedBefore.toString() ||
        proposal.feeToken.toLowerCase() !==
          snapshot.feeAccounting.feeToken.toLowerCase() ||
        proposal.aquaStrategyHash !== snapshot.aquaStrategyHash ||
        proposal.initialPortfolioHash !==
          hashAssetStates(snapshot.portfolio.assets)
      )
        return {
          status: "REVERTED" as const,
          gasEstimate: 0n,
          reason: "state commitment mismatch",
        };
      if (
        fill.executedValue !== BigInt(proposal.traderInputValue) ||
        fill.traderOutputValue !== BigInt(proposal.traderOutputValue) ||
        fill.treasuryOutputValue !== BigInt(proposal.treasuryOutputValue) ||
        fill.fees.totalFeeAmount !== BigInt(proposal.totalFeeAmount) ||
        fill.consumedAfter !== BigInt(proposal.consumedAfter)
      )
        return {
          status: "REVERTED" as const,
          gasEstimate: 0n,
          reason: "proposal does not match direct settlement",
        };
      if (
        rawAmounts.traderInputAmount !== BigInt(proposal.traderInputAmount) ||
        traderOutputAmount !== BigInt(proposal.traderOutputAmount) ||
        solverFeeAmount !== BigInt(proposal.solverFeeAmount) ||
        protocolFeeAmount !== BigInt(proposal.protocolFeeAmount)
      )
        return {
          status: "REVERTED" as const,
          gasEstimate: 0n,
          reason: "raw token commitment mismatch",
        };
      if (
        proposal.expectedPostStateHash !==
        hashAssetStates(fill.finalPortfolio.assets)
      )
        return {
          status: "REVERTED" as const,
          gasEstimate: 0n,
          reason: "post-state commitment mismatch",
        };
    } catch (error) {
      return {
        status: "REVERTED" as const,
        gasEstimate: 0n,
        reason: error instanceof Error ? error.message : "simulation failed",
      };
    }
    return { status: "SUCCEEDED" as const, gasEstimate: 220_000n };
  }
}
