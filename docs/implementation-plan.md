# AURKA implementation plan

The build follows the dependency order in the product brief. Each phase should
leave the repository installable, runnable, and covered by the relevant tests.

1. **Workspace and schemas (complete):** establish the pnpm monorepo and shared
   runtime contracts for protocol, API, and agent data.
2. **Financial core (complete):** implement deterministic fixed-point portfolio
   valuation, constraint evaluation, OptionSpace fees, and shared test vectors.
3. **Onchain policy core (complete):** add Foundry, policy and risk registries,
   portfolio and fee libraries, authorization, unit tests, fuzz tests, and
   invariants. AURKA-003 review corrections close certificate reactivation,
   pending-signature rebinding, hard-policy version races, infeasible aggregate
   bounds, raw/effective risk ambiguity, and zero-limit error semantics.

**3.5. Financial settlement model (complete):** use the trader-centric
`traderInputToken`/`traderOutputToken` convention, bounded fee-inclusive
accounting, integrated price protection, and a hashed persistent capacity epoch
as recorded in AURKA-004. The canonical direct fill is 50,000 gross for a
200,000 request; the treasury post-state is computed including fee revenue.

4. **Atomic settlement (AURKA-005, complete):** the direct pairwise router
   verifies signed intent/proposal commitments, effective policy/risk state,
   approved price snapshots, directional capacity epochs, exact Aqua token
   deltas, fees, and the fee-inclusive final portfolio atomically. The local
   `AURKA_DIRECT_PAIR_V1` program is an allowlisted deterministic equivalent;
   live upstream integration remains separately gated. Multi-route optimization
   and application integrations do not belong to this milestone.
5. **Solvers and services (AURKA-006, local milestone complete):** implement the
   deterministic direct solver, closed optimized-solver boundary, validated
   `/v1` API, SQLite/Drizzle persistence, monitoring, and idempotent/reorg-aware
   indexing. Live RPC, production signing, and external integrations remain
   separately gated.
6. **Risk and wallet integrations:** add Graph-backed watchtower signals and the
   Privy wallet adapter behind narrow, testable interfaces.
7. **SDK and application:** expose discovery, quotes, proposals, risk, and
   execution through the SDK and build the treasury/trader interfaces.
8. **System verification:** complete integration and end-to-end coverage,
   containers, CI workflows, deployment scripts, and operational documentation.

External integration phases begin with a fresh review of the corresponding
official APIs and repositories. Live tests stay isolated from deterministic CI
and require explicit credentials.
