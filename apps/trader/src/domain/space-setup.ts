import type { SpaceRecord } from "@aurka/shared";
import { apiBaseUrl, supportedChainId } from "../config";

type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};
type ForkAnchor = {
  blockNumber: string;
  blockHash: string;
};
type Setup = {
  complete: boolean;
  space?: SpaceRecord;
  ownerAddress: string;
  treasury: string;
  step: number;
  total: number;
  label: string;
  transaction: { to: string; data: string; value: string };
  mode?: "single-transaction";
  gasEstimate?: string;
  prerequisites?: readonly {
    token: string;
    symbol: string;
    amount: string;
    spender: string;
    transaction: { to: string; data: string; value: string };
  }[];
  batch?: readonly { to: string; data: string; value: string }[];
  batchPlanId?: string;
  batchCommitment?: string;
  planId?: string;
  planCommitment?: string;
  forkGeneration?: string;
  forkAnchor?: ForkAnchor;
  observedBlock?: { blockNumber: string; blockHash: string };
};

type CallsStatus = {
  id: string;
  chainId: string;
  status: number;
  atomic: boolean;
  receipts?: readonly { transactionHash: string; status?: string }[];
};
type SavedBatch = {
  id: string;
  planId: string;
  commitment: string;
  spaceId: string;
  operation: string;
  owner: string;
  chainId: number;
  forkGeneration?: string;
};
type SavedSubmission = {
  step: number;
  hash: string;
  spaceId?: string;
  operation?: string;
  owner?: string;
  chainId?: number;
  forkGeneration?: string;
  planId?: string;
  planCommitment?: string;
};

type SavedApproval = {
  token: string;
  spender: string;
  amount: string;
  hash: string;
  owner: string;
  chainId: number;
  forkGeneration?: string;
};

export type SetupRecoveryState =
  | "pending"
  | "confirmation-unavailable"
  | "testnet-mismatch"
  | "action-required";

export class SetupRecoveryError extends Error {
  constructor(
    readonly state: SetupRecoveryState,
    message: string,
    readonly transactionHash?: string,
  ) {
    super(message);
    this.name = "SetupRecoveryError";
  }
}

class SetupRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SetupRequestError";
  }
}

export function parseSendCallsResult(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0
  )
    throw new Error("Wallet returned a malformed atomic setup identifier.");
  return value.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function parseSetup(value: unknown): Setup {
  if (!isRecord(value) || typeof value.complete !== "boolean")
    throw new Error("Testnet setup returned a malformed response.");
  if (value.complete) {
    if (!value.space || !isRecord(value.space))
      throw new Error("Testnet setup completed without a verified Space.");
    return value as unknown as Setup;
  }
  const transaction = value.transaction;
  if (
    !isRecord(transaction) ||
    typeof transaction.to !== "string" ||
    typeof transaction.data !== "string" ||
    typeof transaction.value !== "string"
  )
    throw new Error(
      "The testnet did not return the transaction for the current setup step; check the setup state before retrying.",
    );
  if (value.prerequisites !== undefined) {
    if (!Array.isArray(value.prerequisites))
      throw new Error(
        "Testnet setup returned malformed approval prerequisites.",
      );
    for (const prerequisite of value.prerequisites) {
      if (
        !isRecord(prerequisite) ||
        typeof prerequisite.token !== "string" ||
        typeof prerequisite.symbol !== "string" ||
        typeof prerequisite.amount !== "string" ||
        typeof prerequisite.spender !== "string" ||
        !isRecord(prerequisite.transaction) ||
        typeof prerequisite.transaction.to !== "string" ||
        typeof prerequisite.transaction.data !== "string" ||
        typeof prerequisite.transaction.value !== "string"
      )
        throw new Error(
          "Testnet setup returned malformed approval prerequisites.",
        );
    }
  }
  return value as unknown as Setup;
}

