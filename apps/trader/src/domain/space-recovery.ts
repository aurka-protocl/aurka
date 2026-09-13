import { apiBaseUrl, supportedChainId } from "../config";

export type RecoveryProvider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};

export type RecoveryTransaction = {
  readonly to: string;
  readonly data: string;
  readonly value: string;
};

export type RecoveryState = {
  readonly spaceId: string;
  readonly owner: string;
  readonly vault: string;
  readonly hasVault: boolean;
  readonly paused: boolean;
  readonly aqua: string;
  readonly aquaApp: string | null;
  readonly strategyHash: string;
  readonly aquaBalances: Record<
    string,
    { readonly token: string; readonly balance: string; readonly tokensCount: number }
  >;
  readonly vaultBalances: Record<string, string>;
  readonly ownerBalances: Record<string, string>;
};

function endpoint(path: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}${path}`;
}

async function ownerRequest<T>(
  action: string,
  spaceId: string,
  params: Record<string, string> = {},
): Promise<T> {
  const query = new URLSearchParams({ action, spaceId, ...params });
  const response = await fetch(`${endpoint("/testnet/owner")}?${query}`);
  const body = (await response.json()) as {
    readonly error?: { readonly message?: string };
  } & T;
  if (!response.ok)
    throw new Error(body.error?.message ?? "The Space owner action failed.");
  return body;
}

export function getRecoveryState(spaceId: string): Promise<RecoveryState> {
  return ownerRequest<RecoveryState>("state", spaceId);
}

function transactionFrom(value: unknown): RecoveryTransaction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.to !== "string" ||
    typeof candidate.data !== "string" ||
    typeof candidate.value !== "string"
  )
    return undefined;
  return {
    to: candidate.to,
    data: candidate.data,
    value: candidate.value,
  };
}

async function waitForReceipt(
  provider: RecoveryProvider,
  hash: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (result && typeof result === "object") {
      const receipt = result as Record<string, unknown>;
      if (receipt.status === "0x0")
        throw new Error("The recovery transaction reverted.");
      if (receipt.blockNumber) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "The recovery transaction is still pending. Check the wallet before retrying.",
  );
}

async function sendRecoveryTransaction(
  provider: RecoveryProvider,
  owner: string,
  transaction: RecoveryTransaction,
  progress: (message: string) => void,
): Promise<void> {
  const chain = await provider.request({ method: "eth_chainId" });
  const accounts = await provider.request({ method: "eth_accounts" });
  const connected = Array.isArray(accounts) ? accounts[0] : undefined;
  if (
    typeof chain !== "string" ||
    BigInt(chain) !== BigInt(supportedChainId) ||
    typeof connected !== "string" ||
    connected.toLowerCase() !== owner.toLowerCase()
  )
    throw new Error(
      "Connect the Space owner wallet on Ethereum Sepolia before recovering assets.",
    );
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: owner,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value,
      },
    ],
  });
  if (typeof hash !== "string")
    throw new Error("The wallet returned no recovery transaction hash.");
  progress("Transaction submitted. Waiting for network confirmation…");
  await waitForReceipt(provider, hash);
}

export async function recoverTestnetSpace(
  spaceId: string,
  owner: string,
  provider: RecoveryProvider,
  progress: (message: string) => void,
): Promise<RecoveryState> {
  let state = await getRecoveryState(spaceId);
  if (!state.hasVault) return state;

  if (!state.paused) {
    const pause = await ownerRequest<unknown>("pause", spaceId);
    const transaction = transactionFrom(pause);
    if (transaction) {
      progress("Approve pausing this Space before recovering its assets.");
      await sendRecoveryTransaction(provider, owner, transaction, progress);
      state = await getRecoveryState(spaceId);
    }
  }

  if (
    Object.values(state.aquaBalances).some(
      (asset) => BigInt(asset.balance) > 0n,
    )
  ) {
    const dock = await ownerRequest<unknown>("dock", spaceId);
    const transaction = transactionFrom(dock);
    if (transaction) {
      progress("Approve closing the Space strategy before withdrawal.");
      await sendRecoveryTransaction(provider, owner, transaction, progress);
      state = await getRecoveryState(spaceId);
    }
  }

  for (const symbol of ["USDC", "WETH"]) {
    const amount = BigInt(state.vaultBalances[symbol] ?? "0");
    if (amount === 0n) continue;
    const withdraw = await ownerRequest<unknown>("withdraw", spaceId, {
      token: symbol,
      amount: amount.toString(),
    });
    const transaction = transactionFrom(withdraw);
    if (!transaction) throw new Error(`No ${symbol} withdrawal was prepared.`);
    progress(`Approve withdrawing ${symbol} to the Space owner wallet.`);
    await sendRecoveryTransaction(provider, owner, transaction, progress);
    state = await getRecoveryState(spaceId);
  }
  return state;
}

export async function deleteTestnetSpace(
  spaceId: string,
  owner: string,
): Promise<void> {
  const response = await fetch(endpoint("/testnet/spaces/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, ownerAddress: owner }),
  });
  const body = (await response.json()) as {
    readonly error?: { readonly message?: string };
  };
  if (!response.ok)
    throw new Error(body.error?.message ?? "The Space could not be deleted.");
}
