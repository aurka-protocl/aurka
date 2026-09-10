import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, stringToHex } from "viem";
import { hashBytes, ServiceError } from "../dist/index.js";
import {
  calculateAssetValue,
  calculateDirectSettlement,
  computeCapacityEpochId,
  computePortfolioPriceSnapshotHash,
  computeSettlementPriceSnapshotHash,
  parseTokenAmount,
} from "@aurka/shared";
import {
  contractEpoch,
  contractPriceInput,
  positionForSnapshot,
} from "./chain-snapshot.mjs";
import { hashAquaBalances } from "../dist/index.js";

const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const fail = (message) => {
  throw new ServiceError("SPACE_CHAIN_VERIFICATION_FAILED", message, 409);
};
const recoveryFail = (message) => {
  throw new ServiceError("SPACE_BATCH_RECOVERY_REQUIRED", message, 409);
};
const json = (value) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
const ZERO_HASH = `0x${"00".repeat(32)}`;

function asObject(value, index, field) {
  return value && typeof value === "object" && field in value
    ? value[field]
    : value?.[index];
}

function bytes32Address(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function ceilDiv(numerator, denominator) {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function valueToRaw(value, asset) {
  return ceilDiv(
    value * 10n ** BigInt(asset.decimals) * 10n ** BigInt(asset.priceDecimals),
    asset.price,
  );
}

function fundingUnits(draft) {
  if (!draft?.funding)
    fail(
      "This saved draft predates configurable funding. Recreate it with explicit positive USDC and WETH amounts; the old signed funding was not reused.",
    );
  let usdcAmount;
  let wethAmount;
  try {
    usdcAmount = parseTokenAmount(draft.funding.usdc, 6);
    wethAmount = parseTokenAmount(draft.funding.weth, 18);
  } catch (error) {
    fail(
      `Funding amounts are invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (usdcAmount === 0n || wethAmount === 0n)
    fail("Both USDC and WETH funding amounts must be greater than zero.");
  return { usdcAmount, wethAmount };
}

/** A hash is only evidence after its transaction and canonical successful receipt match the server plan. */
export async function verifySpaceReceipt(
  client,
  chainId,
  owner,
  expected,
  hash,
  minimumBlock,
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? ""))
    fail("A transaction hash is required");
  if ((await client.getChainId()) !== chainId)
    fail("Configured chain mismatch");
  let receipt;
  let transaction;
  try {
    [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
    ]);
  } catch (error) {
    throw new ServiceError(
      "SPACE_RPC_UNAVAILABLE",
      `The fork RPC could not verify setup transaction ${hash}: ${error instanceof Error ? error.message : String(error)}`,
      503,
      { hash, retryable: true },
    );
  }
  if (transaction && !receipt)
    throw new ServiceError(
      "SPACE_TRANSACTION_PENDING",
      `Setup transaction ${hash} is known by the configured fork but is not mined yet; keep it pending and check again.`,
      409,
      { hash, retryable: true, state: "PENDING" },
    );
  if (!receipt || !transaction)
    throw new ServiceError(
      "SPACE_TRANSACTION_NOT_FOUND",
      `Setup transaction ${hash} is not available on the configured fork yet; keep it pending and check again before retrying.`,
      409,
      { hash, retryable: true, state: "NOT_FOUND" },
    );
  if (!same(transaction.from, owner) || !same(receipt.from, owner))
    fail("Transaction caller is not the Space owner");
  if (
    !same(transaction.to, expected.to) ||
    !same(receipt.to, expected.to) ||
    !same(transaction.input, expected.data) ||
    BigInt(transaction.value) !== BigInt(expected.value)
  )
    fail("Receipt does not match the reviewed Space operation");
  if (Number(transaction.chainId) !== chainId)
    fail("Transaction chain mismatch");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    !same(block.hash, receipt.blockHash) ||
    !same(transaction.blockHash, receipt.blockHash)
  )
    fail("Receipt is no longer canonical");
  if (minimumBlock !== undefined && receipt.blockNumber <= BigInt(minimumBlock))
    fail("Receipt predates this prepared operation");
  if (receipt.status !== "success")
    throw new ServiceError(
      "SPACE_TRANSACTION_REVERTED",
      "The wallet transaction reverted; retry this setup step",
      409,
    );
  return receipt;
}

async function canonicalReceipt(
  client,
  chainId,
  owner,
  hash,
  minimumBlock,
  allowReverted = false,
) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? ""))
    fail("A transaction hash is required");
  if ((await client.getChainId()) !== chainId)
    fail("Configured chain mismatch");
  let receipt;
  let transaction;
  try {
    [receipt, transaction] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
    ]);
  } catch (error) {
    throw new ServiceError(
      "SPACE_RPC_UNAVAILABLE",
      `The fork RPC could not verify setup batch ${hash}: ${error instanceof Error ? error.message : String(error)}`,
      503,
      { hash, retryable: true },
    );
  }
  if (transaction && !receipt)
    throw new ServiceError(
      "SPACE_TRANSACTION_PENDING",
      `Setup batch transaction ${hash} is known by the configured fork but is not mined yet; keep it pending and check again.`,
      409,
      { hash, retryable: true, state: "PENDING" },
    );
  if (!receipt || !transaction)
    throw new ServiceError(
      "SPACE_TRANSACTION_NOT_FOUND",
      `Setup batch transaction ${hash} is not available on the configured fork yet; keep it pending and check again before retrying.`,
      409,
      { hash, retryable: true, state: "NOT_FOUND" },
    );
  if (!same(transaction.from, owner) || !same(receipt.from, owner))
    fail("Batch transaction caller is not the Space owner");
  if (Number(transaction.chainId) !== chainId)
    fail("Transaction chain mismatch");
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    !same(block.hash, receipt.blockHash) ||
    !same(transaction.blockHash, receipt.blockHash)
  )
    fail("Receipt is no longer canonical");
  if (minimumBlock !== undefined && receipt.blockNumber <= BigInt(minimumBlock))
    fail("Receipt predates this prepared operation");
  if (receipt.status !== "success" && !allowReverted)
    throw new ServiceError(
      "SPACE_TRANSACTION_REVERTED",
      "The atomic wallet batch reverted",
      409,
    );
  return receipt;
}

function traceHasFailure(trace) {
  if (
    trace &&
    (typeof trace.error === "string" ||
      trace.failed === true ||
      trace.status === 0 ||
      trace.status === "0x0")
  )
    return true;
  return (trace?.calls ?? []).some((child) => traceHasFailure(child));
}

function ownerCalls(trace, owner, root = true) {
  const found = [];
  if (
    !root &&
    same(trace?.from, owner) &&
    trace?.type?.toUpperCase() === "CALL"
  )
    found.push({
      to: trace.to,
      data: trace.input ?? "0x",
      value: trace.value ?? "0x0",
    });
  for (const child of trace?.calls ?? [])
    found.push(...ownerCalls(child, owner, false));
  return found;
}

function sameCall(left, right) {
  return (
    same(left?.to, right?.to) &&
    same(left?.data ?? left?.input, right?.data) &&
    BigInt(left?.value ?? "0x0") === BigInt(right?.value ?? "0x0")
  );
}

function sameHashList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((hash, index) => same(hash, right[index]))
  );
}

function isRevertedReceipt(receipt) {
  return (
    receipt?.status === "reverted" ||
    receipt?.status === "0x0" ||
    receipt?.status === 0
  );
}

/** Freeze the exact calls covered by a wallet batch before later steps are appended. */
function ensureBatchPlan(plan, chainId) {
  if (plan.batchPlan) return plan.batchPlan;

  const legacy = plan.receipts.find((receipt) => receipt.batchHashes);
  if (legacy) {
    const startIndex = legacy.batchStartIndex ?? 0;
    const coveredCount =
      Math.max(
        ...plan.receipts
          .filter((receipt) => receipt.batchHashes)
          .map((receipt) => receipt.batchIndex ?? 0),
      ) + 1;
    const calls = plan.steps
      .slice(startIndex, startIndex + coveredCount)
      .map((step) => step.transaction);
    const commitment =
      legacy.batchCommitment ??
      hashBytes(
        json({
          spaceId: plan.definition.positionId,
          operation: plan.operation ?? "ACTIVATE",
          owner: plan.draft.ownerAddress,
          chainId,
          startIndex,
          calls,
        }),
      );
    plan.batchPlan = {
      id: legacy.batchPlanId ?? hashBytes(`space-batch:${commitment}`),
      commitment,
      startIndex,
      coveredCount,
      calls,
      owner: plan.draft.ownerAddress,
      chainId,
      operation: plan.operation ?? "ACTIVATE",
      walletBatchId: legacy.walletBatchId,
      receiptHashes: legacy.batchHashes,
      atomic: legacy.atomic === true,
    };
    return plan.batchPlan;
  }

  if (plan.receipts.length !== 0 || plan.steps.length <= 1) return undefined;
  const startIndex = plan.receipts.length;
  const calls = plan.steps.slice(startIndex).map((step) => step.transaction);
  const commitment = hashBytes(
    json({
      spaceId: plan.definition.positionId,
      operation: plan.operation ?? "ACTIVATE",
      owner: plan.draft.ownerAddress,
      chainId,
      startIndex,
      calls,
    }),
  );
  plan.batchPlan = {
    id: hashBytes(`space-batch:${commitment}`),
    commitment,
    startIndex,
    coveredCount: calls.length,
    calls,
    owner: plan.draft.ownerAddress,
    chainId,
    operation: plan.operation ?? "ACTIVATE",
  };
  return plan.batchPlan;
}

/** Verify either one direct receipt per call or one EIP-5792 atomic execution envelope. */
export async function verifySpaceBatchReceipts(
  client,
  chainId,
  owner,
  expected,
  hashes,
  minimumBlock,
  atomic = false,
) {
  if (!Array.isArray(hashes) || hashes.length === 0)
    fail("Batch receipts are required");
  if (!atomic && hashes.length === expected.length) {
    return Promise.all(
      hashes.map((hash, index) =>
        verifySpaceReceipt(
          client,
          chainId,
          owner,
          expected[index],
          hash,
          minimumBlock,
        ),
      ),
    );
  }
  const receipts = [];
  const calls = [];
  for (const hash of hashes) {
    receipts.push(
      await canonicalReceipt(client, chainId, owner, hash, minimumBlock),
    );
    let trace;
    try {
      trace = await client.request({
        method: "debug_traceTransaction",
        params: [hash, { tracer: "callTracer" }],
      });
    } catch {
      fail("This fork RPC cannot verify the atomic wallet execution trace");
    }
    if (traceHasFailure(trace))
      fail("Atomic receipt contains a reverted call or execution ancestor");
    calls.push(...ownerCalls(trace, owner));
  }
  if (
    calls.length !== expected.length ||
    calls.some(
      (call, index) =>
        !same(call.to, expected[index].to) ||
        !same(call.data, expected[index].data) ||
        BigInt(call.value) !== BigInt(expected[index].value),
    )
  )
    fail("Atomic receipt does not contain exactly the reviewed Space calls");
  return receipts;
}

/** Local fork composition only: no owner private keys and no server broadcasts. */
export class ForkSpaceLifecycle {
  constructor({
    client,
    contracts,
    manifest,
    service,
    providers,
    definitions,
    makeProvider,
    file,
    epochs,
    saveEpochs,
    saveManifest,
  }) {
    Object.assign(this, {
      client,
      contracts,
      manifest,
      service,
      providers,
      definitions,
      makeProvider,
      file,
      epochs,
      saveEpochs,
      saveManifest,
    });
    const saved = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : {};
    this.plans = Object.assign(Object.create(null), saved.plans ?? {});
    this.operations = Object.assign(
      Object.create(null),
      saved.operations ?? {},
    );
    this.history = saved.history ?? [];
    this.usedReceipts = Object.assign(
      Object.create(null),
      saved.usedReceipts ?? {},
    );
    for (const plan of [
      ...Object.values(this.plans),
      ...Object.values(this.operations),
    ]) {
      for (const receipt of plan.receipts)
        this.usedReceipts[receipt.hash.toLowerCase()] = true;
    }
  }
  persist() {
    writeFileSync(
      `${this.file}.tmp`,
      json({
        plans: this.plans,
        operations: this.operations,
        history: this.history,
        usedReceipts: this.usedReceipts,
      }),
      { mode: 0o600 },
    );
    renameSync(`${this.file}.tmp`, this.file);
  }
  saveSpaceChange(change) {
    const repository = this.service.repository;
    if (typeof repository.updateSpaceChange === "function")
      repository.updateSpaceChange(change);
    else repository.saveSpaceChange(change);
  }
  tx(contract, functionName, args) {
    return {
      to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName, args }),
      value: "0x0",
    };
  }
  isSingleTransactionMode() {
    return (
      this.manifest.spaceCreationMode === "single-transaction" &&
      this.manifest.vaultFactoryVersion === 2
    );
  }
  async plan(spaceId) {
    const space = this.service.getSpace(spaceId);
    if (this.plans[spaceId]) {
      const existing = this.plans[spaceId];
      if (
        !existing.complete &&
        existing.receipts.length === 0 &&
        json(existing.draft) !== json(space.draft)
      )
        delete this.plans[spaceId];
      else return existing;
    }
    if (
      space.identity.mode !== "fork" ||
      space.identity.state !== "DRAFT" ||
      !space.draft
    )
      fail("Save an owner-signed fork draft first");
    const draft = space.draft;
    if (
      this.isSingleTransactionMode() &&
      (draft.assets.length !== 2 ||
        !same(draft.assets[0]?.token, this.manifest.usdc) ||
        !same(draft.assets[1]?.token, this.manifest.weth))
    )
      fail(
        "This fork supports atomic creation only for the disclosed USDC/WETH configuration; unsupported asset configurations are unavailable.",
      );
    const { usdcAmount, wethAmount } = fundingUnits(draft);
    const definition = {
      positionId: spaceId,
      name: draft.name,
      policyId: hashBytes(`policy:${spaceId}`),
      positionIdHash: hashBytes(spaceId),
      strategyHash: hashBytes(`strategy:${spaceId}`),
      // Aqua hashes the exact strategy bytes, not an ABI re-encoding. The
      // direct AURKA adapter treats this as immutable strategy identity.
      strategy: stringToHex(`strategy:${spaceId}`),
    };
    const treasury = await this.client.readContract({
      ...this.contracts.vaultFactory,
      functionName: "vaultAddress",
      args: [draft.ownerAddress, definition.positionIdHash],
    });
    const plan = {
      minimumBlock: (await this.client.getBlockNumber()).toString(),
      draft,
      definition,
      treasury,
      receipts: [],
      steps: [],
      complete: false,
      activityId: hashBytes(
        `chain-activation:${spaceId}:${draft.ownerAddress}:${Date.now()}`,
      ),
    };
    const { policyRegistry, vaultFactory, vaultAbi, erc20Abi, aqua } =
      this.contracts;
    const { usdc, weth, oracle, router, protocolRecipient } = this.manifest;

    if (this.isSingleTransactionMode()) {
      const block = await this.client.getBlock();
      const prices = [];
      for (const token of [usdc, weth]) {
        const raw = await this.client.readContract({
          ...this.contracts.oracle,
          functionName: "getPrice",
          args: [token],
        });
        prices.push({
          token,
          price: BigInt(asObject(raw, 0, "price")),
          priceDecimals: Number(asObject(raw, 1, "priceDecimals")),
          observedAt: Number(asObject(raw, 2, "observedAt")),
          snapshotId: asObject(raw, 3, "snapshotId"),
        });
      }
      const inputPrice = prices[1];
      const outputPrice = prices[0];
      const inputAsset = {
        decimals: draft.assets[1].decimals,
        price: inputPrice.price,
        priceDecimals: inputPrice.priceDecimals,
      };
      const outputAsset = {
        decimals: draft.assets[0].decimals,
        price: outputPrice.price,
        priceDecimals: outputPrice.priceDecimals,
      };
      const initialBalances = [usdcAmount, wethAmount];
      const initialValues = [
        calculateAssetValue(
          {
            balance: usdcAmount,
            decimals: outputAsset.decimals,
            price: outputAsset.price,
            priceDecimals: outputAsset.priceDecimals,
          },
          0,
        ),
        calculateAssetValue(
          {
            balance: wethAmount,
            decimals: inputAsset.decimals,
            price: inputAsset.price,
            priceDecimals: inputAsset.priceDecimals,
          },
          0,
        ),
      ];
      const initialNav = initialValues[0] + initialValues[1];
      for (const [index, asset] of draft.assets.entries()) {
        const value = initialValues[index];
        if (
          value * 10000n < initialNav * BigInt(asset.minimumWeightBps) ||
          value * 10000n > initialNav * BigInt(asset.maximumWeightBps)
        )
          fail(
            `The current price snapshot puts ${asset.symbol} outside its starting allocation bounds: ${value}/${initialNav} value units, allowed ${asset.minimumWeightBps}-${asset.maximumWeightBps} bps. Adjust funding or bounds before deployment.`,
          );
      }
      const priceCommitment = {
        traderInputToken: weth,
        traderOutputToken: usdc,
        traderInputReferencePrice: inputPrice,
        traderInputExecutionPrice: inputPrice,
        traderOutputReferencePrice: outputPrice,
        traderOutputExecutionPrice: outputPrice,
        approvedTraderInputSnapshotId: inputPrice.snapshotId,
        approvedTraderOutputSnapshotId: outputPrice.snapshotId,
        traderInputAmount: valueToRaw(50000n, inputAsset),
        traderOutputAmount: valueToRaw(50000n, outputAsset),
        traderInputDecimals: inputAsset.decimals,
        traderOutputDecimals: outputAsset.decimals,
        valueDecimals: 0,
        nowSeconds: Number(block.timestamp),
        maximumPriceAgeSeconds: 86400,
        maximumPriceDeviationBps: 100,
      };
      const epoch = {
        positionIdHash: definition.positionIdHash,
        traderInputTokenId: bytes32Address(weth),
        traderOutputTokenId: bytes32Address(usdc),
        balanceSnapshot: hashAquaBalances([usdc, weth], initialBalances),
        priceSnapshot: computeSettlementPriceSnapshotHash(priceCommitment),
        portfolioPriceSnapshot: computePortfolioPriceSnapshotHash(prices),
        policyNonce: 3n,
        riskCertificateHash: ZERO_HASH,
        aquaStrategyHash: definition.strategyHash,
        capacityBaseline: 0n,
        consumedBefore: 0n,
        chainId: BigInt(this.manifest.chainId),
        verifyingContract: router,
        capacityEpochId: ZERO_HASH,
      };
      const fee = {
        baseFeeBps: 20,
        slopeBps: 80,
        maximumFeeBps: 100,
        treasuryBaseFeeBps: 10,
        solverFeeBps: 5,
        protocolFeeBps: 5,
        treasuryFeeRecipient: treasury,
        protocolFeeRecipient: protocolRecipient,
      };
      const priceInput = {
        ...priceCommitment,
        currentTime: BigInt(block.timestamp),
      };
      delete priceInput.nowSeconds;
      plan.singleTransaction = true;
      plan.steps.push({
        label: "Create, fund, configure and activate Space",
        transaction: this.tx(vaultFactory, "createAndInitializeSpace", [
          {
            spaceId: definition.positionIdHash,
            policyId: definition.policyId,
            strategyHash: definition.strategyHash,
            strategy: definition.strategy,
            owner: draft.ownerAddress,
            usdcAmount,
            wethAmount,
            assets: draft.assets.map(
              ({ token, decimals, minimumWeightBps, maximumWeightBps }) => ({
                token,
                decimals,
                minimumWeightBps,
                maximumWeightBps,
              }),
            ),
            maximumTransactionValue: BigInt(draft.maximumTransactionValue),
            fee,
            priceOracle: oracle,
            priceMaxAgeSeconds: 86400,
            maximumPriceDeviationBps: 100,
            capacityEpoch: epoch,
            priceInput,
          },
        ]),
      });
      plan.capacityEpoch = epoch;
      plan.priceInput = priceInput;
      this.plans[spaceId] = plan;
      this.persist();
      this.saveSpaceChange({
        id: plan.activityId,
        spaceId,
        eventType: "SPACE_ACTIVATED",
        actor: draft.ownerAddress,
        status: "PENDING",
        payload: {
          authority: "fork-receipts",
          operation: "ACTIVATE",
          mode: "single-transaction",
        },
        createdAt: Math.floor(Date.now() / 1000),
      });
      return plan;
    }

    const vault = { address: treasury, abi: vaultAbi };
    const add = (label, contract, method, args) =>
      plan.steps.push({ label, transaction: this.tx(contract, method, args) });
    add("Create isolated treasury", vaultFactory, "createVault", [
      definition.positionIdHash,
    ]);
    add("Create owner-controlled policy", policyRegistry, "createPolicy", [
      definition.policyId,
      treasury,
      draft.ownerAddress,
      draft.assets.map(
        ({ token, decimals, minimumWeightBps, maximumWeightBps }) => ({
          token,
          decimals,
          minimumWeightBps,
          maximumWeightBps,
        }),
      ),
      BigInt(draft.maximumTransactionValue),
      {
        baseFeeBps: 20,
        slopeBps: 80,
        maximumFeeBps: 100,
        treasuryBaseFeeBps: 10,
        solverFeeBps: 5,
        protocolFeeBps: 5,
        treasuryFeeRecipient: treasury,
        protocolFeeRecipient: protocolRecipient,
      },
    ]);
    add(
      "Bind policy to this Space",
      policyRegistry,
      "setSettlementConfiguration",
      [
        definition.policyId,
        definition.positionIdHash,
        definition.strategyHash,
        oracle,
      ],
    );
    add(
      "Configure fork price protection",
      policyRegistry,
      "setPriceProtection",
      [definition.policyId, 86400n, 100],
    );
    for (const [token, amount, symbol] of [
      [usdc, usdcAmount, "USDC"],
      [weth, wethAmount, "WETH"],
    ]) {
      add(
        `Fund treasury with the reviewed ${symbol} amount`,
        { address: token, abi: erc20Abi },
        "transfer",
        [treasury, amount],
      );
      add(`Approve isolated ${symbol} settlement`, vault, "approve", [
        token,
        aqua.address,
        amount,
      ]);
      add(`Register ${symbol} in MockAqua`, aqua, "seed", [
        treasury,
        router,
        definition.strategyHash,
        token,
        amount,
      ]);
    }
    this.plans[spaceId] = plan;
    this.persist();
    this.saveSpaceChange({
      id: plan.activityId,
      spaceId,
      eventType: "SPACE_ACTIVATED",
      actor: draft.ownerAddress,
      status: "PENDING",
      payload: { authority: "fork-receipts", operation: "ACTIVATE" },
      createdAt: Math.floor(Date.now() / 1000),
    });
    return plan;
  }
  async markReconcileFailure(plan, index, error) {
    // RPC failure also makes the projection unavailable; keep receipt history for recovery.
    this.service.repository.setSpaceReceiptStatus(
      plan.definition.positionId,
      plan.receipts.slice(index).map((r) => r.hash),
      "FAILED",
    );
    this.providers?.delete(plan.definition.positionId);
    const space = this.service.getSpace(plan.definition.positionId);
    this.service.repository.saveSpaceIdentity(
      { ...space.identity, state: "FAILED" },
      undefined,
      "Setup receipt unavailable or orphaned; retry verification before trading.",
    );
    const remembered = plan.receipts[index] ?? plan.receipts.at(-1);
    // Only roll back a plan after proving the recorded block was orphaned.
    // Transient RPC errors keep the original receipts and never prompt duplicate funding.
    let orphaned = false;
    if (remembered?.blockNumber !== undefined) {
      try {
        const head = await this.client.getBlockNumber();
        orphaned =
          head < BigInt(remembered.blockNumber) ||
          !same(
            (
              await this.client.getBlock({
                blockNumber: BigInt(remembered.blockNumber),
              })
            ).hash,
            remembered.blockHash,
          );
      } catch {
        /* cannot establish a reorg while RPC is unavailable */
      }
    }
    if (orphaned) {
      plan.receipts = plan.receipts.slice(0, index);
      plan.complete = false;
      if (!plan.operation && index <= 10) plan.steps = plan.steps.slice(0, 10);
      this.persist();
    }
    throw error;
  }
  async reconcile(plan) {
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    const batchEnd = batch ? batch.startIndex + batch.coveredCount : undefined;
    let failureIndex = batch?.startIndex ?? 0;
    try {
      if (batch?.receiptHashes?.length) {
        if (plan.receipts.length < batchEnd)
          fail("Saved batch is missing one or more confirmed receipts");
        await verifySpaceBatchReceipts(
          this.client,
          this.manifest.chainId,
          plan.draft.ownerAddress,
          batch.calls,
          batch.receiptHashes,
          plan.minimumBlock,
          batch.atomic === true,
        );
        if (plan.operation)
          for (let index = batch.startIndex; index < batchEnd; index++) {
            failureIndex = index;
            await this.recordPolicyReceipt(plan, index);
          }
      }
      for (let i = 0; i < plan.receipts.length; i++) {
        if (batch && i >= batch.startIndex && i < batchEnd) continue;
        failureIndex = i;
        const remembered = plan.receipts[i];
        await verifySpaceReceipt(
          this.client,
          this.manifest.chainId,
          plan.draft.ownerAddress,
          plan.steps[i].transaction,
          remembered.hash,
        );
        if (plan.operation) await this.recordPolicyReceipt(plan, i);
      }
    } catch (error) {
      await this.markReconcileFailure(plan, failureIndex, error);
    }
    this.service.repository.setSpaceReceiptStatus(
      plan.definition.positionId,
      plan.receipts.map((r) => r.hash),
      "CONFIRMED",
    );
    this.persist();
  }
  async capacityStep(plan) {
    const provider = this.makeProvider(plan.definition);
    const snapshot = await provider.currentSnapshot();
    const fill = calculateDirectSettlement({
      portfolio: snapshot.portfolio,
      policy: snapshot.policy,
      fee: snapshot.fee,
      feeAccounting: snapshot.feeAccounting,
      traderInputToken: this.manifest.weth,
      traderOutputToken: this.manifest.usdc,
      requestedValue: snapshot.policy.maximumTransactionValue,
      capacityBaselineValue: snapshot.capacityEpoch.capacityBaselineValue,
      consumedBefore: 0n,
      capacityEpochId: snapshot.capacityEpochId,
      capacityEpoch: snapshot.capacityEpoch,
      priceProtection: snapshot.priceProtection,
    });
    if (fill.maximumSafeValue <= 0n)
      fail(
        "The funded portfolio has no capacity under these allocation bounds",
      );
    snapshot.capacityEpoch.capacityBaselineValue = fill.maximumSafeValue;
    snapshot.capacityEpochId = computeCapacityEpochId(snapshot.capacityEpoch);
    this.epochs[snapshot.capacityEpochId] = snapshot.capacityEpoch;
    this.saveEpochs();
    return {
      label: "Authorize trading capacity",
      transaction: this.tx(this.contracts.router, "activateCapacityEpoch", [
        plan.definition.policyId,
        contractEpoch(snapshot),
        contractPriceInput(snapshot),
      ]),
    };
  }
  async fundingPrerequisites(plan) {
    if (!plan.singleTransaction) return [];
    const { usdcAmount, wethAmount } = fundingUnits(plan.draft);
    const requirements = [
      [this.manifest.usdc, usdcAmount, "USDC"],
      [this.manifest.weth, wethAmount, "WETH"],
    ];
    const prerequisites = [];
    for (const [token, amount, symbol] of requirements) {
      const balance = await this.client.readContract({
        address: token,
        abi: this.contracts.erc20Abi,
        functionName: "balanceOf",
        args: [plan.draft.ownerAddress],
      });
      if (balance < amount)
        fail(
          `Insufficient ${symbol} funding: wallet has ${balance.toString()} raw units but the reviewed Space requires ${amount.toString()} raw units.`,
        );
      const allowance = await this.client.readContract({
        address: token,
        abi: this.contracts.erc20Abi,
        functionName: "allowance",
        args: [plan.draft.ownerAddress, this.contracts.vaultFactory.address],
      });
      if (allowance < amount)
        prerequisites.push({
          token,
          symbol,
          amount: amount.toString(),
          spender: this.contracts.vaultFactory.address,
          transaction: this.tx(
            { address: token, abi: this.contracts.erc20Abi },
            "approve",
            [this.contracts.vaultFactory.address, amount],
          ),
        });
    }
    return prerequisites;
  }
  planIdentity(plan) {
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    if (batch) return { id: batch.id, commitment: batch.commitment };
    const commitment = hashBytes(
      json({
        spaceId: plan.definition.positionId,
        operation: plan.operation ?? "ACTIVATE",
        owner: plan.draft.ownerAddress,
        chainId: this.manifest.chainId,
        steps: plan.steps,
      }),
    );
    return { id: hashBytes(`space-plan:${commitment}`), commitment };
  }
  assertPlanIdentity(plan, planId, planCommitment) {
    const expected = this.planIdentity(plan);
    if (planId !== undefined && !same(planId, expected.id))
      fail("Submitted setup does not match the reviewed plan");
    if (
      planCommitment !== undefined &&
      !same(planCommitment, expected.commitment)
    )
      fail("Submitted setup commitment does not match the reviewed plan");
  }
  async prepare(spaceId, operation = "ACTIVATE") {
    if (operation !== "ACTIVATE")
      return this.prepareOperation(spaceId, operation);
    const plan = await this.plan(spaceId);
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    if (batch?.recovery?.outcome === "REPAIR_REQUIRED")
      recoveryFail(
        "This partial wallet batch requires manual repair before setup can continue",
      );
    await this.reconcile(plan);
    if (
      !plan.singleTransaction &&
      plan.receipts.length === 10 &&
      plan.steps.length === 10
    ) {
      plan.steps.push(await this.capacityStep(plan));
      this.persist();
    }
    if (plan.receipts.length === plan.steps.length) {
      await this.activate(plan);
      return { complete: true, space: this.service.getSpace(spaceId) };
    }
    const step = plan.steps[plan.receipts.length];
    const identity = this.planIdentity(plan);
    const prerequisites = await this.fundingPrerequisites(plan);
    return {
      complete: false,
      spaceId,
      ownerAddress: plan.draft.ownerAddress,
      treasury: plan.treasury,
      step: plan.receipts.length,
      total: plan.singleTransaction ? 1 : 11,
      ...(plan.singleTransaction
        ? { mode: "single-transaction", prerequisites }
        : {}),
      // EIP-5792 capable wallets can authorize the authority-preserving setup
      // calls as one atomic wallet interaction. Capacity stays separate because
      // it is derived from the confirmed post-funding snapshot.
      batch:
        batch && plan.receipts.length === batch.startIndex
          ? batch.calls
          : undefined,
      batchPlanId: batch?.id,
      batchCommitment: batch?.commitment,
      planId: identity.id,
      planCommitment: identity.commitment,
      ...step,
    };
  }
  async verifyStep(plan, index, hash) {
    try {
      return await verifySpaceReceipt(
        this.client,
        this.manifest.chainId,
        plan.draft.ownerAddress,
        plan.steps[index].transaction,
        hash,
        plan.minimumBlock,
      );
    } catch (error) {
      if (error.code === "SPACE_TRANSACTION_REVERTED") {
        const spaceId = plan.definition.positionId;
        const space = this.service.getSpace(spaceId);
        const receipt = await this.client.getTransactionReceipt({ hash });
        const block = await this.client.getBlock({
          blockNumber: receipt.blockNumber,
        });
        if (!plan.operation)
          this.service.repository.saveSpaceIdentity(
            { ...space.identity, state: "FAILED" },
            undefined,
            error.message,
          );
        this.saveSpaceChange({
          id: plan.activityId ?? hashBytes(`failed:${spaceId}:${hash}`),
          spaceId,
          eventType: "SPACE_DEPLOYMENT_FAILED",
          actor: plan.draft.ownerAddress,
          status: "FAILED",
          receiptHash: hash,
          payload: {
            operation: plan.operation ?? "ACTIVATE",
            step: index,
            reason: error.message,
          },
          createdAt: Number(block.timestamp),
        });
      }
      throw error;
    }
  }
  async confirmTransaction(
    spaceId,
    stepIndex,
    hash,
    operation = "ACTIVATE",
    planId,
    planCommitment,
  ) {
    if (operation !== "ACTIVATE") {
      const plan = this.operations[`${spaceId}:${operation}`];
      if (!plan) fail("Prepare the policy change first");
      this.assertPlanIdentity(plan, planId, planCommitment);
      return this.confirmOperation(spaceId, operation, stepIndex, hash);
    }
    const plan = await this.plan(spaceId);
    this.assertPlanIdentity(plan, planId, planCommitment);
    await this.reconcile(plan);
    if (
      !Number.isInteger(stepIndex) ||
      stepIndex < 0 ||
      stepIndex >= plan.steps.length
    )
      fail("Unknown setup step");
    if (stepIndex < plan.receipts.length) {
      if (!same(plan.receipts[stepIndex].hash, hash))
        fail("Setup step already has a different receipt");
      return this.prepare(spaceId);
    }
    if (stepIndex !== plan.receipts.length)
      fail("Confirm setup steps in order");
    if (this.usedReceipts[hash.toLowerCase()])
      fail("Receipt has already been used");
    const receipt = await this.verifyStep(plan, stepIndex, hash);
    if (
      plan.minimumBlock !== undefined &&
      receipt.blockNumber <= BigInt(plan.minimumBlock)
    )
      fail("Receipt predates this prepared operation");
    this.usedReceipts[hash.toLowerCase()] = true;
    plan.receipts.push({
      hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(),
    });
    this.persist();
    const space = this.service.getSpace(spaceId);
    this.service.repository.saveSpaceIdentity({
      ...space.identity,
      treasuryAddress: plan.treasury,
      policyRegistryAddress: this.manifest.policyRegistry,
      state: "PENDING",
    });
    return this.prepare(spaceId);
  }

  /**
   * Re-check a submitted hash on the configured fork. This intentionally has
   * the same strict verification and state transition as confirm(), but is a
   * separate endpoint so a wallet/RPC that temporarily cannot return a receipt
   * never forces the browser to broadcast a replacement.
   */
  async reconcileTransaction(
    spaceId,
    stepIndex,
    hash,
    operation = "ACTIVATE",
    planId,
    planCommitment,
  ) {
    return this.confirmTransaction(
      spaceId,
      stepIndex,
      hash,
      operation,
      planId,
      planCommitment,
    );
  }

  /**
   * Permit a fresh send only after the missing hash and the relevant chain
   * state have been checked. The first setup step is the only retry that can
   * be proven harmless with the available chain evidence: the deterministic
   * vault must still have no code. All later missing hashes remain an explicit
   * repair case rather than risking a duplicate funding/configuration call.
   */
  async recoverTransaction(
    spaceId,
    stepIndex,
    hash,
    operation = "ACTIVATE",
    planId,
    planCommitment,
  ) {
    const plan =
      operation === "ACTIVATE"
        ? await this.plan(spaceId)
        : this.operations[`${spaceId}:${operation}`];
    if (!plan) fail("Prepare the reviewed setup first");
    this.assertPlanIdentity(plan, planId, planCommitment);
    // First ask the normal strict path to reconcile the submitted hash. A
    // recovery request is never allowed to turn a still-pending or successful
    // transaction into a replacement send.
    try {
      return await this.confirmTransaction(
        spaceId,
        stepIndex,
        hash,
        operation,
        planId,
        planCommitment,
      );
    } catch (error) {
      if (error?.code === "SPACE_TRANSACTION_PENDING")
        recoveryFail(
          "The submitted setup transaction is still pending; keep its identity and check again",
        );
      if (error?.code === "SPACE_RPC_UNAVAILABLE")
        recoveryFail(
          "The fork RPC could not determine whether the submitted setup transaction exists; keep it pending for reconciliation",
        );
      if (error?.code !== "SPACE_TRANSACTION_NOT_FOUND") throw error;
    }
    await this.reconcile(plan);
    if (
      !Number.isInteger(stepIndex) ||
      stepIndex < 0 ||
      stepIndex >= plan.steps.length
    )
      fail("Unknown setup step");
    if (stepIndex !== plan.receipts.length)
      fail("Cannot retry a setup step after later steps have been confirmed");
    if (this.usedReceipts[String(hash).toLowerCase()])
      fail(
        "The submitted receipt is already used; reconcile the saved setup first",
      );
    if (stepIndex !== 0 || operation !== "ACTIVATE")
      recoveryFail(
        "The submitted hash is unavailable and this operation has effects that cannot be proven absent; inspect the fork before retrying",
      );
    if (typeof this.client.getCode !== "function")
      recoveryFail(
        "The fork RPC cannot prove that the deterministic treasury was not created; keep the submitted hash for manual reconciliation",
      );
    let code;
    try {
      code = await this.client.getCode({ address: plan.treasury });
    } catch (error) {
      recoveryFail(
        `The fork RPC could not verify the deterministic treasury: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof code !== "string")
      recoveryFail(
        "The fork RPC returned no deterministic treasury code; keep the submitted hash for manual reconciliation",
      );
    if (code !== "0x")
      recoveryFail(
        "The deterministic treasury already exists; recover its canonical receipt before retrying so funding is not duplicated",
      );
    return operation === "ACTIVATE"
      ? this.prepare(spaceId)
      : this.prepareOperation(spaceId, operation);
  }

  async confirm(
    spaceId,
    stepIndex,
    hash,
    operation = "ACTIVATE",
    planId,
    planCommitment,
  ) {
    return this.confirmTransaction(
      spaceId,
      stepIndex,
      hash,
      operation,
      planId,
      planCommitment,
    );
  }

  async confirmBatch(
    spaceId,
    hashes,
    operation = "ACTIVATE",
    walletBatchId,
    batchPlanId,
    batchCommitment,
    atomic = false,
  ) {
    const plan =
      operation === "ACTIVATE"
        ? await this.plan(spaceId)
        : this.operations[`${spaceId}:${operation}`];
    if (!plan) fail("Prepare the reviewed batch first");
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    if (!batch) fail("No immutable batch plan is available for this Space");
    await this.reconcile(plan);
    const submittedHashes = Array.isArray(hashes) ? hashes : [];
    const sameHashList = (left, right) =>
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((hash, index) => same(hash, right[index]));
    if (batchPlanId && !same(batchPlanId, batch.id))
      fail("Submitted batch does not match the reviewed batch plan");
    if (batchCommitment && !same(batchCommitment, batch.commitment))
      fail("Submitted batch commitment does not match the reviewed calls");
    if (batch.walletBatchId && walletBatchId !== batch.walletBatchId)
      fail("Submitted wallet batch does not match the saved batch");
    if (batch.receiptHashes) {
      if (batch.atomic !== atomic)
        fail("Submitted batch atomicity does not match the saved result");
      if (!sameHashList(submittedHashes, batch.receiptHashes))
        fail("Submitted batch does not match the saved receipts");
      return operation === "ACTIVATE"
        ? this.prepare(spaceId)
        : this.prepareOperation(spaceId, operation);
    }
    if (plan.receipts.length !== batch.startIndex)
      fail("The reviewed batch cannot cover already confirmed steps");
    if (
      submittedHashes.length !== 1 &&
      submittedHashes.length !== batch.coveredCount
    )
      fail("Unsupported batch receipt shape");
    for (const hash of submittedHashes)
      if (this.usedReceipts[String(hash).toLowerCase()])
        fail("Receipt has already been used");
    const receipts = await verifySpaceBatchReceipts(
      this.client,
      this.manifest.chainId,
      plan.draft.ownerAddress,
      batch.calls,
      submittedHashes,
      plan.minimumBlock,
      atomic,
    );
    const evidence = receipts[0];
    for (const hash of submittedHashes)
      this.usedReceipts[hash.toLowerCase()] = true;
    batch.walletBatchId = walletBatchId;
    batch.atomic = atomic;
    batch.receiptHashes = submittedHashes;
    // Keep one logical entry per covered step so existing step/recovery indexes
    // remain stable; the immutable batch plan marks them for one-time reconciliation.
    plan.receipts.push(
      ...Array.from({ length: batch.coveredCount }, (_, batchIndex) => {
        const receipt = receipts[batchIndex] ?? evidence;
        return {
          hash:
            submittedHashes.length === 1
              ? submittedHashes[0]
              : submittedHashes[batchIndex],
          batchHashes: submittedHashes,
          batchIndex: batch.startIndex + batchIndex,
          batchStartIndex: batch.startIndex,
          batchPlanId: batch.id,
          batchCommitment: batch.commitment,
          walletBatchId,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber.toString(),
        };
      }),
    );
    this.persist();
    if (operation === "ACTIVATE") {
      const space = this.service.getSpace(spaceId);
      this.service.repository.saveSpaceIdentity({
        ...space.identity,
        treasuryAddress: plan.treasury,
        policyRegistryAddress: this.manifest.policyRegistry,
        state: "PENDING",
      });
      return this.prepare(spaceId);
    }
    return this.prepareOperation(spaceId, operation);
  }

  /**
   * Reconcile a terminal wallet status before the browser is allowed to forget
   * its saved batch identity. A full atomic revert can be retried; a partial
   * result can continue only when the server proves it is a successful direct
   * prefix of the frozen plan.
   */
  async reconcileBatch(
    spaceId,
    hashes,
    operation = "ACTIVATE",
    walletBatchId,
    batchPlanId,
    batchCommitment,
    atomic,
    status,
  ) {
    const plan =
      operation === "ACTIVATE"
        ? await this.plan(spaceId)
        : this.operations[`${spaceId}:${operation}`];
    if (!plan) fail("Prepare the reviewed batch first");
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    if (!batch) fail("No immutable batch plan is available for this Space");
    const submittedHashes = Array.isArray(hashes) ? hashes : [];
    if (!walletBatchId || typeof walletBatchId !== "string")
      recoveryFail("A wallet batch identifier is required for reconciliation");
    if (status !== 500 && status !== 600)
      recoveryFail(
        "Only terminal or partial wallet outcomes can be reconciled",
      );
    if (!same(batchPlanId, batch.id))
      recoveryFail("Failed batch does not match the reviewed batch plan");
    if (!same(batchCommitment, batch.commitment))
      recoveryFail("Failed batch commitment does not match the reviewed calls");
    if (batch.recovery?.outcome === "REPAIR_REQUIRED")
      recoveryFail(
        "This partial wallet batch requires manual repair before setup can continue",
      );

    // A lost HTTP response must be safe to repeat. The first successful
    // reconciliation records the terminal wallet identity independently of
    // the active submission fields below.
    if (
      batch.recovery?.walletBatchId === walletBatchId &&
      batch.recovery.status === status &&
      batch.recovery.atomic === atomic &&
      sameHashList(submittedHashes, batch.recovery.hashes)
    )
      return operation === "ACTIVATE"
        ? this.prepare(spaceId)
        : this.prepareOperation(spaceId, operation);

    if (batch.walletBatchId && batch.walletBatchId !== walletBatchId)
      recoveryFail("Failed batch does not match the saved wallet batch");
    if (plan.receipts.length !== batch.startIndex)
      recoveryFail("Cannot reconcile a batch after another step has advanced");
    if (
      submittedHashes.some(
        (hash) => this.usedReceipts[String(hash).toLowerCase()],
      )
    )
      recoveryFail(
        "A failed batch receipt was already used by another operation",
      );

    let receipts;
    if (status === 500) {
      if (atomic !== true || submittedHashes.length === 0)
        recoveryFail(
          "A complete revert is retryable only when the wallet proves atomic execution",
        );
      const calls = [];
      receipts = [];
      for (const hash of submittedHashes) {
        const receipt = await canonicalReceipt(
          this.client,
          this.manifest.chainId,
          plan.draft.ownerAddress,
          hash,
          plan.minimumBlock,
          true,
        );
        if (!isRevertedReceipt(receipt))
          recoveryFail(
            "The wallet reported a full revert but a receipt succeeded",
          );
        let trace;
        try {
          trace = await this.client.request({
            method: "debug_traceTransaction",
            params: [hash, { tracer: "callTracer" }],
          });
        } catch {
          recoveryFail(
            "The fork RPC cannot verify the reverted wallet execution trace",
          );
        }
        if (!traceHasFailure(trace))
          recoveryFail(
            "The reverted wallet receipt has no verified failure trace",
          );
        calls.push(...ownerCalls(trace, plan.draft.ownerAddress));
        receipts.push(receipt);
      }
      if (
        calls.length !== batch.calls.length ||
        calls.some((call, index) => !sameCall(call, batch.calls[index]))
      )
        recoveryFail(
          "The reverted receipt does not contain exactly the reviewed calls",
        );

      const firstBlock = await this.client.getBlock({
        blockNumber: receipts[0].blockNumber,
      });
      this.saveSpaceChange({
        id: hashBytes(`batch-reverted:${spaceId}:${walletBatchId}`),
        spaceId,
        eventType: "SPACE_DEPLOYMENT_FAILED",
        actor: plan.draft.ownerAddress,
        status: "FAILED",
        receiptHash: submittedHashes[0],
        payload: {
          operation,
          batchPlanId: batch.id,
          batchCommitment: batch.commitment,
          walletBatchId,
          status,
          atomic,
          hashes: submittedHashes,
          outcome: "RETRYABLE_FULL_REVERT",
        },
        createdAt: Number(firstBlock.timestamp ?? 0),
      });
      if (!plan.operation) {
        const space = this.service.getSpace(spaceId);
        this.service.repository.saveSpaceIdentity(
          { ...space.identity, state: "FAILED" },
          undefined,
          "The submitted setup batch reverted completely; server verification permits a safe retry.",
        );
      }
      batch.recovery = {
        status,
        atomic,
        walletBatchId,
        hashes: submittedHashes,
        outcome: "RETRYABLE_FULL_REVERT",
      };
      delete batch.walletBatchId;
      delete batch.receiptHashes;
      delete batch.atomic;
    } else {
      if (atomic === true || submittedHashes.length === 0)
        recoveryFail(
          "A partial wallet outcome can continue only from successful direct receipts",
        );
      if (submittedHashes.length >= batch.coveredCount)
        recoveryFail(
          "The partial outcome is not a bounded continuation prefix",
        );
      receipts = [];
      for (let index = 0; index < submittedHashes.length; index++) {
        try {
          const receipt = await verifySpaceReceipt(
            this.client,
            this.manifest.chainId,
            plan.draft.ownerAddress,
            batch.calls[index],
            submittedHashes[index],
            plan.minimumBlock,
          );
          receipts.push(receipt);
        } catch (error) {
          if (error.code !== "SPACE_TRANSACTION_REVERTED") throw error;
          for (
            let prefixIndex = 0;
            prefixIndex < receipts.length;
            prefixIndex++
          ) {
            const receipt = receipts[prefixIndex];
            const hash = submittedHashes[prefixIndex];
            this.usedReceipts[hash.toLowerCase()] = true;
            plan.receipts.push({
              hash,
              batchHashes: submittedHashes,
              batchIndex: batch.startIndex + prefixIndex,
              batchStartIndex: batch.startIndex,
              batchPlanId: batch.id,
              batchCommitment: batch.commitment,
              walletBatchId,
              blockHash: receipt.blockHash,
              blockNumber: receipt.blockNumber.toString(),
            });
          }
          batch.recovery = {
            status,
            atomic,
            walletBatchId,
            hashes: submittedHashes,
            outcome: "REPAIR_REQUIRED",
            failedIndex: batch.startIndex + index,
            reason: error.message,
          };
          this.persist();
          recoveryFail(
            "The partial batch contains a verified reverted call; manual repair is required",
          );
        }
      }
      for (let index = 0; index < receipts.length; index++) {
        const receipt = receipts[index];
        this.usedReceipts[submittedHashes[index].toLowerCase()] = true;
        plan.receipts.push({
          hash: submittedHashes[index],
          batchHashes: submittedHashes,
          batchIndex: batch.startIndex + index,
          batchStartIndex: batch.startIndex,
          batchPlanId: batch.id,
          batchCommitment: batch.commitment,
          walletBatchId,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber.toString(),
        });
      }
      batch.recovery = {
        status,
        atomic,
        walletBatchId,
        hashes: submittedHashes,
        outcome: "CONTINUED_SUCCESSFUL_PREFIX",
        recoveredCount: receipts.length,
      };
      delete batch.walletBatchId;
      delete batch.receiptHashes;
      delete batch.atomic;
    }
    this.persist();
    return operation === "ACTIVATE"
      ? this.prepare(spaceId)
      : this.prepareOperation(spaceId, operation);
  }

  async prepareOperation(spaceId, operation) {
    if (!["UPDATE", "PAUSE", "RESUME", "REACTIVATE"].includes(operation))
      fail("Unsupported chain operation");
    const space = this.service.getSpace(spaceId);
    const definition = this.definitions.find((d) => d.positionId === spaceId);
    const provider = this.providers.get(spaceId);
    if (!definition || !provider || !space.position)
      fail("Activate this Space first");
    const snapshot = await provider.currentSnapshot();
    if (!same(snapshot.chainPolicy.governance, space.identity.ownerAddress))
      fail("Space governance has changed");
    const key = `${spaceId}:${operation}`;
    let plan = this.operations[key];
    if (!plan || plan.complete) {
      const draft = space.draft;
      const matches =
        operation === "UPDATE"
          ? draft &&
            BigInt(draft.maximumTransactionValue) ===
              snapshot.policy.maximumTransactionValue &&
            draft.assets.every((asset) => {
              const actual = snapshot.portfolio.assets.find((a) =>
                same(a.token, asset.token),
              );
              return (
                actual &&
                Number(actual.minimumWeightBps) === asset.minimumWeightBps &&
                Number(actual.maximumWeightBps) === asset.maximumWeightBps
              );
            })
          : operation === "REACTIVATE"
            ? false
            : snapshot.chainPolicy.paused === (operation === "PAUSE");
      if (matches) return { complete: true, space };
      if (plan?.complete) this.history.push(plan);
      plan = {
        minimumBlock: (await this.client.getBlockNumber()).toString(),
        definition,
        draft: draft ?? { ownerAddress: space.identity.ownerAddress },
        operation,
        steps: [],
        receipts: [],
        complete: false,
        treasury: space.identity.treasuryAddress,
        activityId: hashBytes(
          `chain-operation:${spaceId}:${operation}:${space.identity.ownerAddress}:${Date.now()}`,
        ),
      };
      if (operation === "UPDATE") {
        if (!draft) fail("Save the signed policy draft first");
        // Widen first so each individually checked update preserves feasible totals.
        for (const asset of draft.assets)
          plan.steps.push({
            label: `Prepare ${asset.symbol} bounds`,
            transaction: this.tx(
              this.contracts.policyRegistry,
              "updateAssetBounds",
              [definition.policyId, asset.token, 0, 10000],
            ),
          });
        for (const asset of draft.assets)
          plan.steps.push({
            label: `Apply ${asset.symbol} bounds`,
            transaction: this.tx(
              this.contracts.policyRegistry,
              "updateAssetBounds",
              [
                definition.policyId,
                asset.token,
                asset.minimumWeightBps,
                asset.maximumWeightBps,
              ],
            ),
          });
        plan.steps.push({
          label: "Apply transaction limit",
          transaction: this.tx(
            this.contracts.policyRegistry,
            "setMaximumTransactionValue",
            [definition.policyId, BigInt(draft.maximumTransactionValue)],
          ),
        });
      } else if (operation === "REACTIVATE") {
        plan.steps.push(await this.capacityStep(plan));
        plan.capacityPlanned = true;
      } else
        plan.steps.push({
          label: operation === "PAUSE" ? "Pause trading" : "Resume trading",
          transaction: this.tx(this.contracts.policyRegistry, "setPaused", [
            definition.policyId,
            operation === "PAUSE",
          ]),
        });
      this.operations[key] = plan;
      this.persist();
      this.saveSpaceChange({
        id: plan.activityId,
        spaceId,
        eventType:
          operation === "PAUSE"
            ? "SPACE_PAUSED"
            : operation === "RESUME"
              ? "SPACE_RESUMED"
              : operation === "REACTIVATE"
                ? "SPACE_REACTIVATED"
                : "SPACE_UPDATED",
        actor: space.identity.ownerAddress,
        status: "PENDING",
        payload: { authority: "fork-receipts", operation },
        createdAt: Math.floor(Date.now() / 1000),
      });
    }
    const batch = ensureBatchPlan(plan, this.manifest.chainId);
    if (batch?.recovery?.outcome === "REPAIR_REQUIRED")
      recoveryFail(
        "This partial wallet batch requires manual repair before setup can continue",
      );
    await this.reconcile(plan);
    if (
      (operation === "UPDATE" || operation === "RESUME") &&
      plan.receipts.length === plan.steps.length &&
      !plan.capacityPlanned
    ) {
      plan.steps.push(await this.capacityStep(plan));
      plan.capacityPlanned = true;
      this.persist();
    }
    if (plan.receipts.length === plan.steps.length) {
      const current = await provider.currentSnapshot();
      if (operation === "UPDATE") {
        if (
          current.policy.maximumTransactionValue !==
            BigInt(plan.draft.maximumTransactionValue) ||
          !plan.draft.assets.every((asset) => {
            const actual = current.portfolio.assets.find((a) =>
              same(a.token, asset.token),
            );
            return (
              actual &&
              Number(actual.minimumWeightBps) === asset.minimumWeightBps &&
              Number(actual.maximumWeightBps) === asset.maximumWeightBps
            );
          })
        )
          fail("Policy update no longer matches the reviewed rules");
      } else if (current.chainPolicy.paused !== (operation === "PAUSE"))
        fail("Policy pause state does not match the transaction");
      const position = positionForSnapshot(
        current,
        this.manifest.policyRegistry,
        plan.treasury,
      );
      position.name = space.identity.name;
      this.service.repository.savePosition(position);
      plan.complete = true;
      this.persist();
      return { complete: true, space: this.service.getSpace(spaceId) };
    }
    const identity = this.planIdentity(plan);
    return {
      complete: false,
      spaceId,
      ownerAddress: space.identity.ownerAddress,
      treasury: plan.treasury,
      step: plan.receipts.length,
      total: plan.steps.length,
      batch:
        batch && plan.receipts.length === batch.startIndex
          ? batch.calls
          : undefined,
      batchPlanId: batch?.id,
      batchCommitment: batch?.commitment,
      planId: identity.id,
      planCommitment: identity.commitment,
      ...plan.steps[plan.receipts.length],
    };
  }
  async confirmOperation(spaceId, operation, index, hash) {
    if (!["UPDATE", "PAUSE", "RESUME", "REACTIVATE"].includes(operation))
      fail("Unsupported chain operation");
    const plan = this.operations[`${spaceId}:${operation}`];
    if (
      !plan ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= plan.steps.length
    )
      fail("Prepare the policy change first");
    await this.reconcile(plan);
    if (index < plan.receipts.length) {
      if (!same(plan.receipts[index].hash, hash))
        fail("This step was already confirmed with another hash");
      if (plan.complete)
        return { complete: true, space: this.service.getSpace(spaceId) };
      return this.prepareOperation(spaceId, operation);
    }
    if (index !== plan.receipts.length) fail("Confirm policy steps in order");
    if (this.usedReceipts[hash.toLowerCase()]) fail("Receipt already used");
    const receipt = await this.verifyStep(plan, index, hash);
    if (
      plan.minimumBlock !== undefined &&
      receipt.blockNumber <= BigInt(plan.minimumBlock)
    )
      fail("Receipt predates this prepared operation");
    this.usedReceipts[hash.toLowerCase()] = true;
    plan.receipts.push({
      hash,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber.toString(),
    });
    this.persist();
    await this.recordPolicyReceipt(plan, index);
    return this.prepareOperation(spaceId, operation);
  }
  async recordPolicyReceipt(plan, index) {
    const receipt = plan.receipts[index];
    const spaceId = plan.definition.positionId;
    const operation = plan.operation;
    const block = await this.client.getBlock({
      blockNumber: BigInt(receipt.blockNumber),
    });
    this.saveSpaceChange({
      id:
        plan.activityId ?? hashBytes(`policy-step:${spaceId}:${receipt.hash}`),
      spaceId,
      eventType:
        operation === "PAUSE"
          ? "SPACE_PAUSED"
          : operation === "RESUME"
            ? "SPACE_RESUMED"
            : operation === "REACTIVATE"
              ? "SPACE_REACTIVATED"
              : "SPACE_UPDATED",
      actor: plan.draft.ownerAddress,
      status: "CONFIRMED",
      receiptHash: receipt.hash,
      payload: { authority: "fork-receipts", operation, step: index },
      createdAt: Number(block.timestamp),
    });
  }
  async activate(plan) {
    const provider = this.makeProvider(plan.definition);
    const snapshot = await provider.currentSnapshot();
    if (plan.singleTransaction) {
      const active = await this.client.readContract({
        ...this.contracts.router,
        functionName: "capacityState",
        args: [
          plan.definition.positionIdHash,
          this.manifest.weth,
          this.manifest.usdc,
        ],
      });
      if (!active.capacityEpochId || same(active.capacityEpochId, ZERO_HASH))
        fail(
          "Single-transaction Space creation did not authorize trading capacity",
        );
      const epoch = {
        ...snapshot.capacityEpoch,
        capacityBaselineValue: active.capacityBaselineValue,
        consumedBefore: active.consumedValue,
      };
      const expectedId = computeCapacityEpochId(epoch);
      if (!same(expectedId, active.capacityEpochId))
        fail(
          "Capacity receipt does not match the authoritative post-funding epoch",
        );
      this.epochs[active.capacityEpochId] = epoch;
      this.saveEpochs();
      snapshot.capacityEpoch = epoch;
      snapshot.capacityEpochId = active.capacityEpochId;
    }
    const policy = snapshot.chainPolicy;
    const configuration = await this.client.readContract({
      ...this.contracts.policyRegistry,
      functionName: "settlementConfiguration",
      args: [plan.definition.policyId, plan.definition.positionIdHash],
    });
    if (
      !same(configuration.aquaStrategyHash, plan.definition.strategyHash) ||
      !same(configuration.priceOracle, this.manifest.oracle)
    )
      fail("Settlement configuration differs from this Space");
    const vaultOwner = await this.client.readContract({
      address: plan.treasury,
      abi: this.contracts.vaultAbi,
      functionName: "owner",
    });
    if (!same(vaultOwner, plan.draft.ownerAddress))
      fail("Treasury owner differs from the Space owner");
    if (
      !same(policy.governance, plan.draft.ownerAddress) ||
      !same(policy.treasury, plan.treasury) ||
      !same(snapshot.aquaStrategyHash, plan.definition.strategyHash)
    )
      fail("Onchain Space authority does not match setup");
    if (
      policy.priceMaxAgeSeconds !== 86400 ||
      Number(policy.maximumPriceDeviationBps) !== 100
    )
      fail("Onchain price protection differs from the reviewed setup");
    if (!plan.complete) {
      if (
        policy.paused ||
        policy.maximumTransactionValue !==
          BigInt(plan.draft.maximumTransactionValue)
      )
        fail("Policy state does not match the reviewed draft");
      for (const asset of plan.draft.assets) {
        const actual = snapshot.portfolio.assets.find((a) =>
          same(a.token, asset.token),
        );
        if (
          !actual ||
          Number(actual.decimals) !== asset.decimals ||
          Number(actual.minimumWeightBps) !== asset.minimumWeightBps ||
          Number(actual.maximumWeightBps) !== asset.maximumWeightBps
        )
          fail("Onchain asset bounds differ from the draft");
        const amounts = fundingUnits(plan.draft);
        const amount = same(asset.token, this.manifest.usdc)
          ? amounts.usdcAmount
          : amounts.wethAmount;
        const token = { address: asset.token, abi: this.contracts.erc20Abi };
        const balance = await this.client.readContract({
          ...token,
          functionName: "balanceOf",
          args: [plan.treasury],
        });
        const allowance = await this.client.readContract({
          ...token,
          functionName: "allowance",
          args: [plan.treasury, this.manifest.aqua],
        });
        if (
          balance !== amount ||
          allowance !== amount ||
          actual.balance !== amount
        )
          fail(
            "Isolated treasury funding or allowance differs from the reviewed amount",
          );
      }
      const active = await this.client.readContract({
        ...this.contracts.router,
        functionName: "capacityState",
        args: [
          plan.definition.positionIdHash,
          this.manifest.weth,
          this.manifest.usdc,
        ],
      });
      if (
        !same(active.capacityEpochId, snapshot.capacityEpochId) ||
        !this.epochs[active.capacityEpochId] ||
        active.capacityBaselineValue === 0n
      )
        fail("Trading capacity is not authorized");
    }
    if (plan.singleTransaction) {
      const receipt = await this.client.getTransactionReceipt({
        hash: plan.receipts[0].hash,
      });
      const eventAbi = this.contracts.vaultFactory.abi.find(
        (item) => item.type === "event" && item.name === "SpaceInitialized",
      );
      const initialized = receipt.logs
        .filter((log) => same(log.address, this.contracts.vaultFactory.address))
        .map((log) => {
          try {
            return decodeEventLog({
              abi: [eventAbi],
              data: log.data,
              topics: log.topics,
            });
          } catch {
            return undefined;
          }
        })
        .find((decoded) => decoded?.eventName === "SpaceInitialized");
      const args = initialized?.args;
      if (
        !args ||
        !same(args.spaceId, plan.definition.positionIdHash) ||
        !same(args.policyId, plan.definition.policyId) ||
        !same(args.owner, plan.draft.ownerAddress) ||
        !same(args.vault, plan.treasury) ||
        args.usdcAmount !== fundingUnits(plan.draft).usdcAmount ||
        args.wethAmount !== fundingUnits(plan.draft).wethAmount
      )
        fail(
          "Initialization receipt does not match the reviewed Space identity and funding",
        );
    }
    this.providers.set(plan.definition.positionId, provider);
    if (
      !this.definitions.some((d) => d.positionId === plan.definition.positionId)
    )
      this.definitions.push({ ...plan.definition, lifecycle: true });
    this.saveManifest();
    const position = positionForSnapshot(
      snapshot,
      this.manifest.policyRegistry,
      plan.treasury,
    );
    position.name = this.service.getSpace(
      plan.definition.positionId,
    ).identity.name;
    this.service.repository.savePosition(position);
    this.service.repository.saveSpaceIdentity({
      id: position.id,
      name: position.name,
      ownerAddress: position.owner,
      controllerAddress: policy.governance,
      treasuryAddress: position.treasury,
      chainId: position.chainId,
      policyId: position.policy.id,
      strategyId: plan.definition.strategyHash,
      policyRegistryAddress: position.policy.registry,
      mode: "fork",
      state: policy.paused ? "PAUSED" : "ACTIVE",
    });
    const last = plan.receipts.at(-1);
    const block = await this.client.getBlock({
      blockNumber: BigInt(last.blockNumber),
    });
    this.saveSpaceChange({
      id: plan.activityId ?? hashBytes(`activate:${position.id}:${last.hash}`),
      spaceId: position.id,
      eventType: "SPACE_ACTIVATED",
      actor: position.owner,
      status: "CONFIRMED",
      receiptHash: last.hash,
      payload: {
        treasury: plan.treasury,
        setupReceipts: plan.receipts,
        authority: "fork-receipts",
      },
      createdAt: Number(block.timestamp),
    });
    plan.complete = true;
    this.persist();
  }
}
