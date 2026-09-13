import { BookOpen } from "lucide-react";

const terms = [
  ["Portfolio", "A collection of assets with clear trading rules."],
  ["Balance", "The amount of each asset currently available."],
  ["Trading rule", "A range or limit that controls which swaps are accepted."],
  ["Swap", "An exchange of one asset for another."],
  ["Rate", "The current estimated amount you will receive for a swap."],
  ["Confirmation", "The wallet approval that completes a swap."],
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
