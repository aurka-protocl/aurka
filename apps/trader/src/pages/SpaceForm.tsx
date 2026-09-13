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
import {
  deleteTestnetSpace,
  recoverTestnetSpace,
  type RecoveryState,
} from "../domain/space-recovery";
import { invalidateSpaceCache, spaceUrl } from "../domain/spaces";
import { displayAssetSymbol, setupProgressLabel, userFacingError } from "../ui";
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
    minimumWeightBps: 1,
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
            minimumWeightBps: 1,
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
          minimumWeightBps: 1,
          maximumWeightBps: 3_500,
        },
        {
          token: "0x3333333333333333333333333333333333333333",
          symbol: "LINK",
          decimals: 0,
          minimumWeightBps: 1,
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

type FundingRange = {
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumRaw: bigint;
  readonly maximumRaw: bigint | null;
};

type FundingGuidance = {
  readonly available: boolean;
  readonly price: number | null;
  readonly lowerUsdcWeightBps: number | null;
  readonly upperUsdcWeightBps: number | null;
  readonly currentUsdcWeightBps: number | null;
  readonly wethForUsdc: FundingRange | null;
  readonly usdcForWeth: FundingRange | null;
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
    "We couldn't save this Space. Review the details and try again.",
  );
}

function percentageText(bps: number): string {
  return String(bps / 100);
}

function assetHasSymbol(asset: AssetBound, symbol: string): boolean {
  return displayAssetSymbol(asset.symbol).toUpperCase() === symbol;
}

function percentageToBps(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.round(Math.min(100, Math.max(0.01, parsed)) * 100);
}

function positiveAmount(value: string): number | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type ReferencePrice = {
  readonly raw: bigint;
  readonly decimals: number;
  readonly value: number;
};

