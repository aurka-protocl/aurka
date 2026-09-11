import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatTokenAmount,
  parseTokenAmount,
  type AssetBound,
  type SpaceDraft,
  type SpaceMutationOperation,
  type SpaceRecord,
} from "@aurka/shared";
import { apiBaseUrl, appMode, supportedChainId } from "../config";
import {
  activateTestnetSpace,
  SetupRecoveryError,
} from "../domain/space-setup";
import { invalidateSpaceCache, spaceUrl } from "../domain/spaces";
import { setupProgressLabel, userFacingError } from "../ui";
import { useWallet } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
const ZERO = "0x0000000000000000000000000000000000000000";
const ERC20_BALANCE_OF = "0x70a08231";
const ERC20_MINT = "0x40c10f19";
const SEPOLIA_ASSETS: readonly AssetBound[] = [
  {
    token: "0x8228fd953cdf5fac815d09ec5ea27ddd9412a714",
    symbol: "USDC",
    decimals: 6,
    minimumWeightBps: 5500,
    maximumWeightBps: 10000,
  },
  {
    token: "0x33dca285758fd19d1f51c7b73d5a5fb8dae4d2c4",
    symbol: "WETH",
    decimals: 18,
    minimumWeightBps: 0,
    maximumWeightBps: 4500,
  },
];
const supportedAssets: readonly AssetBound[] =
  appMode === "testnet"
    ? supportedChainId === 11155111
      ? SEPOLIA_ASSETS
      : [
          {
            token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            symbol: "USDC",
            decimals: 6,
            minimumWeightBps: 5500,
            maximumWeightBps: 10000,
          },
          {
            token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            symbol: "WETH",
            decimals: 18,
            minimumWeightBps: 0,
            maximumWeightBps: 3500,
          },
        ]
    : [
        {
          token: "0x1111111111111111111111111111111111111111",
          symbol: "USDC",
          decimals: 0,
          minimumWeightBps: 5_500,
          maximumWeightBps: 10_000,
        },
        {
          token: "0x2222222222222222222222222222222222222222",
          symbol: "WETH",
          decimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 3_500,
        },
        {
          token: "0x3333333333333333333333333333333333333333",
          symbol: "LINK",
          decimals: 0,
          minimumWeightBps: 0,
          maximumWeightBps: 1_500,
        },
      ];

