import { Link } from "react-router-dom";
import {
  ArrowRight,
  Building2,
  CircleHelp,
  ListChecks,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import Glossary from "../components/Glossary";
import { appLinks } from "../config";

export default function Dashboard() {
  return (
    <div className="space-y-8">
      <section
        aria-labelledby="trader-welcome-heading"
        className="overflow-hidden rounded-3xl border border-cyan-900/70 bg-gradient-to-br from-cyan-950 via-slate-900 to-slate-900 p-6 sm:p-10"
      >
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">
            AURKA · Trader space
          </p>
          <h1
            id="trader-welcome-heading"
            className="mt-4 text-3xl font-semibold tracking-tight text-white sm:text-5xl"
          >
            Exchange assets with a treasury’s liquidity.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
            AURKA connects traders with assets an organization has offered for
            exchange. You request a swap; the treasury’s portfolio rules
            determine how much can be filled and what fee applies.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-cyan-100">
            <span className="rounded-full border border-cyan-700/70 bg-cyan-950/70 px-3 py-1.5">
              Local demo
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1.5">
              No wallet connected
            </span>
          </div>
        </div>
      </section>

      <section aria-labelledby="trader-start-heading">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2
              id="trader-start-heading"
              className="text-2xl font-semibold text-white"
            >
              Where would you like to start?
            </h2>
            <p className="mt-2 text-slate-400">
              No address, position ID, or transaction hash is needed for the
              guided demo.
            </p>
          </div>
          <CircleHelp
            className="hidden h-6 w-6 text-slate-600 sm:block"
            aria-hidden="true"
          />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <a
            href={appLinks.treasury}
            className="group rounded-2xl border border-slate-700 bg-slate-900 p-5 transition hover:-translate-y-0.5 hover:border-cyan-700 hover:bg-slate-800 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <Building2 className="h-7 w-7 text-cyan-300" aria-hidden="true" />
              <ArrowRight
                className="h-5 w-5 text-slate-600 transition group-hover:translate-x-1 group-hover:text-cyan-300"
                aria-hidden="true"
              />
            </div>
            <h3 className="mt-5 text-xl font-semibold text-white">
              Explore a demo treasury
            </h3>
            <p className="mt-2 leading-7 text-slate-400">
              See whose example assets are shown, which holdings are available,
              and the rules that shape a permitted swap.
            </p>
          </a>
          <Link
            to="/swap"
            className="group rounded-2xl border border-cyan-700 bg-cyan-950/50 p-5 transition hover:-translate-y-0.5 hover:border-cyan-400 hover:bg-cyan-950 sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <WalletCards
                className="h-7 w-7 text-cyan-300"
                aria-hidden="true"
              />
              <ArrowRight
                className="h-5 w-5 text-slate-500 transition group-hover:translate-x-1 group-hover:text-cyan-200"
                aria-hidden="true"
              />
            </div>
            <h3 className="mt-5 text-xl font-semibold text-white">
              Try a swap
            </h3>
            <p className="mt-2 leading-7 text-slate-300">
              Start with the configured local demo source. The first result is a
              quote for review, not a completed trade.
            </p>
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="journey-heading"
        className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 sm:p-6"
      >
        <div className="flex items-start gap-3">
          <ListChecks
            className="mt-1 h-5 w-5 shrink-0 text-cyan-300"
            aria-hidden="true"
          />
          <div>
            <h2
              id="journey-heading"
              className="text-lg font-semibold text-white"
            >
              How a swap is shaped
            </h2>
            <ol className="mt-4 grid gap-4 text-sm leading-6 text-slate-400 sm:grid-cols-2">
              <li>
                <span className="font-medium text-slate-200">1. Holdings</span>{" "}
                — an organization makes selected assets available.
              </li>
              <li>
                <span className="font-medium text-slate-200">2. Rules</span> —
                portfolio ranges and limits define what is permitted.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  3. Permitted swap
                </span>{" "}
                — AURKA checks the requested exchange against those rules.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  4. Fee &amp; review
                </span>{" "}
                — the quote shows the amount and fee before authorization.
              </li>
              <li>
                <span className="font-medium text-slate-200">
                  5. Resulting holdings
                </span>{" "}
                — a post-trade change is only claimed after an actual
                settlement.
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
          Portfolio rules constrain the treasury’s accepted trades; they do not
          guarantee investment safety, a profit, or protection from market loss.
        </p>
      </div>

      <Glossary />
    </div>
  );
}
