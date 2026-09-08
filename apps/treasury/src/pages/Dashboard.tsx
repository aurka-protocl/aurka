import {
  ArrowRight,
  CircleHelp,
  ListChecks,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { Link } from "react-router-dom";
import Glossary from "../components/Glossary";
import { appLinks } from "../config";

export default function Dashboard() {
  return (
    <div className="space-y-8">
      <section
        aria-labelledby="treasury-welcome-heading"
        className="overflow-hidden rounded-3xl border border-violet-900/70 bg-gradient-to-br from-violet-950 via-slate-900 to-slate-900 p-6 sm:p-10"
      >
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-300">
            AURKA · Treasury space
          </p>
          <h1
            id="treasury-welcome-heading"
            className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            Put your organization’s liquidity to work within clear rules.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
            A treasury is an organization’s asset pool. You choose which
            holdings can be offered for exchange and the portfolio ranges a
            permitted trade must respect. Another person can then request a swap
            against that liquidity.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-violet-100">
            <span className="rounded-full border border-violet-700/70 bg-violet-950/70 px-3 py-1.5">
              Local demo
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5">
              Read-only example
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5">
              No wallet connected
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby="treasury-start-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2
              id="treasury-start-heading"
              className="text-2xl font-semibold text-white"
            >
              Start with the example treasury
            </h2>
            <p className="mt-2 text-slate-400">
              Explore its holdings and rules, or see the same liquidity from a
              trader’s point of view.
            </p>
          </div>
          <CircleHelp
            className="hidden h-6 w-6 text-slate-600 sm:block"
            aria-hidden="true"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Link
            to="/holdings"
            className="group rounded-2xl border border-violet-700 bg-violet-950/50 p-5 transition hover:-translate-y-0.5 hover:border-violet-400 hover:bg-violet-950 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <WalletCards
                className="h-7 w-7 text-violet-300"
                aria-hidden="true"
              />
              <ArrowRight
                className="h-5 w-5 text-slate-500 transition group-hover:translate-x-1 group-hover:text-violet-200"
                aria-hidden="true"
              />
            </div>
            <h3 className="mt-5 text-xl font-semibold text-white">
              Explore a demo treasury
            </h3>
            <p className="mt-2 leading-7 text-slate-300">
              Inspect the configured example holdings and the portfolio rules
              they are expected to follow.
            </p>
          </Link>
          <a
            href={appLinks.trader}
            className="group rounded-2xl border border-slate-700 bg-slate-900 p-5 transition hover:-translate-y-0.5 hover:border-cyan-700 hover:bg-slate-800 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <UserRound className="h-7 w-7 text-cyan-300" aria-hidden="true" />
              <ArrowRight
                className="h-5 w-5 text-slate-600 transition group-hover:translate-x-1 group-hover:text-cyan-300"
                aria-hidden="true"
              />
            </div>
            <h3 className="mt-5 text-xl font-semibold text-white">
              Try a swap
            </h3>
            <p className="mt-2 leading-7 text-slate-400">
              Request a quote against this local source without connecting a
              wallet or broadcasting a transaction.
            </p>
          </a>
        </div>
      </section>

      <section
        aria-labelledby="treasury-journey-heading"
        className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 sm:p-6"
      >
        <div className="flex items-start gap-3">
          <ListChecks
            className="mt-1 h-5 w-5 shrink-0 text-violet-300"
            aria-hidden="true"
          />
          <div>
            <h2
              id="treasury-journey-heading"
              className="text-lg font-semibold text-white"
            >
              The treasury journey
            </h2>
            <ol className="mt-4 grid gap-4 text-sm leading-6 text-slate-400 sm:grid-cols-2">
              <li>
                <span className="font-medium text-slate-200">1. Holdings</span>{" "}
                — identify the assets the organization offers.
              </li>
              <li>
                <span className="font-medium text-slate-200">2. Rules</span> —
                set accepted ranges and transaction limits.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  3. Permitted swap
                </span>{" "}
                — AURKA checks the requested exchange against the rules.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  4. Fee &amp; review
                </span>{" "}
                — the permitted amount and fee are shown before preparation.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  5. Resulting holdings
                </span>{" "}
                — holdings change only after an actual settlement, not from a
                quote.
              </li>
            </ol>
          </div>
        </div>
      </section>

      <div className="flex items-start gap-3 rounded-xl border border-amber-900/60 bg-amber-950/30 p-4 text-sm leading-6 text-amber-100/80">
        <ShieldCheck
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-300"
          aria-hidden="true"
        />
        <p>
          Portfolio rules help constrain accepted trades; they do not guarantee
          investment safety, a profit, or protection from market loss.
        </p>
      </div>

      <Glossary />
    </div>
  );
}
