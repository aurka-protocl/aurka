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
};

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
      progress(
        `${setup.step + 1}/${setup.total}: ${setup.label}. Awaiting wallet approval.`,
      );
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
  if (!setup.space) throw new Error("Server did not return a verified Space.");
  return setup.space;
}