function mintCalldata(account: string, amount: bigint): string {
  return `${ERC20_MINT}${account.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}

async function waitForReceipt(
  provider: NonNullable<ReturnType<typeof useWallet>["provider"]>,
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
        throw new Error("The token claim reverted.");
      if (receipt.blockNumber) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    "The token claim is still pending. Check the wallet before retrying.",
  );
}

type DraftAsset = AssetBound & {
  readonly minimumText: string;
  readonly maximumText: string;
};

type SetupUiState =
  | "idle"
  | "awaiting-signature"
  | "submitted"
  | "confirmation-unavailable"
  | "testnet-mismatch"
  | "action-required"
  | "confirmed";

function newSpaceId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `space:${uuid}`;
}

function initialDraft(
  walletAddress: string,
  existing?: SpaceRecord,
): SpaceDraft {
  if (existing?.draft) return existing.draft;
  if (existing?.position) {
    return {
      draftVersion: 2,
      id: existing.identity.id,
      name: existing.identity.name,
      ownerAddress: existing.identity.ownerAddress,
      chainId: existing.identity.chainId,
      assets: existing.position.policy.assets,
      maximumTransactionValue: existing.position.policy.maximumTransactionValue,
      funding: existing.draft?.funding ?? { usdc: "35000", weth: "5" },
    };
  }
  return {
    draftVersion: 2,
    id: newSpaceId(),
    name: "New Aurka Space",
    ownerAddress: walletAddress,
    chainId: supportedChainId,
    assets: supportedAssets.slice(0, 2),
    maximumTransactionValue: "5000",
    funding: { usdc: "35000", weth: "5" },
  };
}

function fieldClass(): string {
  return "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-cyan-500";
}

function errorMessage(error: unknown): string {
  return userFacingError(
    error,
    "Space change failed. Review the details and try again.",
  );
}

export default function SpaceForm({
  existing,
  embedded = false,
}: {
  readonly existing?: SpaceRecord;
  readonly embedded?: boolean;
}) {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<SpaceDraft>(() =>
    initialDraft(wallet.address ?? ZERO, existing),
  );
  const [saved, setSaved] = useState<SpaceRecord | undefined>(existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<SetupUiState>("idle");
  const [setupDetails, setSetupDetails] = useState<string | null>(null);
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [balanceRevision, setBalanceRevision] = useState(0);
  const [walletBalances, setWalletBalances] = useState<{
    readonly native: bigint;
    readonly usdc: bigint;
    readonly weth: bigint;
  }>();

  useEffect(() => {
    if (appMode !== "testnet" || !wallet.provider || !wallet.address) {
      setWalletBalances(undefined);
      return;
    }
    let active = true;
    const read = async () => {
      try {
        const [native, usdc, weth] = await Promise.all([
          wallet.provider!.request({
            method: "eth_getBalance",
            params: [wallet.address, "latest"],
          }),
          ...supportedAssets.slice(0, 2).map((asset) =>
            wallet.provider!.request({
              method: "eth_call",
              params: [
                {
                  to: asset.token,
                  data: `${ERC20_BALANCE_OF}${wallet.address!.slice(2).padStart(64, "0")}`,
                },
                "latest",
              ],
            }),
          ),
        ]);
        if (
          active &&
          typeof native === "string" &&
          typeof usdc === "string" &&
          typeof weth === "string"
        )
          setWalletBalances({
            native: BigInt(native),
            usdc: BigInt(usdc),
            weth: BigInt(weth),
          });
      } catch {
        if (active) setWalletBalances(undefined);
      }
    };
    void read();
    return () => {
      active = false;
    };
  }, [wallet.address, wallet.provider, wallet.revision, balanceRevision]);

  async function claimDemoTokens() {
    setFaucetBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (
        appMode !== "testnet" ||
        supportedChainId !== 11155111 ||
        !wallet.address ||
        !wallet.provider ||
        wallet.status !== "connected"
      )
        throw new Error(
          "Connect a wallet on Sepolia before claiming demo tokens.",
        );

      const chainId = await wallet.provider.request({ method: "eth_chainId" });
      if (typeof chainId !== "string" || BigInt(chainId) !== 11_155_111n)
        throw new Error(
          "Switch the wallet to Ethereum Sepolia before claiming demo tokens.",
        );

      const claims = [
        { asset: SEPOLIA_ASSETS[0], amount: parseTokenAmount("35000", 6) },
        { asset: SEPOLIA_ASSETS[1], amount: parseTokenAmount("5", 18) },
      ];
      for (const claim of claims) {
        setMessage(
          `Approve the ${claim.asset.symbol} demo-token claim in your wallet.`,
        );
        const hash = await wallet.provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: wallet.address,
              to: claim.asset.token,
              data: mintCalldata(wallet.address, claim.amount),
              value: "0x0",
            },
          ],
        });
        if (typeof hash !== "string")
          throw new Error("The wallet did not return a claim transaction.");
        setMessage(
          `Waiting for the ${claim.asset.symbol} demo-token claim to confirm…`,
        );
        await waitForReceipt(wallet.provider, hash);
      }
      setBalanceRevision((current) => current + 1);
      setMessage(
        "Demo tokens claimed: 35,000 USDC + 5 WETH. You can continue creating the Space.",
      );
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setFaucetBusy(false);
    }
  }

  useEffect(() => {
    if (appMode !== "testnet" || !wallet.address || !saved) return;
    const operation =
      saved.identity.state === "ACTIVE" ||
      saved.identity.state === "REACTIVATION_REQUIRED" ||
      saved.identity.state === "PAUSED"
        ? "UPDATE"
        : "ACTIVATE";
    const key = `aurka:space-setup:${supportedChainId}:${wallet.address.toLowerCase()}:${saved.identity.id}:${operation}`;
    const approvalPending = supportedAssets.some((asset) =>
      localStorage.getItem(`${key}:approval:${asset.token.toLowerCase()}`),
    );
    if (
      localStorage.getItem(key) ||
      localStorage.getItem(`${key}:batch`) ||
      approvalPending
    )
      setSetupState("submitted");
  }, [saved, wallet.address]);

  const assets = useMemo<DraftAsset[]>(
    () =>
      supportedAssets.map((supported) => {
        const current = draft.assets.find(
          (asset) =>
            asset.token.toLowerCase() === supported.token.toLowerCase(),
        );
        return {
          ...supported,
          ...(current ?? {}),
          minimumText: String(
            current?.minimumWeightBps ?? supported.minimumWeightBps,
          ),
          maximumText: String(
            current?.maximumWeightBps ?? supported.maximumWeightBps,
          ),
        };
      }),
    [draft.assets],
  );

  function updateDraft(next: Partial<SpaceDraft>) {
    setError(null);
    setMessage(null);
    setDraft((current) => ({ ...current, ...next }));
  }

  function updateAsset(
    token: string,
    field: "minimumWeightBps" | "maximumWeightBps",
    value: string,
  ) {
    const nextAssets = draft.assets.map((asset) =>
      asset.token.toLowerCase() === token.toLowerCase()
        ? { ...asset, [field]: Number(value) }
        : asset,
    );
    updateDraft({ assets: nextAssets });
  }

  function toggleAsset(asset: AssetBound) {
    const present = draft.assets.some(
      (current) => current.token.toLowerCase() === asset.token.toLowerCase(),
    );
    if (present) {
      if (draft.assets.length <= 2) {
        setError("A Space needs at least two supported assets.");
        return;
      }
      updateDraft({
        assets: draft.assets.filter(
          (current) =>
            current.token.toLowerCase() !== asset.token.toLowerCase(),
        ),
      });
    } else updateDraft({ assets: [...draft.assets, asset] });
  }

  async function sign(
    operation: SpaceMutationOperation,
    value: SpaceDraft | undefined,
  ) {
    if (!wallet.address || wallet.status !== "connected" || !wallet.provider)
      throw new Error("Connect the Space owner wallet before saving.");
    const prepared = await client.prepareSpaceMutation({
      operation,
      spaceId: draft.id,
      ownerAddress: wallet.address,
      ...(value ? { draft: value } : {}),
    });
    const signature = (await wallet.provider.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, JSON.stringify(prepared.typedData)],
    })) as string;
    const result = await client.confirmSpaceMutation({
      operation,
      spaceId: draft.id,
      ownerAddress: wallet.address,
      ...(value ? { draft: value } : {}),
      authorization: { ...prepared.authorization, signature },
    });
    invalidateSpaceCache(draft.id);
    return result;
  }

  async function saveDraft() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setSetupDetails(null);
    setSetupState("idle");
    try {
      const result = await sign(saved ? "UPDATE" : "CREATE", {
        ...draft,
        ownerAddress: wallet.address ?? draft.ownerAddress,
      });
      setSaved(result.space);
      setMessage(
        result.space.identity.state === "DRAFT"
          ? "Draft saved. Trading is not active yet."
          : appMode === "testnet"
            ? "Draft saved. Confirm the next owner approval to apply the rules."
            : "Space changes confirmed.",
      );
      if (!existing)
        navigate(`${spaceUrl(result.space.identity.id, "settings")}`, {
          replace: true,
        });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function activate(action: "start" | "check" | "retry" = "start") {
    setBusy(true);
    setError(null);
    setMessage(null);
    setSetupDetails(null);
    setSetupState(action === "check" ? "submitted" : "awaiting-signature");
    try {
      let current = saved;
      if (appMode === "testnet") {
        if (!wallet.address || !wallet.provider)
          throw new Error("Connect the owner wallet.");
        if (!current) {
          const created = await sign("CREATE", {
            ...draft,
            ownerAddress: wallet.address,
          });
          current = created.space;
          setSaved(current);
        }
        const operation =
          current.identity.state === "ACTIVE" ||
          current.identity.state === "REACTIVATION_REQUIRED" ||
          current.identity.state === "PAUSED"
            ? "UPDATE"
            : "ACTIVATE";
        if (operation === "UPDATE") await sign("UPDATE", draft);
        const space = await activateTestnetSpace(
          current.identity.id,
          wallet.address,
          wallet.provider,
          (progress) => {
            setMessage(setupProgressLabel(progress));
            if (/awaiting wallet approval/i.test(progress))
              setSetupState("awaiting-signature");
            else if (/submitted|waiting for confirmation/i.test(progress))
              setSetupState("submitted");
          },
          operation,
          action,
        );
        setSaved(space);
        invalidateSpaceCache(space.identity.id);
        setSetupState("confirmed");
        setMessage("Space setup confirmed on the test network.");
        navigate(spaceUrl(space.identity.id, "settings"), { replace: true });
        return;
      }
      if (!current || current.identity.state === "DRAFT") {
        if (!current) {
          const created = await sign("CREATE", draft);
          current = created.space;
          setSaved(current);
        }
        const result = await sign("ACTIVATE", draft);
        setSaved(result.space);
        setMessage(
          result.space.identity.mode === "demo"
            ? "Space activated in the local demo authority."
            : "Space activation confirmed by the configured chain authority.",
        );
        navigate(spaceUrl(result.space.identity.id, "settings"), {
          replace: true,
        });
      } else {
        const result = await sign("UPDATE", draft);
        setSaved(result.space);
        setMessage("Space rules updated and confirmed.");
      }
    } catch (requestError) {
      if (requestError instanceof SetupRecoveryError) {
        setSetupState(
          requestError.state === "pending" ? "submitted" : requestError.state,
        );
        setSetupDetails(
          requestError.state === "pending"
            ? "The wallet request was sent and is awaiting network confirmation."
            : requestError.state === "testnet-mismatch"
              ? "The wallet and service are using different test-network instances."
              : "The network did not confirm this setup request. Review the Space details before retrying.",
        );
        setError(
          requestError.state === "pending"
            ? "Setup is submitted and still awaiting confirmation."
            : requestError.state === "testnet-mismatch"
              ? "The wallet and service are using different test-network instances."
              : "Setup needs verification before another transaction can be approved.",
        );
      } else setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  const title = existing ? "Edit Space" : "Create Space";
  return (
    <section
      className={`space-y-5 text-slate-200 ${embedded ? "" : "mx-auto max-w-3xl"}`}
    >
      {!embedded && (
        <Link
          to={existing ? spaceUrl(existing.identity.id, "settings") : "/spaces"}
          className="inline-flex items-center gap-2 text-sm text-cyan-300"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Link>
      )}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Space management
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">{title}</h1>
        <p className="mt-2 text-slate-400">
          Set the assets, allocation ranges, starting funding, and maximum trade
          before the owner approves the Space.
        </p>
      </div>

      <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        {[
          "Name",
          "Assets",
          "Allocation ranges",
          "Funding & limit",
          "Review",
        ].map((label, index) => {
          const active = step === index + 1;
          return (
            <li
              key={label}
              className={`rounded-lg border px-3 py-2 ${active ? "border-cyan-600 bg-cyan-950/40 text-cyan-200" : "border-slate-800 text-slate-500"}`}
            >
              <span className="mr-1">{index + 1}.</span>
              {label}
            </li>
          );
        })}
      </ol>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-800 bg-red-950/30 p-4 text-red-200"
        >
          {error}
        </p>
      )}
      {message && (
        <p
          role="status"
          className="rounded-lg border border-emerald-800 bg-emerald-950/30 p-4 text-emerald-200"
        >
          {message}
        </p>
      )}
      {existing &&
        !existing.draft &&
        existing.failureReason
          ?.toLowerCase()
          .includes("configurable funding") && (
          <p
            role="alert"
            className="rounded-lg border border-amber-800 bg-amber-950/30 p-4 text-amber-200"
          >
            This saved Space predates configurable funding. Review and sign a
            new draft with explicit USDC and WETH amounts; its old funding is
            not being reused.
          </p>
        )}

      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-6">
        {step === 1 && (
          <div className="space-y-4">
            <label className="block text-sm text-slate-300">
              Space name
              <input
                className={fieldClass()}
                value={draft.name}
                onChange={(event) => updateDraft({ name: event.target.value })}
                maxLength={100}
              />
            </label>
            <details className="text-sm text-slate-400">
              <summary className="cursor-pointer">
                Space identity details
              </summary>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Space ID</dt>
                  <dd className="mt-1 break-all text-slate-200">{draft.id}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Owner wallet</dt>
                  <dd className="mt-1 break-all text-slate-200">
                    {draft.ownerAddress}
                  </dd>
                </div>
              </dl>
            </details>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Choose the assets this Space can hold and trade. USDC and WETH are
              required for the current trading pair.
            </p>
            {assets.map((asset) => {
              const selected = draft.assets.some(
                (current) =>
                  current.token.toLowerCase() === asset.token.toLowerCase(),
              );
              return (
                <label
                  key={asset.token}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-800 p-3 hover:border-cyan-700"
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleAsset(asset)}
                    className="h-4 w-4 accent-cyan-600"
                  />
                  <span className="font-medium text-white">{asset.symbol}</span>
                  <span className="text-xs text-slate-500">{asset.token}</span>
                </label>
              );
            })}
          </div>
        )}
        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Set the minimum and maximum allocation for each asset. 100 basis
              points equals 1%; the Space is checked before approval.
            </p>
            {assets
              .filter((asset) =>
                draft.assets.some(
                  (current) =>
                    current.token.toLowerCase() === asset.token.toLowerCase(),
                ),
              )
              .map((asset) => (
                <div
                  key={asset.token}
                  className="grid gap-3 rounded-lg border border-slate-800 p-3 sm:grid-cols-3 sm:items-end"
                >
                  <p className="font-medium text-white">{asset.symbol}</p>
                  <label className="text-sm text-slate-400">
                    Minimum bps
                    <input
                      className={fieldClass()}
                      type="number"
                      min="0"
                      max="10000"
                      value={asset.minimumText}
                      onChange={(event) =>
                        updateAsset(
                          asset.token,
                          "minimumWeightBps",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                  <label className="text-sm text-slate-400">
                    Maximum bps
                    <input
                      className={fieldClass()}
                      type="number"
                      min="0"
                      max="10000"
                      value={asset.maximumText}
                      onChange={(event) =>
                        updateAsset(
                          asset.token,
                          "maximumWeightBps",
                          event.target.value,
                        )
                      }
                    />
                  </label>
                </div>
              ))}
          </div>
        )}
        {step === 4 && (
          <div className="space-y-4">
            {appMode === "testnet" && supportedChainId === 11155111 && (
              <div className="rounded-lg border border-cyan-900 bg-cyan-950/30 p-4">
                <p className="text-sm font-medium text-cyan-100">
                  Need Sepolia demo funds?
                </p>
                <p className="mt-1 text-xs leading-5 text-cyan-200/80">
                  This deployment uses valueless mock tokens. Claim 35,000 demo
                  USDC and 5 demo WETH to the connected wallet, then continue
                  with the funding amounts below. You still need Sepolia ETH for
                  gas.
                </p>
                <button
                  type="button"
                  disabled={
                    faucetBusy ||
                    wallet.status !== "connected" ||
                    !wallet.provider ||
                    !wallet.address
                  }
                  onClick={() => void claimDemoTokens()}
                  className="mt-3 rounded-lg border border-cyan-600 px-4 py-2.5 text-sm font-medium text-cyan-100 disabled:opacity-40"
                >
                  {faucetBusy
                    ? "Claiming demo tokens…"
                    : "Get free Sepolia demo tokens"}
                </button>
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-slate-200">
                Starting funding
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Add a positive starting balance for each supported asset. Your
                wallet balance and token precision are checked before approval.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["usdc", "weth"] as const).map((token) => {
                const decimals = token === "usdc" ? 6 : 18;
                const balance = walletBalances?.[token];
                let requested = 0n;
                try {
                  requested = parseTokenAmount(draft.funding[token], decimals);
                } catch {
                  /* The server returns the precise validation error on review. */
                }
                return (
                  <label key={token} className="text-sm text-slate-300">
                    {token.toUpperCase()} amount
                    <input
                      className={fieldClass()}
                      inputMode="decimal"
                      value={draft.funding[token]}
                      onChange={(event) =>
                        updateDraft({
                          funding: {
                            ...draft.funding,
                            [token]: event.target.value,
                          },
                        })
                      }
                    />
                    <span className="mt-1 block text-xs text-slate-500">
                      {walletBalances
                        ? `Wallet balance: ${formatTokenAmount(balance ?? 0n, decimals)} ${token.toUpperCase()}${balance !== undefined && balance < requested ? " · insufficient" : ""}`
                        : "Connect the owner wallet to read balance"}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">
              Wallet gas balance:{" "}
              {walletBalances
                ? `${formatTokenAmount(walletBalances.native, 18)} ETH`
                : "connect the owner wallet to read ETH"}
            </p>
            <label className="block text-sm text-slate-300">
              Maximum trade value (normalized settlement units)
              <input
                className={fieldClass()}
                inputMode="numeric"
                value={draft.maximumTransactionValue}
                onChange={(event) =>
                  updateDraft({ maximumTransactionValue: event.target.value })
                }
              />
              <span className="mt-2 block text-xs text-slate-500">
                {appMode === "testnet"
                  ? "This test network accepts 1–1,000,000,000"
                  : "This local demo accepts 1,000–1,000,000,000"}{" "}
                normalized settlement units. Gas is paid by the owner wallet.
              </span>
            </label>
          </div>
        )}
        {step === 5 && (
          <div className="space-y-4">
            <div
              className={`flex items-center gap-2 ${setupState === "confirmed" ? "text-emerald-300" : setupState === "submitted" || setupState === "confirmation-unavailable" ? "text-amber-300" : "text-cyan-300"}`}
              role="status"
              aria-live="polite"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {setupState === "idle" || setupState === "awaiting-signature"
                ? "Ready for owner approval"
                : setupState === "submitted"
                  ? "Waiting for network confirmation"
                  : setupState === "confirmation-unavailable"
                    ? "Confirmation needs attention"
                    : setupState === "testnet-mismatch"
                      ? "Network context changed"
                      : setupState === "action-required"
                        ? "Review required"
                        : "Space ready"}
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Name</dt>
                <dd className="mt-1 text-white">{draft.name}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Chain</dt>
                <dd className="mt-1 text-white">{draft.chainId}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Assets</dt>
                <dd className="mt-1 text-white">
                  {draft.assets.map((asset) => asset.symbol).join(", ")}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Per-trade limit</dt>
                <dd className="mt-1 text-white">
                  {draft.maximumTransactionValue} normalized settlement units
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Starting allocation</dt>
                <dd className="mt-1 text-white">
                  {draft.funding.usdc} USDC + {draft.funding.weth} WETH
                </dd>
              </div>
            </dl>
            {setupDetails && (
              <details className="text-sm text-slate-400">
                <summary>Transaction details</summary>
                <p className="mt-2 break-words">{setupDetails}</p>
              </details>
            )}
            <p className="text-sm leading-6 text-slate-400">
              {appMode === "testnet"
                ? setupState === "submitted"
                  ? "Your wallet request is waiting for confirmation. Check again before trying another request."
                  : setupState === "confirmation-unavailable"
                    ? "The network could not confirm the request. Check again first; retry is offered only after it is safe."
                    : "Review the amounts above and approve the wallet requests. Your Space becomes tradable only after the network confirms setup."
                : "Saving creates a durable draft. Activation or a rule change requires another owner approval; a rejected wallet request leaves the previous state unchanged."}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-between gap-3">
        <button
          type="button"
          disabled={step === 1 || busy}
          onClick={() => setStep((current) => current - 1)}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 disabled:opacity-40"
        >
          Back
        </button>
        <div className="flex flex-wrap gap-2">
          {step < 5 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep((current) => current + 1)}
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Next <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <>
              {appMode === "testnet" &&
                (setupState === "submitted" ||
                  setupState === "confirmation-unavailable") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void activate("check")}
                    className="rounded-lg border border-amber-700 px-4 py-2.5 text-sm text-amber-200 disabled:opacity-40"
                  >
                    Check again
                  </button>
                )}
              {appMode === "testnet" &&
                setupState === "confirmation-unavailable" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void activate("retry")}
                    className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-100 disabled:opacity-40"
                  >
                    Retry setup safely
                  </button>
                )}
              <button
                type="button"
                disabled={
                  busy || (appMode === "testnet" && setupState === "submitted")
                }
                onClick={() => void saveDraft()}
                className="rounded-lg border border-slate-600 px-4 py-2.5 text-sm text-slate-100 disabled:opacity-40"
              >
                {busy ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-label="Saving"
                  />
                ) : (
                  "Save draft"
                )}
              </button>
              {!(
                appMode === "testnet" &&
                (setupState === "submitted" ||
                  setupState === "confirmation-unavailable")
              ) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void activate()}
                  className="rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
                >
                  {appMode === "testnet"
                    ? saved?.identity.state === "ACTIVE" ||
                      saved?.identity.state === "REACTIVATION_REQUIRED" ||
                      saved?.identity.state === "PAUSED"
                      ? "Apply rules"
                      : "Create Space"
                    : existing?.identity.state === "ACTIVE" ||
                        existing?.identity.state === "REACTIVATION_REQUIRED" ||
                        existing?.identity.state === "PAUSED"
                      ? "Save changes"
                      : "Create / activate"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function SpaceOwnerControls({
  space,
  onChanged,
}: {
  readonly space: SpaceRecord;
  readonly onChanged?: (next: SpaceRecord) => void;
}) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isOwner =
    wallet.address?.toLowerCase() === space.identity.ownerAddress.toLowerCase();
  const operation: SpaceMutationOperation =
    space.identity.state === "PAUSED" ? "RESUME" : "PAUSE";

  async function toggle() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!wallet.address || !wallet.provider || wallet.status !== "connected")
        throw new Error(
          "Connect the recorded Space owner wallet before changing policy.",
        );
      if (appMode === "testnet") {
        const next = await activateTestnetSpace(
          space.identity.id,
          wallet.address,
          wallet.provider,
          setMessage,
          operation,
        );
        onChanged?.(next);
        setMessage(
          operation === "PAUSE"
            ? "Trading paused on the test network."
            : "Trading resumed after network confirmation.",
        );
        return;
      }
      const prepared = await client.prepareSpaceMutation({
        operation,
        spaceId: space.identity.id,
        ownerAddress: wallet.address,
      });
      const signature = (await wallet.provider.request({
        method: "eth_signTypedData_v4",
        params: [wallet.address, JSON.stringify(prepared.typedData)],
      })) as string;
      const result = await client.confirmSpaceMutation({
        operation,
        spaceId: space.identity.id,
        ownerAddress: wallet.address,
        authorization: { ...prepared.authorization, signature },
      });
      onChanged?.(result.space);
      invalidateSpaceCache(space.identity.id);
      setMessage(
        operation === "PAUSE" ? "Trading paused." : "Trading resumed.",
      );
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div>
        <h3 className="font-medium text-white">Trading controls</h3>
        <p className="mt-1 text-sm leading-6 text-slate-400">
          Pause or resume trading with a fresh approval from the recorded owner.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-300">
          {message}
        </p>
      )}
      <button
        type="button"
        disabled={
          !isOwner ||
          wallet.status !== "connected" ||
          !wallet.provider ||
          busy ||
          (space.identity.state !== "ACTIVE" &&
            space.identity.state !== "REACTIVATION_REQUIRED" &&
            space.identity.state !== "PAUSED")
        }
        onClick={() => void toggle()}
        className="rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy
          ? "Waiting for wallet…"
          : operation === "PAUSE"
            ? "Pause trading"
            : "Resume trading"}
      </button>
      {!isOwner && (
        <p className="text-xs text-amber-300">
          Connect the recorded owner wallet to use this control.
        </p>
      )}
    </div>
  );
}
