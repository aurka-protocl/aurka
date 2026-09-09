/* global console, process, window, URL, fetch, localStorage */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const dir = path.resolve(process.env.AURKA_FORK_DIR ?? ".fork-space");
const manifest = JSON.parse(
  readFileSync(path.join(dir, "manifest.json"), "utf8"),
);
const output = path.join(dir, "evidence");
mkdirSync(output, { recursive: true });
const chain = defineChain({
  id: 31337,
  name: "MVP-002 test fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [manifest.rpcUrl] } },
});
const rpc = createPublicClient({ chain, transport: http(manifest.rpcUrl) });
const accounts = [0, 1].map((addressIndex) =>
  mnemonicToAccount(
    "test test test test test test test test test test test junk",
    { addressIndex },
  ),
);
const transactions = [];
const browser = await chromium.launch({ headless: true });
const origin = new URL(manifest.appUrl).origin;
async function pageFor(index, width) {
  const wallet = createWalletClient({
    account: accounts[index],
    chain,
    transport: http(manifest.rpcUrl),
  });
  const context = await browser.newContext({
    viewport: { width, height: 960 },
  });
  let rejectNext = false;
  await context.exposeBinding("walletRequest", async (_, request) => {
    if (request.method === "test_rejectNext") {
      rejectNext = true;
      return null;
    }
    if (rejectNext && request.method === "eth_sendTransaction") {
      rejectNext = false;
      throw new Error("User rejected the request (4001)");
    }
    if (["eth_accounts", "eth_requestAccounts"].includes(request.method))
      return [accounts[index].address];
    if (request.method === "eth_chainId") return "0x7a69";
    if (request.method === "eth_signTypedData_v4") {
      const typed = JSON.parse(request.params[1]);
      assert.equal(typed.domain.chainId, 31337);
      assert(
        [
          manifest.router.toLowerCase(),
          "0x0000000000000000000000000000000000000001",
        ].includes(typed.domain.verifyingContract.toLowerCase()),
      );
      return wallet.signTypedData(typed);
    }
    if (request.method === "eth_sendTransaction") {
      const tx = request.params[0];
      assert.equal(
        tx.from.toLowerCase(),
        accounts[index].address.toLowerCase(),
      );
      const hash = await wallet.sendTransaction({
        to: tx.to,
        data: tx.data,
        value: BigInt(tx.value ?? 0),
      });
      transactions.push({ owner: accounts[index].address, hash, to: tx.to });
      return hash;
    }
    if (["eth_getTransactionReceipt", "eth_call"].includes(request.method))
      return rpc.request(request);
    throw new Error(`Unsupported test wallet method: ${request.method}`);
  });
  await context.addInitScript(() => {
    window.ethereum = {
      request: (request) => window.walletRequest(request),
      on: () => {},
      removeListener: () => {},
    };
  });
  const page = await context.newPage();
  await page.goto(`${origin}/spaces`);
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await page.getByText(/Connected ·/).waitFor({ state: "attached" });
  return page;
}
async function api(route) {
  const response = await fetch(`${manifest.apiUrl}${route}`);
  const body = await response.json();
  assert(response.ok, JSON.stringify(body));
  return body.data ?? body;
}
async function nextToReview(page) {
  for (let i = 0; i < 4; i++)
    await page.getByRole("button", { name: "Next", exact: true }).click();
}
async function waitFor(page, predicate, label, attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    const alerts = await page.getByRole("alert").allTextContents();
    if (alerts.length) throw new Error(`${label}: ${alerts.join(" ")}`);
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `Timed out: ${label}\n${await page.locator("body").innerText()}`,
  );
}
try {
  const owner = await pageFor(0, 1280);
  const trader = await pageFor(1, 390);
  const ids = process.env.AURKA_SPACE_IDS?.split(",") ?? [];
  for (const suffix of ids.length ? [] : ["one", "two"]) {
    console.log(`Creating ${suffix}`);
    await owner.goto(`${origin}/spaces/new`);
    await owner.getByLabel("Space name").fill(`MVP-002 ${suffix}`);
    await nextToReview(owner);
    await owner
      .getByRole("button", { name: "Save draft", exact: true })
      .click();
    await owner.waitForURL(/\/settings$/);
    const id = decodeURIComponent(new URL(owner.url()).pathname.split("/")[2]);
    ids.push(id);
    assert.equal(
      (await api(`/v1/spaces/${encodeURIComponent(id)}`)).identity.state,
      "DRAFT",
    );
    await owner.reload();
    await nextToReview(owner);
    if (suffix === "one") {
      await owner.evaluate(() =>
        window.ethereum.request({ method: "test_rejectNext" }),
      );
      await owner
        .getByRole("button", {
          name: "Deploy / continue activation",
          exact: true,
        })
        .click();
      await owner
        .getByRole("alert")
        .filter({ hasText: "User rejected" })
        .waitFor();
      assert.equal(
        (await api(`/v1/spaces/${encodeURIComponent(id)}`)).identity.state,
        "DRAFT",
      );
      await owner.reload();
      await nextToReview(owner);
    }
    await owner
      .getByRole("button", {
        name: "Deploy / continue activation",
        exact: true,
      })
      .click();
    if (suffix === "one") {
      await owner.waitForFunction(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith("aurka:space-setup:") &&
            JSON.parse(localStorage.getItem(key)).step === 0,
        ),
      );
      await owner.reload();
      await nextToReview(owner);
      await owner
        .getByRole("button", {
          name: "Deploy / continue activation",
          exact: true,
        })
        .click();
    }
    await waitFor(
      owner,
      async () =>
        (await api(`/v1/spaces/${encodeURIComponent(id)}`)).identity.state ===
        "ACTIVE",
      "activation",
      180,
    );
    await owner.reload();
    await owner
      .getByRole("button", { name: "Save transaction limit", exact: true })
      .waitFor();
    await owner.screenshot({
      path: path.join(output, `mvp002-${suffix}-active.png`),
      fullPage: true,
    });
    console.log(`Activated ${id}`);
  }
  const spaces = await Promise.all(
    ids.map((id) => api(`/v1/spaces/${encodeURIComponent(id)}`)),
  );
  assert.notEqual(
    spaces[0].identity.treasuryAddress,
    spaces[1].identity.treasuryAddress,
  );
  assert.notEqual(spaces[0].identity.strategyId, spaces[1].identity.strategyId);
  if (!process.env.AURKA_SPACE_IDS)
    assert.equal(
      spaces[0].position.currentPortfolio.assets[0].balance,
      spaces[1].position.currentPortfolio.assets[0].balance,
    );
  for (const [index, id] of ids.entries()) {
    const otherId = ids[1 - index];
    const beforeOther = (await api(`/v1/spaces/${encodeURIComponent(otherId)}`))
      .position.currentPortfolio;
    const chainState = await api(`/fork?spaceId=${encodeURIComponent(id)}`);
    if (BigInt(chainState.capacity.consumed) > 0n) {
      console.log(
        `Previously confirmed trade for ${id}; verifying durable receipt-backed state`,
      );
      continue;
    }
    await trader.goto(`${origin}/trade/${encodeURIComponent(id)}`);
    await trader
      .getByRole("button", { name: "Get quote", exact: true })
      .click();
    await waitFor(
      trader,
      async () =>
        (await trader.getByRole("status").allTextContents()).some((t) =>
          t.includes("Quote ready"),
        ),
      "quote",
    );
    await trader
      .getByRole("button", { name: "Review and sign exact trade", exact: true })
      .click();
    await waitFor(
      trader,
      async () =>
        (await trader.getByRole("status").allTextContents()).some((t) =>
          t.includes("Prepared"),
        ),
      "trade preparation",
    );
    await trader
      .getByRole("button", { name: "Submit exact trade", exact: true })
      .click();
    await waitFor(
      trader,
      async () =>
        (await trader.getByRole("status").allTextContents()).some(
          (t) =>
            t.includes("Trade confirmed") ||
            t.includes("Saved transaction confirmed"),
        ),
      "trade receipt",
    );
    const afterOther = (await api(`/v1/spaces/${encodeURIComponent(otherId)}`))
      .position.currentPortfolio;
    assert.deepEqual(
      afterOther.assets.map((a) => a.balance),
      beforeOther.assets.map((a) => a.balance),
      "Other Space balances changed",
    );
    await trader.screenshot({
      path: path.join(output, `mvp002-${index}-trade-mobile.png`),
      fullPage: true,
    });
    console.log(`Traded ${id}; other treasury unchanged`);
  }
  await owner.goto(`${origin}/spaces/${encodeURIComponent(ids[0])}/settings`);
  await owner
    .getByRole("button", { name: "Pause trading", exact: true })
    .click();
  await waitFor(
    owner,
    async () =>
      (await api(`/v1/spaces/${encodeURIComponent(ids[0])}`)).identity.state ===
      "PAUSED",
    "pause",
  );
  assert.equal(
    (await api(`/v1/spaces/${encodeURIComponent(ids[1])}`)).identity.state,
    "ACTIVE",
  );
  await owner
    .getByRole("button", { name: "Resume trading", exact: true })
    .click();
  await waitFor(
    owner,
    async () =>
      (await api(`/v1/spaces/${encodeURIComponent(ids[0])}`)).identity.state ===
      "ACTIVE",
    "resume",
  );
  await owner.getByRole("textbox").fill("2500");
  await owner
    .getByRole("button", { name: "Save transaction limit", exact: true })
    .click();
  await waitFor(
    owner,
    async () =>
      (await api(`/v1/spaces/${encodeURIComponent(ids[0])}`)).position.policy
        .maximumTransactionValue === "2500",
    "rule update",
  );
  assert.equal(
    (await api(`/fork?spaceId=${encodeURIComponent(ids[0])}`)).capacity
      .authorized,
    false,
  );
  assert.equal(
    (await api(`/v1/spaces/${encodeURIComponent(ids[1])}`)).position.policy
      .maximumTransactionValue,
    "5000",
  );
  const changes = await api(`/v1/spaces/${encodeURIComponent(ids[0])}/changes`);
  assert(
    changes.some(
      (c) =>
        c.eventType === "SPACE_PAUSED" &&
        c.receiptHash &&
        c.status === "CONFIRMED",
    ),
  );
  assert(
    changes.some(
      (c) =>
        c.eventType === "SPACE_RESUMED" &&
        c.receiptHash &&
        c.status === "CONFIRMED",
    ),
  );
  assert(
    changes.some(
      (c) =>
        c.eventType === "SPACE_UPDATED" &&
        c.receiptHash &&
        c.status === "CONFIRMED",
    ),
  );
  await owner.reload();
  await owner
    .getByRole("button", { name: "Save transaction limit", exact: true })
    .waitFor();
  await owner.screenshot({
    path: path.join(output, "mvp002-owner-settings.png"),
    fullPage: true,
  });
  console.log("Receipt-backed pause, resume, rule update and reload passed");
  writeFileSync(
    path.join(output, "mvp002-wallet.json"),
    JSON.stringify({ ids, spaces, transactions }, null, 2),
  );
  console.log("MVP-002 two-Space wallet flow passed");
} catch (error) {
  for (const [index, context] of browser.contexts().entries()) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({
        path: path.join(output, `mvp002-failure-${index}.png`),
        fullPage: true,
      });
      console.error(await page.locator("body").innerText());
    }
  }
  writeFileSync(
    path.join(output, "mvp002-transactions.json"),
    JSON.stringify(transactions, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