function parseSavedApproval(value: string): SavedApproval {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed.token !== "string" ||
      typeof parsed.spender !== "string" ||
      typeof parsed.amount !== "string" ||
      typeof parsed.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.hash) ||
      typeof parsed.owner !== "string" ||
      parsed.chainId !== supportedChainId
    )
      throw new Error();
    return parsed as unknown as SavedApproval;
  } catch {
    throw new SetupRecoveryError(
      "action-required",
      "Saved token approval state is malformed. Inspect or clear it before approving another transaction.",
    );
  }
}

function parseSavedSubmission(value: string): SavedSubmission {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !Number.isInteger(parsed.step) ||
      typeof parsed.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.hash)
    )
      throw new Error();
    return parsed as unknown as SavedSubmission;
  } catch {
    throw new SetupRecoveryError(
      "action-required",
      "Saved setup state is malformed. Inspect or clear it before approving another transaction.",
    );
  }
}

function parseSavedBatch(value: string): SavedBatch {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.planId !== "string" ||
      typeof parsed.commitment !== "string" ||
      typeof parsed.spaceId !== "string" ||
      typeof parsed.operation !== "string" ||
      typeof parsed.owner !== "string" ||
      parsed.chainId !== supportedChainId
    )
      throw new Error();
    return parsed as unknown as SavedBatch;
  } catch {
    throw new SetupRecoveryError(
      "action-required",
      "Saved atomic setup state is malformed. Inspect it before approving another transaction.",
    );
  }
}

function setupContext(setup: Setup): Record<string, unknown> {
  return {
    ...(setup.forkGeneration ? { forkGeneration: setup.forkGeneration } : {}),
    ...(setup.planId ? { planId: setup.planId } : {}),
    ...(setup.planCommitment ? { planCommitment: setup.planCommitment } : {}),
  };
}

function assertSavedSubmission(
  submitted: SavedSubmission,
  setup: Setup,
  spaceId: string,
  owner: string,
  operation: string,
): void {
  if (
    (submitted.spaceId && submitted.spaceId !== spaceId) ||
    (submitted.operation && submitted.operation !== operation) ||
    (submitted.owner &&
      submitted.owner.toLowerCase() !== owner.toLowerCase()) ||
    (submitted.chainId !== undefined && submitted.chainId !== supportedChainId)
  )
    throw new SetupRecoveryError(
      "action-required",
      "Saved setup transaction belongs to another Space, owner, operation or chain; it was not reused.",
      submitted.hash,
    );
  if (
    submitted.forkGeneration &&
    setup.forkGeneration &&
    submitted.forkGeneration !== setup.forkGeneration
  )
    throw new SetupRecoveryError(
      "testnet-mismatch",
      "Saved setup transaction belongs to a different local testnet instance; check the original wallet and testnet before retrying.",
      submitted.hash,
    );
  if (submitted.planId && setup.planId && submitted.planId !== setup.planId)
    throw new SetupRecoveryError(
      "action-required",
      "Saved setup transaction no longer matches the reviewed setup plan.",
      submitted.hash,
    );
  if (
    submitted.planCommitment &&
    setup.planCommitment &&
    submitted.planCommitment !== setup.planCommitment
  )
    throw new SetupRecoveryError(
      "action-required",
      "Saved setup transaction no longer matches the reviewed setup calls.",
      submitted.hash,
    );
}

