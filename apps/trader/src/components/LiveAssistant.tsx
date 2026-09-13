import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, LoaderCircle, MessageCircle, Send, X } from "lucide-react";
import { AurkaClient } from "@aurka/sdk";
import {
  formatTokenAmount,
  type AgentProposalResponse,
  type SpaceRecord,
} from "@aurka/shared";
import { Link, useLocation } from "react-router-dom";
import { apiBaseUrl, appMode, supportedChainId } from "../config";
import { spaceAdapter } from "../domain/spaces";
import { displayAssetSymbol, userFacingError } from "../ui";
import { useWallet } from "../wallet";

const client = new AurkaClient({ baseUrl: apiBaseUrl });
const DEMO_TRADER = "0x4444444444444444444444444444444444444444";

type ChatMessage = {
  readonly role: "assistant" | "user";
  readonly text: string;
};

function contextSpaceId(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:spaces|trade)\/([^/]+)/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

function unavailableLabel(
  code: Extract<AgentProposalResponse, { status: "UNAVAILABLE" }>["code"],
): string {
  const labels: Record<typeof code, string> = {
    MISSING_CONFIGURATION: "Temporarily unavailable",
    AUTHENTICATION_REJECTED: "Connection unavailable",
    RATE_LIMITED: "Assistant is busy",
    TIMEOUT: "This is taking longer than expected",
    UNSUPPORTED_CAPABILITY: "Not available for this request",
    PROVIDER_OUTAGE: "Temporarily unavailable",
    MALFORMED_RESPONSE: "Please try again",
    NETWORK_ERROR: "Connection unavailable",
    CONCURRENCY_LIMIT: "Another request is in progress",
    TOOL_BUDGET_EXHAUSTED: "Please make the request shorter",
    DAILY_CAP_EXCEEDED: "Daily assistant budget reached",
  };
  return labels[code];
}

function assistantCopy(value: string): string {
  return value
    .replace(/\bprovider\b/gi, "assistant")
    .replace(/\bservice\b/gi, "app")
    .replace(/\bdelegated\b/gi, "automated")
    .replace(/\bnormalized settlement value\b/gi, "value")
    .replace(/\bproposal\b/gi, "swap")
    .replace(/\bsettlement\b/gi, "swap")
    .replace(/\bpolicy\b/gi, "rules")
    .replace(/\bsnapshot\b/gi, "current details");
}

function responseText(card: AgentProposalResponse): string {
  switch (card.status) {
    case "READY":
      return (
        "I found a swap for " +
        card.selectedSpace.name +
        ". Review the details before confirming in your wallet."
      );
    case "READ_ONLY_ANSWER":
      return assistantCopy(card.answer);
    case "CLARIFICATION":
      return assistantCopy(card.reason);
    case "UNSUPPORTED_ACTION":
      return assistantCopy(card.reason);
    case "BLOCKED":
      return assistantCopy(card.reason);
    case "UNAVAILABLE":
      return assistantCopy(card.reason);
  }
}

