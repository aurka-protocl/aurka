import { Link } from "react-router-dom";

const linkStyle =
  "font-medium text-cyan-300 underline decoration-cyan-300/40 underline-offset-4 hover:text-cyan-200";

export default function Status() {
  return (
    <section className="mx-auto max-w-3xl space-y-8">
      <div>
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt="AURKA"
            className="h-16 w-16 rounded-full object-contain"
          />
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300">
            About AURKA
          </p>
        </div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Offer tokens for swaps, or trade with a Space
        </h1>
        <p className="mt-3 leading-7 text-slate-300">
          A Space holds a portfolio of tokens in a dedicated vault. You fund it,
          choose the allowed percentage of each asset and set a limit per trade.
          Other users can exchange tokens with your Space. Each swap changes its
          holdings and pays fees, a share of which goes to the Space.
        </p>
      </div>

      <div className="space-y-4 text-sm leading-7 text-slate-300">
        <p>
          For example, you can require USDC to make up at least 55% of your
          Space&apos;s value. Someone buying USDC from the Space can only swap
          the amount its limits permit. If their request is too large, they can
          review a smaller amount or choose another Space.
        </p>
        <p>
          This lets you offer liquidity without approving every swap yourself.
          You define the acceptable changes to your holdings in advance. Market
          price changes can still move your allocation outside those ranges;
          creating a Space does not automatically rebalance it.
        </p>
        <p>
          To trade, choose an available pair and enter an amount. Review what
          you will spend, what you will receive and the fee before confirming in
          your wallet. You can inspect a Space without creating one.
        </p>
        <p>
          For automated trading, create and fund a separate trading wallet.
          Choose a Space, spending budget, minimum rate and expiry, then
          authorize the agent to check and trade within those instructions. Its
          activity shows decisions, transactions and remaining budget. You can
          stop it and recover its tokens to your owner wallet. The assistant can
          help explain a Space or prepare a quote for review.
        </p>
      </div>

      <section
        aria-labelledby="try-aurka"
        className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 sm:p-6"
      >
        <h2 id="try-aurka" className="text-lg font-semibold text-white">
          Try it on Sepolia
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          This version runs on Sepolia with test ETH, mock WETH and mock USDC.
          The application manages the separate agent wallets. Their balances are
          separate from your connected wallet and any Space you own.
        </p>
        <ol className="mt-5 list-decimal space-y-4 pl-5 text-sm leading-6 text-slate-300 marker:text-cyan-300">
          <li>
            Open{" "}
            <Link to="/spaces" className={linkStyle}>
              Spaces
            </Link>{" "}
            and select a Space to inspect its holdings, allocation ranges and
            available trading capacity.
          </li>
          <li>
            In{" "}
            <Link to="/trade" className={linkStyle}>
              Trade
            </Link>
            , connect a Sepolia wallet with test tokens, choose an available
            pair and request a quote. Review the input, output and fee, then
            approve and confirm the swap in your wallet.
          </li>
          <li>
            Open{" "}
            <Link to="/agent" className={linkStyle}>
              Automated trading
            </Link>
            , sign in and create a trading wallet. Add test funds, choose a
            Space, and set the amount, total budget, minimum rate and expiry.
            Review and sign your trading instructions to start.
          </li>
          <li>
            Check the agent activity for decisions and transaction receipts.
            Stop the agent to revoke its trading permission, then recover tokens
            to your connected owner wallet.
          </li>
        </ol>
        <p className="mt-5 text-sm leading-6 text-slate-400">
          To supply liquidity yourself, use{" "}
          <Link to="/spaces/new" className={linkStyle}>
            Create Space
          </Link>{" "}
          to choose funding amounts and allocations, then complete the wallet
          setup transactions.
        </p>
      </section>
    </section>
  );
}
