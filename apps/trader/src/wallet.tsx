import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supportedChainId } from "./config";

export interface BrowserWalletProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  /** Common provider markers used when several injected wallets coexist. */
  readonly isMetaMask?: boolean;
  readonly isRabby?: boolean;
  readonly isCoinbaseWallet?: boolean;
  readonly isBraveWallet?: boolean;
  readonly isPolkadot?: boolean;
  readonly isSubWallet?: boolean;
  readonly providers?: readonly BrowserWalletProvider[];
}

export type WalletStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "wrong-network"
  | "unsupported-network"
  | "error";

export interface WalletState {
  readonly status: WalletStatus;
  readonly address: string | null;
  readonly chainId: number | null;
  readonly provider: BrowserWalletProvider | null;
  readonly error: string | null;
  /** Changes whenever account/network context changes and dependent work must be discarded. */
  readonly revision: number;
  readonly connect: () => Promise<void>;
  readonly clearError: () => void;
}

interface WindowWithEthereum extends Window {
  ethereum?: BrowserWalletProvider;
}

const WalletContext = createContext<WalletState | null>(null);

function providerFromWindow(): BrowserWalletProvider | null {
  const injected = (window as WindowWithEthereum).ethereum;
  if (!injected) return null;
  const candidates = injected.providers?.length
    ? [...injected.providers]
    : [injected];
  // Multiple wallet extensions can share window.ethereum. Prefer the wallets
  // supported by this EVM flow, then a non-Substrate provider, and only fall
  // back to the first injected provider if no marker is available.
  return (
    candidates.find((candidate) => candidate.isMetaMask || candidate.isRabby) ??
    candidates.find(
      (candidate) => candidate.isCoinbaseWallet || candidate.isBraveWallet,
    ) ??
    candidates.find(
      (candidate) => !candidate.isPolkadot && !candidate.isSubWallet,
    ) ??
    candidates[0] ??
    null
  );
}

function parseChainId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const parsed = Number(BigInt(value));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function statusForChain(chainId: number | null): WalletStatus {
  if (chainId === null) return "unsupported-network";
  if (chainId === supportedChainId) return "connected";
  if (chainId === 1 || chainId === 5 || chainId === 11155111)
    return "wrong-network";
  return "unsupported-network";
}

function friendlyWalletError(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  if (/4001|rejected|denied|cancel/i.test(message))
    return "The wallet rejected the request. Try again when you are ready.";
  if (/network|provider|disconnected/i.test(message))
    return "The wallet connection is unavailable. Unlock it and try again.";
  if (message) return "The wallet could not complete that request. Try again.";
  return "The wallet request failed. Try again or inspect the wallet details.";
}

export function WalletProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const [provider, setProvider] = useState<BrowserWalletProvider | null>(null);
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const applyContext = useCallback(
    (nextAddress: string | null, nextChainId: number | null) => {
      setAddress(nextAddress);
      setChainId(nextChainId);
      setStatus(
        nextAddress === null ? "disconnected" : statusForChain(nextChainId),
      );
      setError(null);
    },
    [],
  );

  useEffect(() => {
    const nextProvider = providerFromWindow();
    setProvider(nextProvider);
    if (!nextProvider) {
      setStatus("disconnected");
      return;
    }
    let active = true;
    const sync = async () => {
      try {
        const [rawAccounts, rawChainId] = await Promise.all([
          nextProvider.request({ method: "eth_accounts" }),
          nextProvider.request({ method: "eth_chainId" }),
        ]);
        if (!active) return;
        const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
        applyContext(
          typeof accounts[0] === "string" ? accounts[0] : null,
          parseChainId(rawChainId),
        );
      } catch {
        if (active) {
          setStatus("disconnected");
          setAddress(null);
          setChainId(null);
        }
      }
    };
    const changed = () => {
      setRevision((current) => current + 1);
      void sync();
    };
    void sync();
    nextProvider.on?.("accountsChanged", changed);
    nextProvider.on?.("chainChanged", changed);
    return () => {
      active = false;
      nextProvider.removeListener?.("accountsChanged", changed);
      nextProvider.removeListener?.("chainChanged", changed);
    };
  }, [applyContext]);

  const connect = useCallback(async () => {
    const nextProvider = provider ?? providerFromWindow();
    if (!nextProvider) {
      setStatus("error");
      setError("No compatible Ethereum wallet was detected in this browser.");
      return;
    }
    setStatus("connecting");
    setError(null);
    try {
      const rawAccounts = await nextProvider.request({
        method: "eth_requestAccounts",
      });
      const rawChainId = await nextProvider.request({ method: "eth_chainId" });
      const accounts = Array.isArray(rawAccounts) ? rawAccounts : [];
      const nextAddress = typeof accounts[0] === "string" ? accounts[0] : null;
      const nextChainId = parseChainId(rawChainId);
      if (!nextAddress)
        throw new Error("The wallet did not return an account.");
      setProvider(nextProvider);
      setRevision((current) => current + 1);
      applyContext(nextAddress, nextChainId);
    } catch (requestError) {
      setStatus("error");
      setError(friendlyWalletError(requestError));
    }
  }, [applyContext, provider]);

  const value = useMemo<WalletState>(
    () => ({
      status,
      address,
      chainId,
      provider,
      error,
      revision,
      connect,
      clearError: () => setError(null),
    }),
    [address, chainId, connect, error, provider, revision, status],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider");
  return value;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletStatusControl() {
  const wallet = useWallet();
  const label =
    wallet.status === "connecting"
      ? "Connecting…"
      : wallet.status === "connected"
        ? shortAddress(wallet.address ?? "")
        : wallet.status === "wrong-network"
          ? "Wrong network"
          : wallet.status === "unsupported-network"
            ? "Connect wallet"
            : wallet.status === "error"
              ? "Try wallet again"
              : "Connect wallet";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={`hidden text-xs sm:inline ${wallet.status === "connected" ? "text-emerald-300" : "text-slate-400"}`}
        aria-live="polite"
      >
        {wallet.status === "connected"
          ? `Connected · ${shortAddress(wallet.address ?? "")}`
          : wallet.status === "wrong-network"
            ? "Switch to AURKA test network"
            : wallet.status === "unsupported-network"
              ? "Unsupported network"
              : wallet.status === "connecting"
                ? "Connecting…"
                : "No wallet connected"}
      </span>
      <button
        type="button"
        onClick={() => void wallet.connect()}
        disabled={wallet.status === "connecting"}
        className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-cyan-500 hover:text-white disabled:cursor-wait"
        aria-label={label}
      >
        {label}
      </button>
    </div>
  );
}

export function WalletStateMessage() {
  const wallet = useWallet();
  if (wallet.status === "connected") return null;
  const text =
    wallet.status === "wrong-network"
      ? `Your wallet is on chain ${wallet.chainId ?? "unknown"}. Select the AURKA test network (chain ${supportedChainId}); AURKA never switches it automatically.`
      : wallet.status === "unsupported-network"
        ? "Install or unlock an Ethereum wallet, then connect it to the supported AURKA network."
        : wallet.status === "error"
          ? (wallet.error ?? "The wallet could not connect.")
          : "Connect a wallet when you are ready to sign. Viewing this page does not request a signature.";
  return (
    <p className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm leading-6 text-slate-400">
      {text}
    </p>
  );
}
