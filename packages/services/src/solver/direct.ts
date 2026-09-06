import {
  atomicSettlementProposalSchema,
  calculateDirectSettlement,
  computeSettlementPriceSnapshotHash,
  feeBreakdownSchema,
  portfolioSnapshotSchema,
} from "@aurka/shared";
import type {
  AtomicSettlementIntent,
  Quote,
  PortfolioSnapshot,
} from "@aurka/shared";

import {
  hashAssetStates,
  hashCanonical,
  hashDirectProgram,
  hashIntent,
  hashProposal,
} from "./hash.js";
import {
  asDirectSettlementInput,
  type ProposalSigner,
  type RouterSimulator,
  type SolvedProposal,
  type SolverSnapshot,
  type SolverSnapshotProvider,
} from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function snapshotFromValuation(snapshot: SolverSnapshot): PortfolioSnapshot {
  const result = {
    positionId: snapshot.positionId,
    blockNumber: snapshot.snapshotBlock.toString(),
    observedAt: snapshot.priceProtection.nowSeconds,
    nav: snapshot.portfolio.nav.toString(),
    valueDecimals: snapshot.portfolio.valueDecimals,
    assets: snapshot.portfolio.assets.map((asset) => ({
      token: asset.token,
      symbol: asset.symbol ?? asset.token.slice(0, 8),
      decimals: asset.decimals,
      balance: asset.balance.toString(),
      price: asset.price.toString(),
      priceDecimals: asset.priceDecimals,
      value: asset.value.toString(),
      weightBps: Number(asset.weightBps),
    })),
    snapshotHash: hashCanonical(snapshot.portfolio),
  };
  return portfolioSnapshotSchema.parse(result);
}

function feeBreakdown(
  snapshot: SolverSnapshot,
  fill: ReturnType<typeof calculateDirectSettlement>,
) {
  return feeBreakdownSchema.parse({
    baseFeeBps: Number(fill.fees.baseFeeBps),
    optionSpacePremiumBpsScaled:
      fill.fees.optionSpacePremiumBpsScaled.toString(),
    totalFeeBpsScaled: fill.fees.totalFeeBpsScaled.toString(),
    baseFeeAmount: fill.fees.baseFeeAmount.toString(),
    treasuryBaseFeeAmount: fill.fees.treasuryBaseFeeAmount.toString(),
    optionSpacePremiumAmount: fill.fees.optionSpacePremiumAmount.toString(),
    totalFeeAmount: fill.fees.totalFeeAmount.toString(),
    treasuryAmount: fill.fees.treasuryAmount.toString(),
    solverAmount: fill.fees.solverAmount.toString(),
    protocolAmount: fill.fees.protocolAmount.toString(),
    feeToken: snapshot.feeAccounting.feeToken,
    feePaymentMode: snapshot.feeAccounting.feePaymentMode,
    treasuryRecipient: snapshot.feeAccounting.treasuryRecipient,
    solverRecipient: snapshot.feeAccounting.solverRecipient,
    protocolRecipient: snapshot.feeAccounting.protocolRecipient,
  });
}

export class DirectSolver {
  constructor(
    private readonly provider: SolverSnapshotProvider,
    private readonly simulator: RouterSimulator,
    private readonly signer?: ProposalSigner,
  ) {}

  async quote(
    intent: AtomicSettlementIntent,
    quoteId = `quote:${intent.intentId}`,
  ): Promise<Quote> {
    const snapshot = await this.provider.getSnapshot(intent);
    const fill = calculateSolverFill(snapshot, intent);
    this.assertIntentAllowsFill(intent, fill.executedValue);
    const currentPortfolio =
      snapshot.portfolioSnapshot ?? snapshotFromValuation(snapshot);
    const expectedPostTradePortfolio = snapshotFromValuation({
      ...snapshot,
      portfolio: fill.finalPortfolio,
    });
    const reference = snapshot.priceProtection.traderOutputReferencePrice;
    return {
      id: quoteId,
      intentHash: hashIntent(intent, snapshot),
      traderInputToken: intent.traderInputToken,
      traderOutputToken: intent.traderOutputToken,
      requestedTraderInputAmount: intent.requestedValue,
      maximumSafeTraderInputAmount: fill.maximumSafeValue.toString(),
      executableTraderInputAmount: fill.executedValue.toString(),
      referencePrice: reference.price.toString(),
      referencePriceDecimals: reference.priceDecimals,
      fees: feeBreakdown(snapshot, fill),
      bindingConstraint: fill.bindingConstraint,
      ...(fill.bindingAsset === undefined
        ? {}
        : { bindingAsset: fill.bindingAsset }),
      currentPortfolio,
      expectedPostTradePortfolio,
      policyNonce: snapshot.policyNonce,
      capacityEpochId: snapshot.capacityEpochId,
      consumedBefore: fill.consumedBefore.toString(),
      consumedAfter: fill.consumedAfter.toString(),
      riskMode: snapshot.riskMode,
      expiresAt: Math.min(
        intent.deadline,
        snapshot.priceProtection.nowSeconds + 60,
      ),
      // A quote has no trader authorization and therefore cannot claim that
      // the deployed router accepted the eventual transaction.
      simulationStatus: "AUTHORIZATION_PENDING",
    };
  }

