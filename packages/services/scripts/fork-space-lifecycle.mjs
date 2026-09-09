import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { hashBytes, ServiceError } from "../dist/index.js";
import {
  calculateDirectSettlement,
  computeCapacityEpochId,
} from "@aurka/shared";
import {
  contractEpoch,
  contractPriceInput,
  positionForSnapshot,
} from "./chain-snapshot.mjs";

const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
const fail = (message) => {
  throw new ServiceError("SPACE_CHAIN_VERIFICATION_FAILED", message, 409);
};
const json = (value) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );

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
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
  ]);
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
  tx(contract, functionName, args) {
    return {
      to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName, args }),
      value: "0x0",
    };
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
    // The local creation flow funds a fixed, disclosed 35,000 USDC + 5 WETH portfolio.
    // Reject incompatible ranges before asking the wallet to move funds.
    for (const asset of draft.assets) {
      const value = same(asset.token, this.manifest.usdc) ? 35000n : 16000n;
      if (
        value * 10000n < 51000n * BigInt(asset.minimumWeightBps) ||
        value * 10000n > 51000n * BigInt(asset.maximumWeightBps)
      )
        fail(
          "These bounds exclude the initial 35,000 USDC / 5 WETH funding allocation. Adjust the draft before deployment.",
        );
    }
    const definition = {
      positionId: spaceId,
      name: draft.name,
      policyId: hashBytes(`policy:${spaceId}`),
      positionIdHash: hashBytes(spaceId),
      strategyHash: hashBytes(`strategy:${spaceId}`),
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
    };
    const { policyRegistry, vaultFactory, vaultAbi, erc20Abi, aqua } =
      this.contracts;
    const { usdc, weth, oracle, router, protocolRecipient } = this.manifest;
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
      [usdc, 35000n * 1000000n, "USDC"],
      [weth, 5n * 10n ** 18n, "WETH"],
    ]) {
      add(
        `Fund treasury with ${symbol === "USDC" ? "35,000 USDC" : "5 WETH"}`,
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
    return plan;
  }
  async reconcile(plan) {
    for (let i = 0; i < plan.receipts.length; i++) {
      const remembered = plan.receipts[i];
      try {
        await verifySpaceReceipt(
          this.client,
          this.manifest.chainId,
          plan.draft.ownerAddress,
          plan.steps[i].transaction,
          remembered.hash,
        );
        if (plan.operation) await this.recordPolicyReceipt(plan, i);
      } catch (error) {
        // RPC failure also makes the projection unavailable; keep receipt history for recovery.
        this.service.repository.setSpaceReceiptStatus(
          plan.definition.positionId,
          plan.receipts.slice(i).map((r) => r.hash),
          "FAILED",
        );
        this.providers.delete(plan.definition.positionId);
        const space = this.service.getSpace(plan.definition.positionId);
        this.service.repository.saveSpaceIdentity(
          { ...space.identity, state: "FAILED" },
          undefined,
          "Setup receipt unavailable or orphaned; retry verification before trading.",
        );
        // Only roll back a plan after proving the recorded block was orphaned.
        // Transient RPC errors keep the original receipts and never prompt duplicate funding.
        let orphaned = false;
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
        if (orphaned) {
          plan.receipts = plan.receipts.slice(0, i);
          plan.complete = false;
          if (!plan.operation && i <= 10) plan.steps = plan.steps.slice(0, 10);
          this.persist();
        }
        throw error;
      }
    }
    this.service.repository.setSpaceReceiptStatus(
      plan.definition.positionId,
      plan.receipts.map((r) => r.hash),
      "CONFIRMED",
    );
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
  async prepare(spaceId, operation = "ACTIVATE") {
    if (operation !== "ACTIVATE")
      return this.prepareOperation(spaceId, operation);
    const plan = await this.plan(spaceId);
    await this.reconcile(plan);
    if (plan.receipts.length === 10 && plan.steps.length === 10) {
      plan.steps.push(await this.capacityStep(plan));
      this.persist();
    }
    if (plan.receipts.length === plan.steps.length) {
      await this.activate(plan);
      return { complete: true, space: this.service.getSpace(spaceId) };
    }
    const step = plan.steps[plan.receipts.length];
    return {
      complete: false,
      spaceId,
      ownerAddress: plan.draft.ownerAddress,
      treasury: plan.treasury,
      step: plan.receipts.length,
      total: 11,
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
        this.service.repository.saveSpaceChange({
          id: hashBytes(`failed:${spaceId}:${hash}`),
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
  async confirm(spaceId, stepIndex, hash, operation = "ACTIVATE") {
    if (operation !== "ACTIVATE")
      return this.confirmOperation(spaceId, operation, stepIndex, hash);
    const plan = await this.plan(spaceId);
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

  async prepareOperation(spaceId, operation) {
    if (!["UPDATE", "PAUSE", "RESUME"].includes(operation))
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
    }
    await this.reconcile(plan);
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
    return {
      complete: false,
      spaceId,
      ownerAddress: space.identity.ownerAddress,
      treasury: plan.treasury,
      step: plan.receipts.length,
      total: plan.steps.length,
      ...plan.steps[plan.receipts.length],
    };
  }
  async confirmOperation(spaceId, operation, index, hash) {
    if (!["UPDATE", "PAUSE", "RESUME"].includes(operation))
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
    this.service.repository.saveSpaceChange({
      id: hashBytes(`policy-step:${spaceId}:${receipt.hash}`),
      spaceId,
      eventType:
        operation === "PAUSE"
          ? "SPACE_PAUSED"
          : operation === "RESUME"
            ? "SPACE_RESUMED"
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
        const amount = same(asset.token, this.manifest.usdc)
          ? 35000n * 1000000n
          : 5n * 10n ** 18n;
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
        if (balance < amount || allowance < amount || actual.balance !== amount)
          fail("Isolated treasury funding or allowance is insufficient");
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
    this.service.repository.saveSpaceChange({
      id: hashBytes(`activate:${position.id}:${last.hash}`),
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