async function assertWalletTestnetContext(
  provider: Provider,
  owner: string,
  setup: Setup,
): Promise<void> {
  const currentChain = await provider.request({ method: "eth_chainId" });
  const accounts = (await provider.request({
    method: "eth_accounts",
  })) as string[];
  if (
    Number(currentChain) !== supportedChainId ||
    accounts[0]?.toLowerCase() !== owner.toLowerCase()
  )
    throw new SetupRecoveryError(
      "action-required",
      "Wallet account or network changed before setup verification.",
    );
  const blocks = [
    ...(setup.forkAnchor ? [setup.forkAnchor] : []),
    ...(setup.observedBlock
      ? [
          {
            blockNumber: setup.observedBlock.blockNumber,
            blockHash: setup.observedBlock.blockHash,
          },
        ]
      : []),
  ];
  for (const expected of blocks) {
    let block: unknown;
    try {
      block = await provider.request({
        method: "eth_getBlockByNumber",
        params: [`0x${BigInt(expected.blockNumber).toString(16)}`, false],
      });
    } catch (error) {
      throw new SetupRecoveryError(
        "confirmation-unavailable",
        `The wallet could not verify the configured testnet instance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !isRecord(block) ||
      typeof block.hash !== "string" ||
      block.hash.toLowerCase() !== expected.blockHash.toLowerCase()
    )
      throw new SetupRecoveryError(
        "testnet-mismatch",
        "The wallet and setup server are on different local testnet instances; no saved transaction was reused.",
      );
  }
}

function isUnavailableReceiptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|could not be found|not processed|unknown transaction|pending|temporarily unavailable|timeout/i.test(
    message,
  );
}

function isRetryableVerificationError(error: unknown): boolean {
  return (
    error instanceof SetupRequestError &&
    [
      "SPACE_TRANSACTION_PENDING",
      "SPACE_TRANSACTION_NOT_FOUND",
      "SPACE_RPC_UNAVAILABLE",
      "FORK_RPC_UNAVAILABLE",
    ].includes(error.code)
  );
}

function recoveryError(
  error: unknown,
  hash: string,
  fallback: string,
): SetupRecoveryError {
  if (error instanceof SetupRecoveryError) return error;
  return new SetupRecoveryError(
    "confirmation-unavailable",
    error instanceof Error ? error.message : fallback,
    hash,
  );
}

async function waitForTransactionReceipt(
  provider: Provider,
  hash: string,
  progress: (message: string) => void,
): Promise<
  | { status: "confirmed"; receipt: { status: string } }
  | { status: "pending" | "unavailable" }
> {
  let sawRpcError = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const receipt = (await provider.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })) as { status?: string } | null;
      if (receipt && typeof receipt.status === "string")
        return { status: "confirmed", receipt: { status: receipt.status } };
      // A null receipt is normal while a transaction is still being mined.
    } catch (error) {
      if (!isUnavailableReceiptError(error)) sawRpcError = true;
    }
    if (attempt === 0)
      progress(
        `Setup transaction ${hash} is submitted; the wallet has not returned a receipt yet.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { status: sawRpcError ? "unavailable" : "pending" };
}

async function completePrerequisites(
  setup: Setup,
  baseKey: string,
  owner: string,
  provider: Provider,
  progress: (message: string) => void,
): Promise<void> {
  for (const prerequisite of setup.prerequisites ?? []) {
    const key = `${baseKey}:approval:${prerequisite.token.toLowerCase()}`;
    const savedValue = localStorage.getItem(key);
    let saved = savedValue ? parseSavedApproval(savedValue) : undefined;
    await assertWalletTestnetContext(provider, owner, setup);
    if (saved) {
      if (
        saved.token.toLowerCase() !== prerequisite.token.toLowerCase() ||
        saved.spender.toLowerCase() !== prerequisite.spender.toLowerCase() ||
        saved.amount !== prerequisite.amount ||
        saved.owner.toLowerCase() !== owner.toLowerCase()
      )
        throw new SetupRecoveryError(
          "action-required",
          "Saved token approval no longer matches the reviewed spender or amount; it was not reused.",
          saved.hash,
        );
      if (
        saved.forkGeneration &&
        setup.forkGeneration &&
        saved.forkGeneration !== setup.forkGeneration
      )
        throw new SetupRecoveryError(
          "testnet-mismatch",
          "Saved token approval belongs to a different local testnet instance; it was not reused.",
          saved.hash,
        );
    } else {
      progress(
        `Approval required: exact ${prerequisite.symbol} amount ${prerequisite.amount} to ${prerequisite.spender}. Awaiting wallet approval.`,
      );
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{ ...prerequisite.transaction, from: owner }],
      })) as string;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new Error("Wallet returned a malformed token approval hash.");
      saved = {
        token: prerequisite.token,
        spender: prerequisite.spender,
        amount: prerequisite.amount,
        hash,
        owner,
        chainId: supportedChainId,
        ...(setup.forkGeneration
          ? { forkGeneration: setup.forkGeneration }
          : {}),
      };
      localStorage.setItem(key, JSON.stringify(saved));
    }
    progress(
      `${prerequisite.symbol} approval submitted: ${saved.hash}. Waiting for confirmation.`,
    );
    const result = await waitForTransactionReceipt(
      provider,
      saved.hash,
      progress,
    );
    if (result.status !== "confirmed")
      throw new SetupRecoveryError(
        result.status === "pending" ? "pending" : "confirmation-unavailable",
        result.status === "pending"
          ? `The ${prerequisite.symbol} approval is still pending. Check again; no new approval was sent.`
          : `The ${prerequisite.symbol} approval could not be confirmed. Check again; no new approval was sent.`,
        saved.hash,
      );
    if (result.receipt.status !== "0x1") {
      localStorage.removeItem(key);
      throw new SetupRecoveryError(
        "action-required",
        `The ${prerequisite.symbol} approval reverted; approve the exact reviewed amount before creating the Space.`,
        saved.hash,
      );
    }
    localStorage.removeItem(key);
  }
}