function ResultCard({
  card,
  onAsk,
  onSuggestion,
}: {
  readonly card: AgentProposalResponse;
  readonly onAsk: () => void;
  readonly onSuggestion: (value: string) => void;
}) {
  if (card.status === "CLARIFICATION")
    return (
      <div
        role="status"
        className="space-y-2 rounded-lg border border-violet-800/70 bg-violet-950/40 p-3 text-sm text-violet-100"
      >
        <strong>Let&apos;s narrow that down</strong>
        <p>{card.nextAction}</p>
        {card.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {card.suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestion(suggestion)}
                className="rounded-full border border-violet-700 px-2.5 py-1.5 text-xs text-violet-100 hover:bg-violet-900/60"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    );

  if (card.status === "READ_ONLY_ANSWER")
    return (
      <div
        role="region"
        aria-label="Space rules answer"
        className="space-y-2 rounded-lg border border-cyan-800/70 bg-cyan-950/30 p-3 text-sm text-cyan-100"
      >
        <p className="font-semibold">{card.selectedSpace.name}&apos;s rules</p>
        <p className="leading-5 text-cyan-100/80">
          {assistantCopy(card.answer)}
        </p>
        <Link
          to={
            "/spaces/" + encodeURIComponent(card.selectedSpace.id) + "/settings"
          }
          className="inline-flex rounded-lg border border-cyan-800 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-950/70"
        >
          Review Space settings
        </Link>
      </div>
    );

  if (card.status === "UNSUPPORTED_ACTION")
    return (
      <div className="space-y-2 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-100">
        <strong>Your approval is needed</strong>
        <p>{assistantCopy(card.nextAction)}</p>
        {card.settingsPath && (
          <Link
            to={card.settingsPath}
            className="inline-flex rounded-lg border border-amber-700 px-3 py-2 text-xs hover:bg-amber-950/70"
          >
            Review Space settings
          </Link>
        )}
      </div>
    );

  if (card.status === "UNAVAILABLE")
    return (
      <div
        role="alert"
        className="space-y-2 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3 text-sm text-amber-200"
      >
        <strong>{unavailableLabel(card.code)}</strong>
        <p>{assistantCopy(card.reason)}</p>
        {card.retryable && (
          <button
            type="button"
            onClick={onAsk}
            className="rounded-lg border border-amber-700 px-3 py-2 text-xs hover:bg-amber-950/70"
          >
            Try again
          </button>
        )}
      </div>
    );

  if (card.status === "BLOCKED")
    return (
      <div className="rounded-lg border border-red-800/70 bg-red-950/30 p-3 text-sm text-red-200">
        <strong>Swap unavailable</strong>
        {card.nextAction && (
          <p className="mt-1">{assistantCopy(card.nextAction)}</p>
        )}
      </div>
    );

  const input = card.quote.currentPortfolio.assets.find(
    (asset) =>
      asset.token.toLowerCase() === card.quote.traderInputToken.toLowerCase(),
  );
  const output = card.quote.currentPortfolio.assets.find(
    (asset) =>
      asset.token.toLowerCase() === card.quote.traderOutputToken.toLowerCase(),
  );
  return (
    <div className="space-y-3 rounded-lg border border-violet-800/70 bg-slate-950/70 p-3 text-sm text-slate-200">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-violet-100">
            {card.selectedSpace.name}
          </p>
          <p className="text-xs text-slate-500">Review before confirming</p>
        </div>
        <span className="rounded-full bg-emerald-950 px-2 py-1 text-[11px] text-emerald-200">
          {card.simulation.status === "SUCCEEDED" ? "Ready" : "Needs review"}
        </span>
      </div>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Pay</dt>
          <dd>
            {formatTokenAmount(
              card.proposal.traderInputAmount,
              input?.decimals ?? 0,
            )}{" "}
            {displayAssetSymbol(input?.symbol ?? "token")}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Receive</dt>
          <dd>
            {formatTokenAmount(
              card.proposal.traderOutputAmount,
              output?.decimals ?? 0,
            )}{" "}
            {displayAssetSymbol(output?.symbol ?? "token")}
          </dd>
        </div>
      </dl>
      <p className="leading-5 text-slate-300">
        {assistantCopy(card.explanation)}
      </p>
      <Link
        to={"/trade/" + encodeURIComponent(card.selectedSpace.id)}
        className="inline-flex rounded-lg bg-violet-700 px-3 py-2 text-xs font-medium text-white hover:bg-violet-600"
      >
        Review swap
      </Link>
    </div>
  );
}

export default function LiveAssistant() {
  const wallet = useWallet();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      text: "Hi — I can help you find a swap or understand a Space's trading rules.",
    },
  ]);
  const [card, setCard] = useState<AgentProposalResponse>();
  const [spaces, setSpaces] = useState<SpaceRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController>();
  const lastPrompt = useRef("");
  const requestVersion = useRef(0);

  useEffect(() => {
    let active = true;
    spaceAdapter
      .listSpaces(100)
      .then((next) => {
        if (active) setSpaces(next);
      })
      .catch(() => {
        if (active) setSpaces([]);
      });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  useEffect(
    () => () => {
      requestVersion.current += 1;
      abort.current?.abort();
    },
    [],
  );

  const selectedSpaceId = contextSpaceId(location.pathname);
  const selectedSpace = useMemo(
    () =>
      spaces.find((space) => space.identity.id === selectedSpaceId) ??
      spaces.find((space) => space.identity.state === "ACTIVE"),
    [selectedSpaceId, spaces],
  );

  function cancel() {
    requestVersion.current += 1;
    abort.current?.abort();
    abort.current = undefined;
    setBusy(false);
  }

  async function ask(retryPrompt = "") {
    const value = (retryPrompt || prompt).trim();
    if (!value || busy) return;
    cancel();
    const version = requestVersion.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError(null);
    setCard(undefined);
    lastPrompt.current = value;
    setMessages((current) => [...current, { role: "user", text: value }]);
    setPrompt("");
    try {
      const result = await client.agentPropose(
        {
          message: value,
          trader: wallet.address ?? DEMO_TRADER,
          chainId: selectedSpace?.position?.chainId ?? supportedChainId,
          ...(selectedSpace ? { spaceId: selectedSpace.identity.id } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted || version !== requestVersion.current)
        return;
      setCard(result);
      setMessages((current) => [
        ...current,
        { role: "assistant", text: responseText(result) },
      ]);
      setOpen(true);
    } catch (requestError) {
      if (!controller.signal.aborted && version === requestVersion.current)
        setError(
          userFacingError(
            requestError,
            "The assistant could not answer right now.",
          ),
        );
    } finally {
      if (version === requestVersion.current) {
        abort.current = undefined;
        setBusy(false);
      }
    }
  }

  const examples = [
    "Which Spaces are available?",
    "What are this Space's limits?",
    "Find a small WETH → USDC swap",
  ];

  return (
    <div className="fixed bottom-4 right-4 z-50 sm:bottom-6 sm:right-6">
      {open && (
        <section
          aria-label="AURKA live assistant"
          className="mb-3 flex h-[min(36rem,calc(100vh-7rem))] w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-violet-800/80 bg-slate-950 shadow-2xl shadow-black/50"
        >
          <header className="flex items-center justify-between border-b border-violet-900/70 bg-violet-950/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-violet-300" aria-hidden="true" />
              <div>
                <p className="font-semibold text-white">AURKA assistant</p>
                <p className="text-[11px] text-violet-200/70">
                  {selectedSpace
                    ? "Viewing " + selectedSpace.identity.name
                    : "Ask about swaps or Spaces"}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1.5 text-violet-200 hover:bg-violet-900/60"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {messages.map((message, index) => (
              <div
                key={message.role + "-" + index}
                className={
                  message.role === "user"
                    ? "ml-auto max-w-[92%] rounded-xl bg-violet-700 px-3 py-2 text-sm leading-5 text-white"
                    : "max-w-[92%] rounded-xl bg-slate-900 px-3 py-2 text-sm leading-5 text-slate-200"
                }
              >
                {message.text}
              </div>
            ))}
            {card && (
              <ResultCard
                card={card}
                onAsk={() => void ask(lastPrompt.current)}
                onSuggestion={(value) => setPrompt(value)}
              />
            )}
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200"
              >
                {error}
              </p>
            )}
          </div>

          <div className="border-t border-slate-800 p-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:border-violet-600 hover:text-violet-200"
                >
                  {example}
                </button>
              ))}
            </div>
            {appMode === "testnet" && !wallet.address && (
              <p className="mb-2 text-[11px] text-amber-200/80">
                You can ask questions without a wallet. Connect one before
                confirming a swap.
              </p>
            )}
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) cancel();
                else void ask();
              }}
            >
              <textarea
                aria-label="Ask the AURKA assistant"
                placeholder="Ask about swaps or Spaces…"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={2}
                maxLength={1_000}
                className="min-h-11 min-w-0 flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-sm text-slate-100 outline-none focus:border-violet-500"
              />
              <button
                type="submit"
                aria-label={
                  busy ? "Cancel assistant request" : "Send assistant request"
                }
                disabled={!busy && !prompt.trim()}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-violet-700 text-white hover:bg-violet-600 disabled:opacity-40"
              >
                {busy ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </form>
          </div>
        </section>
      )}
      <button
        type="button"
        aria-label={open ? "Close AURKA assistant" : "Open AURKA assistant"}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="ml-auto flex items-center gap-2 rounded-full border border-violet-600 bg-violet-700 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-violet-950/40 transition hover:bg-violet-600"
      >
        {open ? (
          <X className="h-4 w-4" aria-hidden="true" />
        ) : (
          <MessageCircle className="h-4 w-4" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">Assistant</span>
      </button>
    </div>
  );
}
