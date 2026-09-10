/* global console, process */

process.env.AURKA_FORK_INTEGRATION = "real";
const { main } = await import("./fork-real-release-e2e.mjs");

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
}
