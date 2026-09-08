import { BookOpen } from "lucide-react";

const terms = [
  ["Treasury", "An organization’s assets made available for exchange."],
  ["Holdings", "The asset balances currently shown for that treasury."],
  ["Rule", "A portfolio range or transaction limit the treasury accepts."],
  ["Swap", "An exchange of one asset for another."],
  [
    "Position",
    "The AURKA record that connects one treasury to its holdings and rules.",
  ],
  ["Quote", "A time-limited estimate; it is not a completed trade."],
  [
    "Proposal",
    "A solver’s candidate settlement for a reviewed intent, not a broadcast.",
  ],
  [
    "Execution",
    "A settlement record whose state may be prepared, submitted, or confirmed.",
  ],
] as const;

export default function Glossary() {
  return (
    <section
      aria-labelledby="glossary-heading"
      className="rounded-2xl border border-slate-700 bg-slate-900/70 p-5 sm:p-6"
    >
      <div className="flex items-center gap-3">
        <BookOpen className="h-5 w-5 text-cyan-300" aria-hidden="true" />
        <h2 id="glossary-heading" className="text-lg font-semibold text-white">
          AURKA in plain language
        </h2>
      </div>
      <dl className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {terms.map(([term, definition]) => (
          <div key={term}>
            <dt className="font-medium text-slate-200">{term}</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-400">
              {definition}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