async function supportsAtomicCalls(
  provider: Provider,
  owner: string,
): Promise<boolean> {
  try {
    const capabilities = (await provider.request({
      method: "wallet_getCapabilities",
      params: [owner],
    })) as Record<string, { atomic?: { status?: string } }>;
    const chain =
      capabilities[`0x${supportedChainId.toString(16)}`] ?? capabilities["0x0"];
    return ["supported", "ready"].includes(chain?.atomic?.status ?? "");
  } catch {
    return false;
  }
}

async function waitForCalls(
  provider: Provider,
  id: string,
): Promise<CallsStatus> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = (await provider.request({
      method: "wallet_getCallsStatus",
      params: [id],
    })) as CallsStatus;
    if (typeof status.id !== "string" || status.id !== id)
      throw new Error("Wallet returned status for a different setup batch.");
    if (
      typeof status.chainId !== "string" ||
      BigInt(status.chainId) !== BigInt(supportedChainId)
    )
      throw new Error("Wallet returned batch status for a different chain.");
    if (status.status === 100) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    if ((status.status >= 200 && status.status < 300) || status.status >= 400)
      return status;
    throw new Error(
      `Wallet returned an unsupported setup status ${status.status}.`,
    );
  }
  throw new Error(
    "Atomic setup is still pending. Retry to continue verifying the same wallet batch.",
  );
}

