/* global console, window */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

// A dedicated EIP-1193 test wallet, injected into Chromium. It signs EIP-712
// and broadcasts actual transactions; it never uses an unsigned preview path.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const manifest = JSON.parse(
  readFileSync(path.join(root, ".fork-space/manifest.json"), "utf8"),
);
const output = path.join(root, ".fork-space/evidence");
mkdirSync(output, { recursive: true });
const chain = defineChain({
  id: 31337,
  name: "Test fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
});
const publicClient = createPublicClient({
  chain,
  transport: http(manifest.rpcUrl),
});
const accounts = [0, 1].map((addressIndex) =>
  mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex },
  ),
);
const transactions = [];
const browser = await chromium.launch({ headless: true });
async function pageFor(index, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  const wallet = createWalletClient({
    account: accounts[index],
    chain,
    transport: http(manifest.rpcUrl),
  });
  let rejectNext = false;
  await context.exposeBinding("walletRequest", async (_, request) => {
    if (request.method === "test_rejectNext") {
      rejectNext = true;
      return null;
    }
    if (
      request.method === "eth_accounts" ||
      request.method === "eth_requestAccounts"
    )
      return [accounts[index].address];
    if (request.method === "eth_chainId") return "0x7a69";
    if (
      rejectNext &&
      ["eth_sendTransaction", "eth_signTypedData_v4"].includes(request.method)
    ) {
      rejectNext = false;
      throw new Error("User rejected the request (4001)");
    }
    if (request.method === "eth_signTypedData_v4") {
      assert.equal(
        request.params[0].toLowerCase(),
        accounts[index].address.toLowerCase(),
      );
      const typed = JSON.parse(request.params[1]);
      assert.equal(typed.domain.chainId, 31337);
      assert.equal(
        typed.domain.verifyingContract.toLowerCase(),
        manifest.router.toLowerCase(),
      );
      return wallet.signTypedData(typed);
    }
    if (request.method === "eth_sendTransaction") {
      const transaction = request.params[0];
      assert.equal(
        transaction.from.toLowerCase(),
        accounts[index].address.toLowerCase(),
      );
      const hash = await wallet.sendTransaction({
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.value ?? 0),
      });
      transactions.push({
        role: index === 0 ? "alice" : "bob",
        hash,
        to: transaction.to,
      });
      return hash;
    }
    if (request.method === "eth_call") return publicClient.request(request);
    throw new Error(`Unsupported test wallet request: ${request.method}`);
  });
  await context.addInitScript(() => {
    const listeners = {};
    window.ethereum = {
      request: (request) => window.walletRequest(request),
      on: (event, listener) => {
        (listeners[event] ??= []).push(listener);
      },
      removeListener: (event, listener) => {
        listeners[event] = (listeners[event] ?? []).filter(
          (item) => item !== listener,
        );
      },
      emit: (event) =>
        (listeners[event] ?? []).forEach((listener) => listener()),
    };
  });
  return context.newPage();
}
async function click(page, label, expected) {
  console.log(`Wallet step: ${label}`);
  await page.getByRole("button", { name: label, exact: true }).click();
  if (expected)
    await page
      .getByRole("status")
      .filter({ hasText: expected })
      .waitFor({ timeout: 60000 });
}
async function state() {
  return (await globalThis.fetch("http://127.0.0.1:8787/fork")).json();
}
try {
  const alice = await pageFor(0, 1280);
  const bob = await pageFor(1, 390);
  await alice.goto("http://127.0.0.1:3001/");
  await bob.goto("http://127.0.0.1:3002/swap");
  await click(alice, "Connect wallet", "Wallet connected");
  await click(bob, "Connect wallet", "Wallet connected");
  await click(alice, "Grant USDC allowance", "allowance: confirmed");
  await click(alice, "Authorize trading capacity", "authorize: confirmed");
  const before = await state();
  await click(bob, "Get quote", "Quote ready");
  await bob.getByText("Partial fill:", { exact: false }).waitFor();
  await bob.getByRole("checkbox").check();
  await bob.evaluate(() =>
    window.ethereum.request({ method: "test_rejectNext" }),
  );
  await click(bob, "Approve and sign", "Failed or rejected");
  await bob.getByRole("alert").filter({ hasText: "User rejected" }).waitFor();
  await click(bob, "Approve and sign", "Prepared");
  await bob.screenshot({
    path: path.join(output, "bob-review-390.png"),
    fullPage: true,
  });
  const review = await bob.locator("section").innerText();
  await click(bob, "Submit trade", "Trade: confirmed");
  const after = await state();
  assert(BigInt(after.balances.bob.weth) < BigInt(before.balances.bob.weth));
  assert(BigInt(after.balances.bob.usdc) > BigInt(before.balances.bob.usdc));
  assert.equal(
    BigInt(before.balances.bob.weth) - BigInt(after.balances.bob.weth),
    BigInt(after.balances.alice.weth) - BigInt(before.balances.alice.weth),
  );
  const usdcDelta = (role) =>
    BigInt(after.balances[role].usdc) - BigInt(before.balances[role].usdc);
  assert.equal(
    usdcDelta("alice") +
      usdcDelta("bob") +
      usdcDelta("solver") +
      usdcDelta("protocol"),
    0n,
  );
  assert.equal(after.capacity.consumed, "5000");
  await alice.reload();
  await bob.reload();
  await click(bob, "Check last local receipt", "Saved transaction confirmed");
  await alice.screenshot({
    path: path.join(output, "alice-after-desktop.png"),
    fullPage: true,
  });
  await bob.screenshot({
    path: path.join(output, "bob-after-390.png"),
    fullPage: true,
  });
  assert(
    await bob.evaluate(
      () => window.document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await click(alice, "Connect wallet", "Wallet connected");
  await click(alice, "Pause trading", "pause: confirmed");
  await click(bob, "Connect wallet", "Wallet connected");
  await click(bob, "Get quote", "Failed or rejected");
  await bob.getByRole("alert").waitFor();
  await bob.evaluate(() => window.ethereum.emit("chainChanged"));
  await bob
    .getByRole("status")
    .filter({ hasText: "network changed" })
    .waitFor();
  const trade = transactions
    .filter(
      (item) =>
        item.to.toLowerCase() === manifest.router.toLowerCase() &&
        item.role === "bob",
    )
    .at(-1);
  const transaction = await publicClient.getTransaction({ hash: trade.hash });
  let rejected = false;
  try {
    await publicClient.call({
      account: manifest.bob,
      to: transaction.to,
      data: transaction.input,
    });
  } catch {
    rejected = true;
  }
  assert(rejected, "Contract must reject replay/paused bypass");
  writeFileSync(
    path.join(output, "wallet-journey.json"),
    JSON.stringify(
      {
        status: "passed",
        wallet:
          "Injected EIP-1193 Chromium test wallet; real EIP-712 signatures and fork transactions",
        transactions,
        before,
        after,
        review,
        checks: [
          "partial fill",
          "wallet rejection",
          "signed simulation",
          "receipt",
          "USDC conservation across all fee recipients",
          "WETH reconciliation",
          "reload",
          "pause",
          "network change invalidation",
          "contract replay/paused rejection",
          "390px overflow",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { status: "passed", transactions, evidence: output },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
