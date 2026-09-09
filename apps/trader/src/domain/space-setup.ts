import type { SpaceRecord } from "@aurka/shared";
import { apiBaseUrl, supportedChainId } from "../config";

type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
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
  batch?: readonly { to: string; data: string; value: string }[];
};

type CallsStatus = {
  id?: string;
  chainId?: string;
  status: number;
  receipts?: readonly { transactionHash: string; status?: string }[];
};
type SavedBatch = {
  id: string;
  spaceId: string;
  operation: string;
  owner: string;
  chainId: number;
};

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

async function supportsAtomicCalls(
  provider: Provider,
  owner: string,
): Promise<boolean> {
  try {
    const capabilities = (await provider.request({
      method: "wallet_getCapabilities",
      params: [owner],
    })) as Record<string, { atomic?: { status?: string } }>;
    const chain = capabilities[`0x${supportedChainId.toString(16)}`];
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
    if (status.id && status.id !== id)
      throw new Error("Wallet returned status for a different setup batch.");
    if (status.chainId && BigInt(status.chainId) !== BigInt(supportedChainId))
      throw new Error("Wallet returned batch status for a different chain.");
    if (status.status === 200 || status.status >= 400) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "Atomic setup is still pending. Retry to continue verifying the same wallet batch.",
  );
}

async function request(action: string, body: unknown): Promise<Setup> {
  const response = await fetch(`${apiBaseUrl}/fork/spaces/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string" ? result.error : "Space setup failed",
    );
  return result;
}

/** Persist the submitted hash before waiting, so reload resumes verification rather than rebroadcasting. */
export async function activateForkSpace(
  spaceId: string,
  owner: string,
  provider: Provider,
  progress: (message: string) => void,
  operation = "ACTIVATE",
): Promise<SpaceRecord> {
  const chain = await provider.request({ method: "eth_chainId" });
  if (Number(chain) !== supportedChainId)
    throw new Error("Switch your wallet to the configured fork chain.");
  const key = `aurka:space-setup:${supportedChainId}:${owner.toLowerCase()}:${spaceId}:${operation}`;
  let setup = await request("prepare", { spaceId, operation });
  while (!setup.complete) {
    if (setup.ownerAddress.toLowerCase() !== owner.toLowerCase())
      throw new Error("Connect the recorded Space owner.");
    const pending = localStorage.getItem(key);
    const savedBatchValue = localStorage.getItem(`${key}:batch`);
    let batch = savedBatchValue
      ? (JSON.parse(savedBatchValue) as SavedBatch)
      : undefined;
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
    if ((batch || setup.batch?.length) && !pending) {
      if (!batch) {
        const offeredBatch = setup.batch;
        if (!offeredBatch?.length)
          throw new Error("Server did not return the saved batch plan.");
        progress(
          `Fund/configure: review ${offeredBatch.length} atomic calls (35,000 USDC + 5 WETH; maximum trade value is shown in the Space review).`,
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
            spaceId,
            operation,
            owner,
            chainId: supportedChainId,
          };
          localStorage.setItem(`${key}:batch`, JSON.stringify(batch));
        } else {
          progress(
            `This wallet does not support atomic calls. Continuing with the clearly labelled ${setup.total}-transaction fallback.`,
          );
        }
      }
      if (batch) {
        progress(`Fund/configure submitted as wallet batch ${batch.id}.`);
        const status = await waitForCalls(provider, batch.id);
        if (status.status !== 200 || !status.receipts?.length) {
          if (status.status >= 400) localStorage.removeItem(`${key}:batch`);
          throw new Error(
            "Atomic setup failed or returned no verifiable receipt; Ready was not claimed.",
          );
        }
        setup = await request("confirm", {
          spaceId,
          operation,
          batch: true,
          hashes: status.receipts.map((receipt) => receipt.transactionHash),
        });
        localStorage.removeItem(`${key}:batch`);
        progress("Fund/configure verified. Activate trading capacity next.");
        continue;
      }
    }
    let submitted: { step: number; hash: string } | undefined = pending
      ? JSON.parse(pending)
      : undefined;
    if (submitted && submitted.step < setup.step) {
      localStorage.removeItem(key);
      submitted = undefined;
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
      submitted = { step: setup.step, hash };
      localStorage.setItem(key, JSON.stringify(submitted));
    }
    progress(
      `${setup.label} submitted: ${submitted.hash}. Waiting for confirmation.`,
    );
    let receipt: { status: string } | null = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      receipt = (await provider.request({
        method: "eth_getTransactionReceipt",
        params: [submitted.hash],
      })) as { status: string } | null;
      if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!receipt)
      throw new Error(
        "Transaction is still pending. Retry to continue verifying the same hash.",
      );
    if (receipt.status !== "0x1") {
      localStorage.removeItem(key);
    }
    setup = await request("confirm", { spaceId, operation, ...submitted });
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