async function request(action: string, body: unknown): Promise<Setup> {
  let response: Response;
  let result: unknown;
  try {
    response = await fetch(`${apiBaseUrl}/testnet/spaces/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    result = await response.json();
  } catch (error) {
    throw new SetupRequestError(
      "FORK_RPC_UNAVAILABLE",
      error instanceof Error ? error.message : "Space setup request failed",
      { retryable: true },
    );
  }
  if (!response.ok) {
    const error = isRecord(result) ? result.error : undefined;
    if (isRecord(error) && typeof error.message === "string")
      throw new SetupRequestError(
        typeof error.code === "string" ? error.code : "FORK_REQUEST_FAILED",
        error.message,
        isRecord(error.details) ? error.details : {},
      );
    throw new SetupRequestError(
      "FORK_REQUEST_FAILED",
      typeof error === "string" ? error : "Space setup failed",
    );
  }
  return parseSetup(result);
}

/** Persist the submitted hash before waiting, so reload resumes verification rather than rebroadcasting. */
export async function activateTestnetSpace(
  spaceId: string,
  owner: string,
  provider: Provider,
  progress: (message: string) => void,
  operation = "ACTIVATE",
  setupAction: "start" | "check" | "retry" = "start",
): Promise<SpaceRecord> {
  const chain = await provider.request({ method: "eth_chainId" });
  if (Number(chain) !== supportedChainId)
    throw new Error("Switch your wallet to the configured testnet chain.");
  const key = `aurka:space-setup:${supportedChainId}:${owner.toLowerCase()}:${spaceId}:${operation}`;
  let setup = await request("prepare", { spaceId, operation });
  while (!setup.complete) {
    if (setup.gasEstimate)
      progress(`Required gas estimate: ${setup.gasEstimate} gas units.`);
    if (setup.ownerAddress.toLowerCase() !== owner.toLowerCase())
      throw new Error("Connect the recorded Space owner.");
    await assertWalletTestnetContext(provider, owner, setup);
    const requestedAction = setupAction;
    setupAction = "start";
    const pendingValue = localStorage.getItem(key);
    let submitted = pendingValue
      ? parseSavedSubmission(pendingValue)
      : undefined;
    const savedBatchValue = localStorage.getItem(`${key}:batch`);
    let batch = savedBatchValue ? parseSavedBatch(savedBatchValue) : undefined;
    if (
      batch &&
      (batch.spaceId !== spaceId ||
        batch.operation !== operation ||
        batch.owner.toLowerCase() !== owner.toLowerCase() ||
        batch.chainId !== supportedChainId)
    )
      throw new Error(
        "Saved wallet batch does not match this Space operation.",
      );
    if (
      batch?.forkGeneration &&
      setup.forkGeneration &&
      batch.forkGeneration !== setup.forkGeneration
    )
      throw new SetupRecoveryError(
        "testnet-mismatch",
        "Saved wallet batch belongs to a different local testnet instance; check the original wallet and testnet before retrying.",
        batch.id,
      );
    if (
      batch &&
      ((setup.batchPlanId && setup.batchPlanId !== batch.planId) ||
        (setup.batchCommitment && setup.batchCommitment !== batch.commitment))
    )
      throw new Error(
        "Saved wallet batch no longer matches the reviewed plan.",
      );
    if (submitted)
      assertSavedSubmission(submitted, setup, spaceId, owner, operation);
    if (submitted && submitted.step < setup.step) {
      localStorage.removeItem(key);
      submitted = undefined;
    }
    if (submitted && submitted.step > setup.step)
      throw new SetupRecoveryError(
        "action-required",
        "Saved setup transaction is ahead of the server plan; reconcile the server before sending anything else.",
        submitted.hash,
      );
    if (setup.mode === "single-transaction" && setup.batch?.length)
      throw new Error(
        "The single-transaction Space setup must use one ordinary wallet transaction; a batch was not accepted.",
      );

    // Token approvals are explicit prerequisites of the aggregate call. They
    // are tracked independently so a reload never causes a duplicate prompt.
    if (
      !submitted &&
      setup.mode === "single-transaction" &&
      setup.prerequisites?.length
    ) {
      await completePrerequisites(setup, key, owner, provider, progress);
      setup = await request("prepare", {
        spaceId,
        operation,
        ...setupContext(setup),
      });
      continue;
    }

    if (
      setup.mode !== "single-transaction" &&
      (batch || setup.batch?.length) &&
      !submitted
    ) {
      if (!batch) {
        const offeredBatch = setup.batch;
        if (!offeredBatch?.length)
          throw new Error("Server did not return the saved batch plan.");
        progress(
          `Fund/configure: review ${offeredBatch.length} atomic calls; the exact reviewed funding amounts are shown in the Space review.`,
        );
        const currentChain = await provider.request({ method: "eth_chainId" });
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as string[];
        if (
          Number(currentChain) !== supportedChainId ||
          accounts[0]?.toLowerCase() !== owner.toLowerCase()
        )
          throw new Error(
            "Wallet account or network changed before atomic setup.",
          );
        if (await supportsAtomicCalls(provider, owner)) {
          const result = await provider.request({
            method: "wallet_sendCalls",
            params: [
              {
                version: "2.0.0",
                chainId: `0x${supportedChainId.toString(16)}`,
                from: owner,
                atomicRequired: true,
                calls: offeredBatch,
              },
            ],
          });
          const id = parseSendCallsResult(result);
          batch = {
            id,
            planId: setup.batchPlanId ?? "",
            commitment: setup.batchCommitment ?? "",
            spaceId,
            operation,
            owner,
            chainId: supportedChainId,
            ...(setup.forkGeneration
              ? { forkGeneration: setup.forkGeneration }
              : {}),
          };
          if (!batch.planId || !batch.commitment)
            throw new Error("Server did not return the immutable batch plan.");
          localStorage.setItem(`${key}:batch`, JSON.stringify(batch));
        } else {
          progress(
            `This wallet does not support atomic calls. Continuing with the clearly labelled ${setup.total}-transaction fallback.`,
          );
        }
      }
      if (batch) {
        const currentChain = await provider.request({ method: "eth_chainId" });
        const accounts = (await provider.request({
          method: "eth_accounts",
        })) as string[];
        if (
          Number(currentChain) !== supportedChainId ||
          accounts[0]?.toLowerCase() !== owner.toLowerCase()
        )
          throw new Error(
            "Wallet account or network changed before batch verification.",
          );
        progress(`Fund/configure submitted as wallet batch ${batch.id}.`);
        const status = await waitForCalls(provider, batch.id);
        if (
          status.status !== 200 ||
          status.atomic !== true ||
          !status.receipts?.length ||
          status.receipts.some((receipt) => receipt.status !== "0x1")
        ) {
          if (status.status === 400) {
            localStorage.removeItem(`${key}:batch`);
            throw new Error(
              "Wallet did not submit the atomic setup batch; retry is safe.",
            );
          }
          if (status.status === 500 || status.status === 600) {
            // The wallet result is only a hint. Keep the saved identity until
            // the server verifies canonical receipts and authorizes retry or
            // continuation from the immutable plan.
            setup = await request("reconcile", {
              spaceId,
              operation,
              batch: true,
              status: status.status,
              atomic: status.atomic,
              batchId: batch.id,
              batchPlanId: batch.planId,
              batchCommitment: batch.commitment,
              ...setupContext(setup),
              hashes:
                status.receipts?.map((receipt) => receipt.transactionHash) ??
                [],
            });
            localStorage.removeItem(`${key}:batch`);
            progress(
              status.status === 500
                ? "Server verified a complete revert; retrying with a fresh wallet batch."
                : "Server verified the successful batch prefix; continuing from the next setup step.",
            );
            continue;
          }
          throw new Error(
            "Atomic setup requires a successful atomic result; saved batch state was preserved for reconciliation.",
          );
        }
        setup = await request("confirm", {
          spaceId,
          operation,
          batch: true,
          atomic: true,
          batchId: batch.id,
          batchPlanId: batch.planId,
          batchCommitment: batch.commitment,
          ...setupContext(setup),
          hashes: status.receipts.map((receipt) => receipt.transactionHash),
        });
        localStorage.removeItem(`${key}:batch`);
        progress("Fund/configure verified. Activate trading capacity next.");
        continue;
      }
    }
    if (submitted && requestedAction === "retry") {
      const submittedHash = submitted.hash;
      try {
        setup = await request("recover", {
          spaceId,
          operation,
          step: submitted.step,
          hash: submittedHash,
          ...setupContext(setup),
        });
        localStorage.removeItem(key);
        submitted = undefined;
        continue;
      } catch (error) {
        if (isRetryableVerificationError(error))
          throw new SetupRecoveryError(
            "confirmation-unavailable",
            "The server cannot yet prove that the missing setup transaction had no effect. Check the original testnet before retrying.",
            submittedHash,
          );
        throw recoveryError(
          error,
          submittedHash,
          "Setup recovery could not be verified.",
        );
      }
    }
    if (submitted && requestedAction !== "retry") {
      const submittedHash = submitted.hash;
      try {
        setup = await request("reconcile", {
          spaceId,
          operation,
          step: submitted.step,
          hash: submittedHash,
          ...setupContext(setup),
        });
        localStorage.removeItem(key);
        continue;
      } catch (error) {
        if (!isRetryableVerificationError(error))
          throw recoveryError(
            error,
            submittedHash,
            "Setup confirmation could not be verified.",
          );
      }
    }
    if (!submitted) {
      const currentChain = await provider.request({ method: "eth_chainId" });
      const accounts = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      if (
        Number(currentChain) !== supportedChainId ||
        accounts[0]?.toLowerCase() !== owner.toLowerCase()
      )
        throw new Error(
          "Wallet account or network changed. Reconnect the Space owner before continuing.",
        );
      const phase =
        operation === "ACTIVATE"
          ? setup.step === 0
            ? "Create Space"
            : setup.step < setup.total - 1
              ? "Fund/configure"
              : "Activate"
          : operation === "UPDATE"
            ? "Save changes"
            : operation === "PAUSE"
              ? "Pause"
              : "Resume";
      progress(`${phase}: ${setup.label}. Awaiting wallet approval.`);
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{ ...setup.transaction, from: owner }],
      })) as string;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new Error("Wallet returned a malformed setup transaction hash.");
      submitted = {
        step: setup.step,
        hash,
        spaceId,
        operation,
        owner,
        chainId: supportedChainId,
        ...(setup.forkGeneration
          ? { forkGeneration: setup.forkGeneration }
          : {}),
        ...(setup.planId ? { planId: setup.planId } : {}),
        ...(setup.planCommitment
          ? { planCommitment: setup.planCommitment }
          : {}),
      };
      localStorage.setItem(key, JSON.stringify(submitted));
    }
    const submittedHash = submitted.hash;
    progress(
      `${setup.label} submitted: ${submittedHash}. Waiting for confirmation.`,
    );
    const result = await waitForTransactionReceipt(
      provider,
      submittedHash,
      progress,
    );
    if (result.status !== "confirmed") {
      try {
        setup = await request("reconcile", {
          spaceId,
          operation,
          step: submitted.step,
          hash: submittedHash,
          ...setupContext(setup),
        });
        localStorage.removeItem(key);
        continue;
      } catch (error) {
        if (!isRetryableVerificationError(error))
          throw recoveryError(
            error,
            submittedHash,
            "Setup confirmation could not be verified.",
          );
        throw new SetupRecoveryError(
          result.status === "pending" ? "pending" : "confirmation-unavailable",
          result.status === "pending"
            ? "The setup transaction is still pending. Check again to continue verifying the same hash; no new transaction was sent."
            : "The wallet or testnet RPC could not confirm this setup transaction. Check again; no new transaction was sent.",
          submittedHash,
        );
      }
    }
    if (result.receipt.status !== "0x1") {
      localStorage.removeItem(key);
    }
    setup = await request("confirm", {
      spaceId,
      operation,
      ...submitted,
      ...setupContext(setup),
    });
    localStorage.removeItem(key);
  }
  localStorage.removeItem(key);
  localStorage.removeItem(`${key}:batch`);
  if (!setup.space) throw new Error("Server did not return a verified Space.");
  progress(
    "Ready: setup, funding and required trading authorization verified.",
  );
  return setup.space;
}