  async solve(intent: AtomicSettlementIntent): Promise<SolvedProposal> {
    const snapshot = await this.provider.getSnapshot(intent);
    const fill = calculateSolverFill(snapshot, intent);
    this.assertIntentAllowsFill(intent, fill.executedValue);
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
    if (traderOutputAmount < 0n)
      throw new RangeError(
        "Output fee legs exceed the committed output amount",
      );
    const intentHash = hashIntent(intent, snapshot);
    const proposalWithoutSignature = atomicSettlementProposalSchema.parse({
      intentHash,
      solver: this.signer?.address ?? ZERO_ADDRESS,
      balancesHash: snapshot.balancesHash,
      priceSnapshotHash: computeSettlementPriceSnapshotHash(
        snapshot.priceProtection,
      ),
      policyNonce: snapshot.policyNonce,
      riskCertificateHash: snapshot.riskCertificateHash,
      traderInputToken: intent.traderInputToken,
      traderOutputToken: intent.traderOutputToken,
      traderInputAmount: rawAmounts.traderInputAmount.toString(),
      traderOutputAmount: traderOutputAmount.toString(),
      solverFeeAmount: solverFeeAmount.toString(),
      protocolFeeAmount: protocolFeeAmount.toString(),
      traderInputValue: fill.executedValue.toString(),
      traderOutputValue: fill.traderOutputValue.toString(),
      treasuryOutputValue: fill.treasuryOutputValue.toString(),
      feeBpsScaled: fill.fees.totalFeeBpsScaled.toString(),
      baseFeeAmount: fill.fees.baseFeeAmount.toString(),
      treasuryBaseFeeAmount: fill.fees.treasuryBaseFeeAmount.toString(),
      optionSpacePremiumAmount: fill.fees.optionSpacePremiumAmount.toString(),
      totalFeeAmount: fill.fees.totalFeeAmount.toString(),
      treasuryAmount: fill.fees.treasuryAmount.toString(),
      solverAmount: fill.fees.solverAmount.toString(),
      protocolAmount: fill.fees.protocolAmount.toString(),
      feeToken: snapshot.feeAccounting.feeToken,
      feePaymentMode: snapshot.feeAccounting.feePaymentMode,
      initialPortfolioHash: hashAssetStates(snapshot.portfolio.assets),
      capacityBaselineValue: fill.capacityBaselineValue.toString(),
      consumedBefore: fill.consumedBefore.toString(),
      consumedAfter: fill.consumedAfter.toString(),
      capacityEpochId: fill.capacityEpochId,
      utilizationBefore: fill.utilizationBefore.toString(),
      utilizationAfter: fill.utilizationAfter.toString(),
      bindingConstraint: fill.bindingConstraint,
      ...(fill.bindingAsset === undefined
        ? {}
        : { bindingAsset: fill.bindingAsset }),
      expectedPostStateHash: hashAssetStates(fill.finalPortfolio.assets),
      aquaStrategyHash: snapshot.aquaStrategyHash,
      swapVMCalldataHash: hashDirectProgram({
        policyId: intent.policyId,
        positionIdHash: intent.positionIdHash,
        trader: intent.trader,
        inputToken: intent.traderInputToken,
        outputToken: intent.traderOutputToken,
        strategyHash: snapshot.aquaStrategyHash,
        inputAmount: rawAmounts.traderInputAmount,
        traderOutputAmount,
        solverFeeAmount,
        protocolFeeAmount,
        inputValue: fill.executedValue,
        traderOutputValue: fill.traderOutputValue,
        treasuryOutputValue: fill.treasuryOutputValue,
        capacityEpochId: fill.capacityEpochId,
        intentHash,
      }),
      deadline: Math.min(
        intent.deadline,
        snapshot.priceProtection.nowSeconds + 60,
      ),
    });
    const proposalHash = hashProposal(proposalWithoutSignature, snapshot);
    const signature = this.signer
      ? await this.signer.signProposal(
          proposalWithoutSignature,
          proposalHash,
          snapshot,
        )
      : undefined;
    const proposal = atomicSettlementProposalSchema.parse({
      ...proposalWithoutSignature,
      ...(signature === undefined ? {} : { signature }),
    });
    const simulation = await this.simulator.simulate(
      intent,
      proposal,
      snapshot,
    );
    return { proposal, proposalHash, fill, simulation };
  }

  private assertIntentAllowsFill(
    intent: AtomicSettlementIntent,
    executedValue: bigint,
  ): void {
    const requested = BigInt(intent.requestedValue);
    if (
      (intent.exactInput || !intent.allowPartialFill) &&
      executedValue !== requested
    ) {
      throw new Error("Signed intent does not allow a partial fill");
    }
  }
}

/** Recalculate after binding raw token amounts to the executable value. */
export function calculateSolverFill(
  snapshot: SolverSnapshot,
  intent: AtomicSettlementIntent,
): ReturnType<typeof calculateDirectSettlement> {
  const initial = calculateDirectSettlement(
    asDirectSettlementInput(snapshot, intent),
  );
  if (!snapshot.rawAmountsForValue) return initial;
  const raw = snapshot.rawAmountsForValue(
    initial.executedValue,
    initial.treasuryOutputValue,
  );
  return calculateDirectSettlement({
    ...asDirectSettlementInput(snapshot, intent),
    priceProtection: {
      ...snapshot.priceProtection,
      traderInputAmount: raw.traderInputAmount,
      traderOutputAmount: raw.traderOutputAmount,
    },
  });
}
