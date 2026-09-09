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
const appUrl = manifest.appUrl ?? "http://127.0.0.1:3011/spaces";
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
  let walletChain = "0x7a69";
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
    if (request.method === "test_wrongChain") {
      walletChain = "0x1";
      return null;
    }
    if (request.method === "eth_chainId") return walletChain;
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
  const page = await context.newPage();
  page.on("response", async (response) => {
    if (response.status() >= 400 && response.url().includes("/api/"))
      console.log(`API failure: ${await response.text()}`);
  });
  return page;
}
async function click(page, label, expected) {
  console.log(`Wallet step: ${label}`);
  await page.getByRole("button", { name: label, exact: true }).click();
  if (expected) {
    try {
      await page
        .getByRole("status")
        .filter({ hasText: expected })
        .waitFor({ timeout: 45000 });
    } catch (error) {
      await page.screenshot({
        path: path.join(output, "failure.png"),
        fullPage: true,
      });
      throw new Error(`${label}: ${await page.locator("body").innerText()}`, {
        cause: error,
      });
    }
  }
}
async function state() {
  return (await globalThis.fetch("http://127.0.0.1:8797/fork")).json();
}
try {
  const alice = await pageFor(0, 1280);
  const bob = await pageFor(1, 390);
  const initial = await state();
  const spaceId = encodeURIComponent(initial.position.id);
  await alice.goto(
    `${appUrl.replace(/\/spaces\/?$/, "")}/spaces/${spaceId}/settings`,
  );
  await bob.goto(`${appUrl.replace(/\/spaces\/?$/, "")}/trade/${spaceId}`);
  await click(alice, "Connect wallet", "Wallet connected");
  await click(bob, "Connect wallet", "Wallet connected");
  await click(alice, "Grant USDC allowance", "allowance: confirmed");
  if (!(await state()).capacity.authorized)
    await click(alice, "Authorize trading capacity", "authorize: confirmed");
  const before = await state();
  await click(bob, "Get quote", "Quote ready");
  await bob.getByText("Partial fill:", { exact: false }).waitFor();
  await bob.evaluate(() =>
    window.ethereum.request({ method: "test_rejectNext" }),
  );
  await click(
    bob,
    "Review and sign exact trade",
    "Signing or preparation failed",
  );
  await bob.getByRole("alert").filter({ hasText: "User rejected" }).waitFor();
  await click(bob, "Review and sign exact trade", "Prepared");
  await bob.screenshot({
    path: path.join(output, "bob-review-390.png"),
    fullPage: true,
  });
  const review = await bob.locator("section").innerText();
  await click(bob, "Submit exact trade", "Saved transaction confirmed");
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
  await click(bob, "Connect wallet", "Wallet connected");
  await alice.getByRole("textbox").fill("1000");
  await click(alice, "Save transaction limit", "limit: confirmed");
  await click(alice, "Authorize trading capacity", "authorize: confirmed");
  async function prepareFresh() {
    await click(bob, "Get quote", "Quote ready");
    const response = bob.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/execute") && response.status() === 202,
    );
    await click(bob, "Review and sign exact trade", "Prepared");
    return (await (await response).json()).data.transactionRequest;
  }
  async function assertRevert(transaction, label) {
    let rejected = false;
    try {
      await publicClient.call({
        account: manifest.bob,
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.value ?? 0),
      });
    } catch {
      rejected = true;
    }
    assert(rejected, `${label} must fail at the contract boundary`);
  }
  const readyBeforePause = await prepareFresh();
  await alice.getByRole("textbox").fill("500");
  await click(alice, "Save transaction limit", "limit: confirmed");
  await assertRevert(
    readyBeforePause,
    "previously signed fill above the lowered policy cap",
  );
  await click(alice, "Pause trading", "pause: confirmed");
  await assertRevert(readyBeforePause, "fresh signed trade while paused");
  await bob
    .getByText("The Space snapshot or policy changed. Request a fresh quote.")
    .waitFor();
  await click(bob, "Get quote", "Quote failed");
  await bob.getByRole("alert").waitFor();
  await click(alice, "Resume trading", "resume: confirmed");
  await click(alice, "Authorize trading capacity", "authorize: confirmed");
  const readyBeforeExpiry = await prepareFresh();
  await assertRevert(
    {
      ...readyBeforeExpiry,
      data:
        readyBeforeExpiry.data.slice(0, -2) +
        (readyBeforeExpiry.data.endsWith("00") ? "01" : "00"),
    },
    "modified signed calldata",
  );
  await publicClient.request({ method: "evm_increaseTime", params: [400] });
  await publicClient.request({ method: "evm_mine", params: [] });
  await assertRevert(readyBeforeExpiry, "expired unused signed trade");
  await bob
    .getByText(
      "The quote expired or source state changed. Request a fresh quote.",
    )
    .waitFor();
  assert.deepEqual(
    (await state()).balances,
    after.balances,
    "Rejected calls changed token balances",
  );
  await bob.evaluate(() => window.ethereum.emit("accountsChanged"));
  await bob
    .getByRole("status")
    .filter({ hasText: "Account or network changed" })
    .waitFor();
  await bob.evaluate(async () => {
    await window.ethereum.request({ method: "test_wrongChain" });
    window.ethereum.emit("chainChanged");
  });
  await bob
    .getByRole("status")
    .filter({ hasText: "network changed" })
    .waitFor();
  await bob.getByText("Your wallet is on chain 1", { exact: false }).waitFor();
  await click(alice, "Pause trading", "pause: confirmed");
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
          "account/network change invalidation and wrong-chain rejection",
          "lowered hard cap rejects previously signed fill",
          "unused signed paused trade rejected",
          "unused signed expired trade rejected",
          "modified signed calldata rejected",
          "policy limit update and reauthorization",
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
