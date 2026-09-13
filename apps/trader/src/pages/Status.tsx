import { CircleHelp } from "lucide-react";
import { environmentLabel } from "../config";

export default function Status() {
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          About AURKA
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Simple swaps within clear limits
        </h1>
        <p className="mt-3 max-w-2xl leading-7 text-slate-300">
          AURKA helps portfolios offer liquidity with transparent rules. Review
          what you pay, what you receive, and the fee before confirming a swap.
        </p>
      </div>

      <section className="rounded-2xl border border-cyan-900/70 bg-cyan-950/25 p-5 sm:p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
          {environmentLabel}
        </p>
        <h2 className="mt-2 text-xl font-semibold text-white">
          Ethereum Sepolia
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Connect your wallet on the network shown above to view balances,
          create a Space, and confirm swaps.
        </p>
      </section>

      <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-5 text-sm leading-6 text-slate-400">
        <div className="flex items-start gap-3">
          <CircleHelp
            className="mt-0.5 h-5 w-5 shrink-0 text-slate-500"
            aria-hidden="true"
          />
          <p>
            Connect a wallet only when you are ready to approve an action.
            Viewing Spaces and rates does not request a signature.
          </p>
        </div>
      </div>
    </section>
  );
}