function referencePriceInUsdc(
  asset: AssetBound,
  existing?: SpaceRecord,
): ReferencePrice {
  const snapshotAsset = existing?.position?.currentPortfolio?.assets.find(
    (current) => current.token.toLowerCase() === asset.token.toLowerCase(),
  );
  if (snapshotAsset) {
    const raw = String(snapshotAsset.price);
    const decimals = Number(snapshotAsset.priceDecimals);
    if (/^[0-9]+$/.test(raw) && Number.isInteger(decimals) && decimals >= 0) {
      const value = Number(raw) / 10 ** decimals;
      if (Number.isFinite(value) && value > 0)
        return { raw: BigInt(raw), decimals, value };
    }
  }

  // The local Sepolia/demo oracle uses these deliberately fixed prices. Keep
  // this visible in the form; it is guidance for the draft, not market data.
  if (assetHasSymbol(asset, "USDC"))
    return { raw: 1n, decimals: 0, value: 1 };
  if (assetHasSymbol(asset, "WETH"))
    return { raw: 3_200n, decimals: 0, value: 3_200 };
  return { raw: 1n, decimals: 0, value: 1 };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

function settlementValue(
  rawAmount: bigint,
  asset: AssetBound,
  price: ReferencePrice,
): bigint {
  const denominator =
    10n ** BigInt(asset.decimals + price.decimals);
  return ceilDiv(rawAmount * price.raw, denominator);
}

function rawAmountForMinimumValue(
  value: bigint,
  asset: AssetBound,
  price: ReferencePrice,
): bigint {
  if (value <= 0n) return 1n;
  const denominator = 10n ** BigInt(asset.decimals + price.decimals);
  // The chain values with ceil(balance × price / scale), so any positive
  // amount rounds to one value unit and higher values start just after v-1.
  return ((value - 1n) * denominator) / price.raw + 1n;
}

function rawAmountForMaximumValue(
  value: bigint,
  asset: AssetBound,
  price: ReferencePrice,
): bigint {
  const denominator = 10n ** BigInt(asset.decimals + price.decimals);
  return (value * denominator) / price.raw;
}

function fundingRange(
  minimumValue: bigint,
  maximumValue: bigint | null,
  asset: AssetBound,
  price: ReferencePrice,
): FundingRange {
  const minimumRaw = rawAmountForMinimumValue(minimumValue, asset, price);
  const maximumRaw =
    maximumValue === null
      ? null
      : rawAmountForMaximumValue(maximumValue, asset, price);
  return {
    minimum: Number(formatTokenAmount(minimumRaw, asset.decimals)),
    maximum:
      maximumRaw === null
        ? Number.POSITIVE_INFINITY
        : Number(formatTokenAmount(maximumRaw, asset.decimals)),
    minimumRaw,
    maximumRaw,
  };
}

function calculateFundingGuidance(
  selectedAssets: readonly DraftAsset[],
  funding: SpaceDraft["funding"],
  existing?: SpaceRecord,
): FundingGuidance {
  const usdc = selectedAssets.find((asset) => assetHasSymbol(asset, "USDC"));
  const weth = selectedAssets.find((asset) => assetHasSymbol(asset, "WETH"));
  if (!usdc || !weth)
    return {
      available: false,
      price: null,
      lowerUsdcWeightBps: null,
      upperUsdcWeightBps: null,
      currentUsdcWeightBps: null,
      wethForUsdc: null,
      usdcForWeth: null,
    };

  const usdcPrice = referencePriceInUsdc(usdc, existing);
  const wethPrice = referencePriceInUsdc(weth, existing);
  const lowerUsdcWeightBps = Math.max(
    usdc.minimumWeightBps,
    10_000 - weth.maximumWeightBps,
  );
  const upperUsdcWeightBps = Math.min(
    usdc.maximumWeightBps,
    10_000 - weth.minimumWeightBps,
  );
  let usdcRaw: bigint | null = null;
  let wethRaw: bigint | null = null;
  try {
    usdcRaw =
      positiveAmount(funding.usdc) === null
        ? null
        : parseTokenAmount(funding.usdc, usdc.decimals);
    wethRaw =
      positiveAmount(funding.weth) === null
        ? null
        : parseTokenAmount(funding.weth, weth.decimals);
  } catch {
    usdcRaw = null;
    wethRaw = null;
  }
  const usdcValue =
    usdcRaw === null ? null : settlementValue(usdcRaw, usdc, usdcPrice);
  const wethValue =
    wethRaw === null ? null : settlementValue(wethRaw, weth, wethPrice);
  const totalValue =
    usdcValue === null || wethValue === null ? null : usdcValue + wethValue;
  const currentUsdcWeightBps =
    totalValue === null || totalValue <= 0 || usdcValue === null
      ? null
      : (Number(usdcValue) / Number(totalValue)) * 10_000;

  const wethForUsdc =
    usdcValue === null
      ? null
      : {
          ...fundingRange(
            upperUsdcWeightBps >= 10_000
              ? 0n
              : ceilDiv(
                  BigInt(10_000 - upperUsdcWeightBps) * usdcValue,
                  BigInt(upperUsdcWeightBps),
                ),
            lowerUsdcWeightBps <= 0
              ? null
              : (BigInt(10_000 - lowerUsdcWeightBps) * usdcValue) /
                BigInt(lowerUsdcWeightBps),
            weth,
            wethPrice,
          ),
        };
  const usdcForWeth =
    wethValue === null
      ? null
      : {
          ...fundingRange(
            lowerUsdcWeightBps >= 10_000
              ? 1n
              : ceilDiv(
                  BigInt(lowerUsdcWeightBps) * wethValue,
                  BigInt(10_000 - lowerUsdcWeightBps),
                ),
            upperUsdcWeightBps >= 10_000
              ? null
              : (BigInt(upperUsdcWeightBps) * wethValue) /
                BigInt(10_000 - upperUsdcWeightBps),
            usdc,
            usdcPrice,
          ),
        };

  return {
    available: true,
    price: wethPrice.value / usdcPrice.value,
    lowerUsdcWeightBps,
    upperUsdcWeightBps,
    currentUsdcWeightBps,
    wethForUsdc,
    usdcForWeth,
  };
}

function describeFundingRange(
  range: FundingRange | null,
  symbol: string,
  decimals: number,
): string | null {
  if (!range) return null;
  if (
    range.maximumRaw !== null &&
    range.maximumRaw < range.minimumRaw
  )
    return `no valid ${symbol} amount at this balance`;
  const minimum = formatTokenAmount(range.minimumRaw, decimals);
  const maximum =
    range.maximumRaw === null
      ? "no limit"
      : `${formatTokenAmount(range.maximumRaw, decimals)} ${symbol}`;
  return `minimum ${range.minimumRaw <= 0n ? ">0" : `${minimum} ${symbol}`} · maximum ${maximum}`;
}

function fundingRangeIsValid(range: FundingRange | null): boolean {
  return Boolean(
    range &&
      (range.maximumRaw === null || range.maximumRaw >= range.minimumRaw),
  );
}

function fundingRangeAmount(
  range: FundingRange | null,
  edge: "minimum" | "maximum",
  decimals: number,
): string | null {
  if (!range || !fundingRangeIsValid(range)) return null;
  const raw = edge === "minimum" ? range.minimumRaw : range.maximumRaw;
  return raw === null ? null : formatTokenAmount(raw, decimals);
}

function formatWeightBps(value: number): string {
  return `${(value / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

function allocationIssue(selectedAssets: readonly DraftAsset[]): string | null {
  if (selectedAssets.length < 2) return "A Space needs at least two assets.";
  const minimumTotal = selectedAssets.reduce(
    (total, asset) => total + asset.minimumWeightBps,
    0,
  );
  const maximumTotal = selectedAssets.reduce(
    (total, asset) => total + asset.maximumWeightBps,
    0,
  );
  for (const asset of selectedAssets) {
    if (
      !Number.isInteger(asset.minimumWeightBps) ||
      !Number.isInteger(asset.maximumWeightBps) ||
      asset.minimumWeightBps < 1 ||
      asset.maximumWeightBps < 1 ||
      asset.maximumWeightBps > 10_000
    )
      return `${displayAssetSymbol(asset.symbol)} must stay between 0.01% and 100%.`;
    if (asset.minimumWeightBps > asset.maximumWeightBps)
      return `${displayAssetSymbol(asset.symbol)} minimum cannot be greater than its maximum.`;
  }
  if (minimumTotal > 10_000)
    return `Minimum allocations total ${formatWeightBps(minimumTotal)}. They must total 100% or less.`;
  if (maximumTotal < 10_000)
    return `Maximum allocations total ${formatWeightBps(maximumTotal)}. They must cover 100% or more.`;
  return null;
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

  async function claimTestnetAssets() {
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
        throw new Error("Connect a wallet on Sepolia before funding it.");

      const chainId = await wallet.provider.request({ method: "eth_chainId" });
      if (typeof chainId !== "string" || BigInt(chainId) !== 11_155_111n)
        throw new Error(
          "Switch the wallet to Ethereum Sepolia before funding it.",
        );

      const claims = [
        { asset: SEPOLIA_ASSETS[0], amount: parseTokenAmount("35000", 6) },
        { asset: SEPOLIA_ASSETS[1], amount: parseTokenAmount("5", 18) },
      ];
      for (const claim of claims) {
        setMessage(`Approve the ${claim.asset.symbol} funding in your wallet.`);
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
          throw new Error("The wallet did not return a funding transaction.");
        setMessage(`Waiting for the ${claim.asset.symbol} funding to confirm…`);
        await waitForReceipt(wallet.provider, hash);
      }
      setBalanceRevision((current) => current + 1);
      setMessage(
        "Wallet funded: 35,000 USDC + 5 WETH. You can continue creating the Space.",
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

  const selectedAssets = useMemo(
    () =>
      assets.filter((asset) =>
        draft.assets.some(
          (current) =>
            current.token.toLowerCase() === asset.token.toLowerCase(),
        ),
      ),
    [assets, draft.assets],
  );
  const allocationError = useMemo(
    () => allocationIssue(selectedAssets),
    [selectedAssets],
  );
  const fundingGuidance = useMemo(
    () => calculateFundingGuidance(selectedAssets, draft.funding, existing),
    [draft.funding, existing, selectedAssets],
  );
  const fundingError = useMemo(() => {
    for (const [token, decimals] of [
      ["USDC", 6],
      ["WETH", 18],
    ] as const) {
      const value = draft.funding[token.toLowerCase() as "usdc" | "weth"];
      const parsed = positiveAmount(value);
      if (parsed === null)
        return `${token} starting balance must be greater than zero and use a plain decimal amount.`;
      try {
        if (parseTokenAmount(value, decimals) === 0n)
          return `${token} starting balance must be greater than zero.`;
      } catch {
        return `${token} starting balance has more precision than the token supports (${decimals} decimals).`;
      }
      if (!Number.isFinite(parsed))
        return `${token} starting balance is too large.`;
    }
    if (
      fundingGuidance.currentUsdcWeightBps !== null &&
      fundingGuidance.lowerUsdcWeightBps !== null &&
      fundingGuidance.upperUsdcWeightBps !== null &&
      (fundingGuidance.currentUsdcWeightBps <
        fundingGuidance.lowerUsdcWeightBps ||
        fundingGuidance.currentUsdcWeightBps >
          fundingGuidance.upperUsdcWeightBps)
    )
      return `These balances create ${formatWeightBps(fundingGuidance.currentUsdcWeightBps)} USDC and ${formatWeightBps(10_000 - fundingGuidance.currentUsdcWeightBps)} WETH. Change either amount to fit the allocation range below.`;
    return null;
  }, [draft.funding, fundingGuidance]);

  function updateDraft(next: Partial<SpaceDraft>) {
    setError(null);
    setMessage(null);
    setDraft((current) => ({ ...current, ...next }));
  }

  function setFundingAmount(token: "usdc" | "weth", amount: string) {
    updateDraft({
      funding: {
        ...draft.funding,
        [token]: amount,
      },
    });
  }

  function updateAsset(
    token: string,
    field: "minimumWeightBps" | "maximumWeightBps",
    value: string,
  ) {
    const nextValue = percentageToBps(value);
    setError(null);
    setMessage(null);
    setDraft((current) => ({
      ...current,
      assets: current.assets.map((asset) => {
        if (asset.token.toLowerCase() !== token.toLowerCase()) return asset;
        if (field === "minimumWeightBps")
          return {
            ...asset,
            minimumWeightBps: nextValue,
            maximumWeightBps: Math.max(asset.maximumWeightBps, nextValue),
          };
        return {
          ...asset,
          minimumWeightBps: Math.min(asset.minimumWeightBps, nextValue),
          maximumWeightBps: nextValue,
        };
      }),
    }));
  }

  function toggleAsset(asset: AssetBound) {
    const present = draft.assets.some(
      (current) => current.token.toLowerCase() === asset.token.toLowerCase(),
    );
    if (present) {
      if (draft.assets.length <= 2) {
        setError("A Space needs at least two assets.");
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

  function draftIssue(): string | null {
    return allocationError ?? fundingError;
  }

  function nextStep() {
    const issue =
      step === 3 ? allocationError : step === 4 ? fundingError : null;
    if (issue) {
      setError(issue);
      return;
    }
    setError(null);
    setStep((current) => current + 1);
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
    const issue = draftIssue();
    if (issue) {
      setError(issue);
      setStep(allocationError ? 3 : 4);
      return;
    }
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
            ? "Draft saved. Confirm the next wallet approval to apply the rules."
            : "Space changes confirmed.",
      );
      if (!existing)
        navigate(spaceUrl(result.space.identity.id), {
          replace: true,
        });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function activate(action: "start" | "check" | "retry" = "start") {
    const issue = draftIssue();
    if (issue) {
      setError(issue);
      setStep(allocationError ? 3 : 4);
      return;
    }
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
        setMessage("Space setup confirmed.");
        navigate(spaceUrl(space.identity.id), { replace: true });
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
        setMessage("Space activation confirmed.");
        navigate(spaceUrl(result.space.identity.id), {
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
              ? "The network changed while setup was in progress. Switch to Ethereum Sepolia and try again."
              : "We couldn't confirm setup. Check your wallet and try again.",
        );
        setError(
          requestError.state === "pending"
            ? "Setup is submitted and still awaiting confirmation."
            : requestError.state === "testnet-mismatch"
              ? "The network changed while setup was in progress. Switch to Ethereum Sepolia and try again."
              : "Setup needs to be checked before another approval can be requested.",
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
          to={existing ? spaceUrl(existing.identity.id) : "/spaces"}
          className="inline-flex items-center gap-2 text-sm text-cyan-300"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Link>
      )}
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          Portfolio settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-white">{title}</h1>
        <p className="mt-2 text-slate-400">
          Choose the assets, allocation ranges, starting balance, and trade
          limit for this Space.
        </p>
      </div>

      <ol className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
        {[
          "Name",
          "Assets",
          "Allocation ranges",
          "Starting balance & limit",
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
            Review the starting balances and approve the updated Space settings.
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
          </div>
        )}
        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Choose the assets this Space can hold and trade. USDC and WETH are
              available for swaps on this network.
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
                  <span className="font-medium text-white">
                    {displayAssetSymbol(asset.symbol)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Set the minimum and maximum share for each asset. Use the sliders
              or type a value from 0.01% to 100%. The two bounds are kept in
              order automatically and checked before a Space can be created.
            </p>
            {selectedAssets.map((asset) => (
              <div
                key={asset.token}
                className="rounded-lg border border-slate-800 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-white">
                    {displayAssetSymbol(asset.symbol)}
                  </p>
                  <span className="text-xs text-slate-500">
                    {percentageText(Number(asset.minimumText))}%–
                    {percentageText(Number(asset.maximumText))}%
                  </span>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <label className="text-sm text-slate-400">
                    Minimum allocation
                    <div className="mt-2 flex items-center gap-3">
                      <input
                        aria-label="Minimum allocation slider"
                        className="w-full accent-cyan-400"
                        type="range"
                        min="1"
                        max="10000"
                        step="1"
                        value={Number(asset.minimumText)}
                        onChange={(event) =>
                          updateAsset(
                            asset.token,
                            "minimumWeightBps",
                            percentageText(Number(event.target.value)),
                          )
                        }
                      />
                      <div className="relative w-24 shrink-0">
                        <input
                          className={fieldClass()}
                          type="number"
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={percentageText(Number(asset.minimumText))}
                          onChange={(event) =>
                            updateAsset(
                              asset.token,
                              "minimumWeightBps",
                              event.target.value,
                            )
                          }
                        />
                        <span className="pointer-events-none absolute right-3 top-3 text-slate-500">
                          %
                        </span>
                      </div>
                    </div>
                  </label>
                  <label className="text-sm text-slate-400">
                    Maximum allocation
                    <div className="mt-2 flex items-center gap-3">
                      <input
                        aria-label="Maximum allocation slider"
                        className="w-full accent-cyan-400"
                        type="range"
                        min="1"
                        max="10000"
                        step="1"
                        value={Number(asset.maximumText)}
                        onChange={(event) =>
                          updateAsset(
                            asset.token,
                            "maximumWeightBps",
                            percentageText(Number(event.target.value)),
                          )
                        }
                      />
                      <div className="relative w-24 shrink-0">
                        <input
                          className={fieldClass()}
                          type="number"
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={percentageText(Number(asset.maximumText))}
                          onChange={(event) =>
                            updateAsset(
                              asset.token,
                              "maximumWeightBps",
                              event.target.value,
                            )
                          }
                        />
                        <span className="pointer-events-none absolute right-3 top-3 text-slate-500">
                          %
                        </span>
                      </div>
                    </div>
                  </label>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Every selected asset must have a positive allocation range.
                  Bounds are limited to 0.01%–100%.
                </p>
              </div>
            ))}
            <p className="text-xs text-slate-500">
              Allocation totals: minimum{" "}
              {formatWeightBps(
                selectedAssets.reduce(
                  (total, asset) => total + asset.minimumWeightBps,
                  0,
                ),
              )}{" "}
              · maximum{" "}
              {formatWeightBps(
                selectedAssets.reduce(
                  (total, asset) => total + asset.maximumWeightBps,
                  0,
                ),
              )}
              .
            </p>
            {allocationError && (
              <p className="text-xs text-amber-200">{allocationError}</p>
            )}
          </div>
        )}
        {step === 4 && (
          <div className="space-y-4">
            {appMode === "testnet" && supportedChainId === 11155111 && (
              <div className="rounded-lg border border-cyan-900 bg-cyan-950/30 p-4">
                <p className="text-sm font-medium text-cyan-100">
                  Need assets to get started?
                </p>
                <p className="mt-1 text-xs leading-5 text-cyan-200/80">
                  Add 35,000 USDC and 5 WETH to the connected wallet, then
                  continue with the funding amounts below. You still need
                  Sepolia ETH for fees.
                </p>
                <button
                  type="button"
                  disabled={
                    faucetBusy ||
                    wallet.status !== "connected" ||
                    !wallet.provider ||
                    !wallet.address
                  }
                  onClick={() => void claimTestnetAssets()}
                  className="mt-3 rounded-lg border border-cyan-600 px-4 py-2.5 text-sm font-medium text-cyan-100 disabled:opacity-40"
                >
                  {faucetBusy ? "Funding wallet…" : "Fund wallet"}
                </button>
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-slate-200">
                Starting balance
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Choose positive starting balances. The generator checks their
                value at the reference price so the portfolio starts inside the
                allocation range.
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
                      type="number"
                      min={
                        token === "usdc" ? "0.000001" : "0.000000000000000001"
                      }
                      step={
                        token === "usdc" ? "0.000001" : "0.000000000000000001"
                      }
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
                        : "Connect your wallet to read balance"}
                    </span>
                    <span className="mt-2 block text-xs leading-5 text-cyan-200/75">
                      {token === "usdc"
                        ? fundingGuidance.usdcForWeth
                          ? "For " +
                            (draft.funding.weth || "this WETH amount") +
                            " WETH, choose USDC: " +
                            describeFundingRange(
                              fundingGuidance.usdcForWeth,
                              "USDC",
                              6,
                            ) +
                            "."
                          : "Enter a positive WETH amount to see the allowed USDC range."
                        : fundingGuidance.wethForUsdc
                          ? "For " +
                            (draft.funding.usdc || "this USDC amount") +
                            " USDC, choose WETH: " +
                            describeFundingRange(
                              fundingGuidance.wethForUsdc,
                              "WETH",
                              18,
                            ) +
                            "."
                          : "Enter a positive USDC amount to see the allowed WETH range."}
                    </span>
                    {token === "usdc" ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(["minimum", "maximum"] as const).map((edge) => {
                          const amount = fundingRangeAmount(
                            fundingGuidance.usdcForWeth,
                            edge,
                            6,
                          );
                          return (
                            <button
                              key={edge}
                              type="button"
                              disabled={amount === null}
                              onClick={() =>
                                amount !== null &&
                                setFundingAmount("usdc", amount)
                              }
                              className="rounded-md border border-cyan-800 px-2.5 py-1.5 text-xs font-medium text-cyan-200 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              Set USDC to {edge}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(["minimum", "maximum"] as const).map((edge) => {
                          const amount = fundingRangeAmount(
                            fundingGuidance.wethForUsdc,
                            edge,
                            18,
                          );
                          return (
                            <button
                              key={edge}
                              type="button"
                              disabled={amount === null}
                              onClick={() =>
                                amount !== null &&
                                setFundingAmount("weth", amount)
                              }
                              className="rounded-md border border-cyan-800 px-2.5 py-1.5 text-xs font-medium text-cyan-200 disabled:cursor-not-allowed disabled:opacity-35"
                            >
                              Set WETH to {edge}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
            {fundingError && (
              <p className="text-xs font-medium text-amber-200">
                {fundingError}
              </p>
            )}
            <p className="text-xs text-slate-500">
              ETH balance for fees:{" "}
              {walletBalances
                ? `${formatTokenAmount(walletBalances.native, 18)} ETH`
                : "connect your wallet to read your ETH balance"}
            </p>
            <label className="block text-sm text-slate-300">
              Maximum trade size
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
                  ? "Choose a value between 1 and 1,000,000,000"
                  : "Choose a value between 1,000 and 1,000,000,000"}{" "}
                . Fees are paid by your wallet.
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
                ? "Ready for approval"
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
                <dt className="text-slate-500">Network</dt>
                <dd className="mt-1 text-white">Ethereum Sepolia</dd>
              </div>
              <div>
                <dt className="text-slate-500">Assets</dt>
                <dd className="mt-1 text-white">
                  {draft.assets
                    .map((asset) => displayAssetSymbol(asset.symbol))
                    .join(", ")}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Trade limit</dt>
                <dd className="mt-1 text-white">
                  {draft.maximumTransactionValue}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Starting balance</dt>
                <dd className="mt-1 text-white">
                  {draft.funding.usdc} USDC + {draft.funding.weth} WETH
                </dd>
              </div>
            </dl>
            {setupDetails && (
              <p className="text-sm leading-6 text-amber-200">{setupDetails}</p>
            )}
            <p className="text-sm leading-6 text-slate-400">
              {appMode === "testnet"
                ? setupState === "submitted"
                  ? "Your wallet request is waiting for confirmation. Check again before trying another request."
                  : setupState === "confirmation-unavailable"
                    ? "The network could not confirm the request. Check again first; retry is offered only after it is safe."
                    : "Review the amounts above and approve the wallet requests. Your Space becomes tradable only after the network confirms setup."
                : "Review the details and approve the wallet request. A rejected request leaves the previous settings unchanged."}
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
              disabled={
                busy ||
                (step === 3 && Boolean(allocationError)) ||
                (step === 4 && Boolean(fundingError))
              }
              onClick={nextStep}
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
                    Retry setup
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
                      saved?.identity.state === "PAUSED" ||
                      saved?.identity.state === "STRATEGY_MISMATCH"
                      ? "Apply rules"
                      : "Create Space"
                    : existing?.identity.state === "ACTIVE" ||
                        existing?.identity.state === "REACTIVATION_REQUIRED" ||
                        existing?.identity.state === "PAUSED" ||
                        existing?.identity.state === "STRATEGY_MISMATCH"
                      ? "Save changes"
                      : "Create Space"}
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
          "Connect the wallet that created this Space before changing its rules.",
        );
      if (appMode === "testnet") {
        const next = await activateTestnetSpace(
          space.identity.id,
          wallet.address,
          wallet.provider,
          (progress) => setMessage(setupProgressLabel(progress)),
          operation,
        );
        onChanged?.(next);
        setMessage(
          operation === "PAUSE"
            ? "Trading paused."
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
          Pause or resume trading with approval from the wallet that created
          this Space.
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
            space.identity.state !== "PAUSED" &&
            space.identity.state !== "STRATEGY_MISMATCH")
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
          Connect the wallet that created this Space to use this control.
        </p>
      )}
    </div>
  );
}

export function SpaceRecoveryControls({
  space,
  onChanged,
  onDeleted,
}: {
  readonly space: SpaceRecord;
  readonly onChanged?: () => void;
  readonly onDeleted?: () => void;
}) {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const isOwner =
    wallet.address?.toLowerCase() === space.identity.ownerAddress.toLowerCase();
  const isSeededSpace = space.identity.id === "aurka-sepolia-space-v1";

  function recoveryError(requestError: unknown): string {
    if (requestError instanceof Error && requestError.message.trim())
      return requestError.message;
    return userFacingError(
      requestError,
      "The Space assets could not be recovered. Try again.",
    );
  }

  async function recover(deleteAfterRecovery: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (!wallet.address || !wallet.provider || wallet.status !== "connected")
        throw new Error(
          "Connect the Space owner wallet on Ethereum Sepolia before recovering assets.",
        );
      const next = await recoverTestnetSpace(
        space.identity.id,
        wallet.address,
        wallet.provider,
        setMessage,
      );
      setRecovery(next);
      if (deleteAfterRecovery) {
        setMessage("Assets recovered. Removing the local Space record…");
        await deleteTestnetSpace(space.identity.id, wallet.address);
        invalidateSpaceCache(space.identity.id);
        onDeleted?.();
        return;
      }
      onChanged?.();
      setMessage(
        next.hasVault
          ? "Recovery complete. Any USDC and WETH were sent to the owner wallet."
          : "This Space has no deployed vault to recover.",
      );
    } catch (requestError) {
      setError(recoveryError(requestError));
    } finally {
      setBusy(false);
    }
  }

  function requestDelete() {
    void recover(true);
  }

  return (
    <div className="space-y-3 rounded-xl border border-amber-900/70 bg-amber-950/20 p-4">
      <div>
        <h3 className="font-medium text-white">
          {isSeededSpace ? "Recover assets" : "Recover or delete Space"}
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-300">
          This pauses trading, closes the Aqua strategy, and withdraws the Space
          vault&apos;s USDC and WETH to the owner wallet.
          {!isSeededSpace &&
            " Deleting removes only the local app record; deployed contracts remain on Sepolia."}
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
      {recovery && (
        <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
          {(["USDC", "WETH"] as const).map((symbol) => (
            <p key={symbol}>
              {symbol} remaining in vault:{" "}
              {formatTokenAmount(
                BigInt(recovery.vaultBalances[symbol] ?? "0"),
                symbol === "USDC" ? 6 : 18,
              )}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={
            !isOwner ||
            wallet.status !== "connected" ||
            !wallet.provider ||
            busy
          }
          onClick={() => void recover(false)}
          className="rounded-lg bg-cyan-700 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? "Waiting for wallet…" : "Withdraw all assets"}
        </button>
        {!isSeededSpace && (
          <button
            type="button"
            disabled={
              !isOwner ||
              wallet.status !== "connected" ||
              !wallet.provider ||
              busy
            }
            onClick={requestDelete}
            className="rounded-lg border border-red-800 px-4 py-2.5 text-sm font-medium text-red-200 disabled:opacity-40"
          >
            Recover assets &amp; delete Space
          </button>
        )}
      </div>
      {!isOwner && (
        <p className="text-xs text-amber-300">
          Connect the wallet that created this Space to recover its assets.
        </p>
      )}
    </div>
  );
}
