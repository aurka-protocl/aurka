import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Check, LoaderCircle } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  type AssetBound,
  type SpaceDraft,
  type SpaceMutationOperation,
  type SpaceRecord,
} from "@aurka/shared";
import { apiBaseUrl, appMode, supportedChainId } from "../config";
import { activateForkSpace } from "../domain/space-setup";
import { spaceUrl } from "../domain/spaces";
import { useWallet } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
const ZERO = "0x0000000000000000000000000000000000000000";
const supportedAssets: readonly AssetBound[] =
  appMode === "fork"
    ? [
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

type DraftAsset = AssetBound & {
  readonly minimumText: string;
  readonly maximumText: string;
};

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
      id: existing.identity.id,
      name: existing.identity.name,
      ownerAddress: existing.identity.ownerAddress,
      chainId: existing.identity.chainId,
      assets: existing.position.policy.assets,
      maximumTransactionValue: existing.position.policy.maximumTransactionValue,
    };
  }
  return {
    id: newSpaceId(),
    name: "New Aurka Space",
    ownerAddress: walletAddress,
    chainId: supportedChainId,
    assets: supportedAssets.slice(0, 2),
    maximumTransactionValue: "5000",
  };
}

function fieldClass(): string {
  return "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-slate-100 outline-none focus:border-cyan-500";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Space change failed";
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
    return client.confirmSpaceMutation({
      operation,
      spaceId: draft.id,
      ownerAddress: wallet.address,
      ...(value ? { draft: value } : {}),
      authorization: { ...prepared.authorization, signature },
    });
  }

  async function saveDraft() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await sign(saved ? "UPDATE" : "CREATE", {
        ...draft,
        ownerAddress: wallet.address ?? draft.ownerAddress,
      });
      setSaved(result.space);
      setMessage(
        result.space.identity.state === "DRAFT"
          ? "Draft saved. No deployment or activation has been claimed."
          : appMode === "fork"
            ? "Name and draft saved. Apply rules onchain to change trading policy."
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

  async function activate() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let current = saved;
      if (appMode === "fork") {
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
          current.identity.state === "PAUSED"
            ? "UPDATE"
            : "ACTIVATE";
        if (operation === "UPDATE") await sign("UPDATE", draft);
        const space = await activateForkSpace(
          current.identity.id,
          wallet.address,
          wallet.provider,
          setMessage,
          operation,
        );
        setSaved(space);
        setMessage("Space activation verified onchain.");
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
      setError(errorMessage(requestError));
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
          Owner-authorized changes are signed for this Space, chain, and exact
          reviewed draft.
        </p>
      </div>

      <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        {[
          "Name",
          "Assets",
          "Allocation ranges",
          "Transaction limit",
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
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Stable Space ID</dt>
                <dd className="mt-1 break-all text-slate-200">{draft.id}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Owner/controller</dt>
                <dd className="mt-1 break-all text-slate-200">
                  {draft.ownerAddress}
                </dd>
              </div>
            </dl>
          </div>
        )}
        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Choose from assets supported by this environment. The current
              local trading pair requires USDC and WETH.
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
              Ranges are integer basis points: 100 bps equals 1%. The server
              checks duplicate assets and feasibility before accepting the
              signed draft.
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
          <label className="block text-sm text-slate-300">
            Maximum transaction value (value units)
            <input
              className={fieldClass()}
              inputMode="numeric"
              value={draft.maximumTransactionValue}
              onChange={(event) =>
                updateDraft({ maximumTransactionValue: event.target.value })
              }
            />
            <span className="mt-2 block text-xs text-slate-500">
              {appMode === "fork"
                ? "This fork accepts 1–1000000000"
                : "This local demo accepts 1000–1000000000"}{" "}
              value units. A deployed chain policy remains the final authority.
            </span>
          </label>
        )}
        {step === 5 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-emerald-300">
              <Check className="h-4 w-4" aria-hidden="true" /> Ready for owner
              signature
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
                  {draft.maximumTransactionValue} value units
                </dd>
              </div>
            </dl>
            <p className="text-sm leading-6 text-slate-400">
              {appMode === "fork"
                ? "Save your draft before activation. Setup creates a dedicated treasury, transfers 35,000 USDC and 5 WETH from your wallet, approves settlement, registers these balances in MockAqua, and authorizes trading. Each step needs a wallet transaction and gas on the local fork. Retry continues verified setup; trading starts only after server verification."
                : "Saving creates a durable draft. Activation or a rule change requires another exact signature; a rejected wallet request leaves the previous state unchanged."}
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
              <button
                type="button"
                disabled={busy}
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
              <button
                type="button"
                disabled={busy}
                onClick={() => void activate()}
                className="rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
              >
                {appMode === "fork"
                  ? saved?.identity.state === "ACTIVE" ||
                    saved?.identity.state === "PAUSED"
                    ? "Apply rules onchain"
                    : "Deploy / continue activation"
                  : existing?.identity.state === "ACTIVE" ||
                      existing?.identity.state === "PAUSED"
                    ? "Save changes"
                    : "Deploy / activate"}
              </button>
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
      if (appMode === "fork") {
        const next = await activateForkSpace(
          space.identity.id,
          wallet.address,
          wallet.provider,
          setMessage,
          operation,
        );
        onChanged?.(next);
        setMessage(
          operation === "PAUSE"
            ? "Trading paused onchain."
            : "Trading resumed. Authorize fresh capacity before quoting.",
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
          Pause and resume are policy changes. Each action needs a fresh
          signature from the recorded owner and increments the policy nonce.
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
          Connect the recorded owner to use this control.
        </p>
      )}
    </div>
  );
}
