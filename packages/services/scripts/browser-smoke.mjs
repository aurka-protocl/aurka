/* global AbortSignal, HTMLElement, console, document, fetch, getComputedStyle, innerWidth, process, setTimeout */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

import { chromium } from "playwright";

import { createCanonicalFixture, hashIntent } from "../dist/index.js";

const require = createRequire(import.meta.url);
const { privateKeyToAccount } = require("viem/accounts");

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 2_000;
const PRIVATE_TEST_KEY = `0x${"00".repeat(31)}01`;

function check(condition, message) {
  assert.ok(condition, message);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  check(address && typeof address !== "string", "Could not allocate a port");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function boundedLines() {
  const lines = [];
  return {
    add(chunk) {
      lines.push(...String(chunk).split(/\r?\n/).filter(Boolean));
      if (lines.length > 40) lines.splice(0, lines.length - 40);
    },
    values() {
      return lines.slice();
    },
  };
}

function startProcess(args, environment) {
  const stdout = boundedLines();
  const stderr = boundedLines();
  const child = spawn(process.env.PNPM_BIN ?? "pnpm", args, {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.add(chunk));
  child.stderr.on("data", (chunk) => stderr.add(chunk));
  return { child, stdout, stderr };
}

function startService(servicePort, databaseDirectory) {
  return startProcess(["--filter", "@aurka/services", "start"], {
    HOST: "127.0.0.1",
    PORT: String(servicePort),
    DATABASE_URL: path.join(databaseDirectory, "service.sqlite"),
  });
}

function writeProcessPidFile(file, processes) {
  if (!file) return;
  writeFileSync(
    file,
    processes
      .map((processHandle) => processHandle.child.pid)
      .filter(Boolean)
      .join("\n") + "\n",
  );
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.child.exitCode !== null) return;
  const pid = processHandle.child.pid;
  try {
    if (pid) process.kill(-pid, "SIGTERM");
    else processHandle.child.kill("SIGTERM");
  } catch {
    processHandle.child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => processHandle.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, PROCESS_STOP_TIMEOUT_MS)),
  ]);
  if (processHandle.child.exitCode === null) {
    try {
      if (pid) process.kill(-pid, "SIGKILL");
      else processHandle.child.kill("SIGKILL");
    } catch {
      processHandle.child.kill("SIGKILL");
    }
  }
}

async function waitForHttp(url, label, processHandle) {
  const started = Date.now();
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    if (processHandle?.child.exitCode !== null)
      throw new Error(`${label} exited before startup`);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status < 500) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become reachable in time`);
}

async function apiData(url, options = {}, label = "API request") {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new Error(`${label} returned non-JSON data`);
  }
  check(
    response.ok && envelope?.ok === true,
    `${label} did not return a successful API envelope`,
  );
  return envelope.data;
}

async function visit(page, url, routes, results) {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes) {
      await page.goto(`${url}${route}`, { waitUntil: "domcontentloaded" });
      await page.locator("nav a").first().waitFor();
      const links = page.locator("nav a");
      for (let index = 0; index < (await links.count()); index += 1)
        check(
          await links.nth(index).isVisible(),
          `Navigation link is hidden at ${width}px on ${route}`,
        );
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      check(!overflow, `Horizontal overflow at ${width}px on ${route}`);
      check(
        (await page.locator("h1").count()) === 1,
        `Expected one semantic page heading at ${width}px on ${route}`,
      );
      const unlabeledControls = await page
        .locator("input, select, textarea")
        .evaluateAll((controls) =>
          controls
            .filter(
              (control) =>
                !control.labels?.length && !control.getAttribute("aria-label"),
            )
            .map((control) => control.outerHTML.slice(0, 100)),
        );
      check(
        unlabeledControls.length === 0,
        `Unlabeled form control at ${width}px on ${route}: ${unlabeledControls.join("; ")}`,
      );
      results.push({ route, width, overflow });
    }
  }
}

async function apiPosition(serviceUrl) {
  const data = await apiData(
    `${serviceUrl}/v1/positions`,
    {},
    "Fixture positions",
  );
  const position = data?.items?.[0];
  check(position?.id, "Fixture service returned no position");
  return position;
}

async function apiGuidedQuote(serviceUrl, position) {
  const snapshot = position.currentPortfolio;
  check(snapshot, "Fixture position returned no portfolio snapshot");
  const inputAsset = snapshot.assets.find((asset) => asset.symbol === "WETH");
  const outputAsset = snapshot.assets.find((asset) => asset.symbol === "USDC");
  check(
    inputAsset && outputAsset,
    "Fixture position returned no WETH/USDC pair",
  );
  const intent = await apiData(
    `${serviceUrl}/v1/intents/prepare-token`,
    {
      method: "POST",
      body: JSON.stringify({
        positionId: position.id,
        trader: "0x4444444444444444444444444444444444444444",
        traderInputToken: inputAsset.token,
        traderOutputToken: outputAsset.token,
        requestedTraderInputAmount: "200000",
        minimumTraderOutputValue: "0",
        nonce: "0",
        deadline: Math.floor(Date.now() / 1000) + 300,
      }),
    },
    "Guided intent preparation",
  );
  const quote = await apiData(
    `${serviceUrl}/v1/quote`,
    { method: "POST", body: JSON.stringify({ intent }) },
    "Guided quote",
  );
  const solved = await apiData(
    `${serviceUrl}/v1/solve`,
    { method: "POST", body: JSON.stringify({ intent }) },
    "Guided solve",
  );
  return { intent, quote, solved, inputAsset, outputAsset };
}

function formatUnitsForSmoke(raw, decimals) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

async function assertTouchTarget(locator, label) {
  const box = await locator.boundingBox();
  check(
    box && box.width >= 36 && box.height >= 36,
    `${label} is too small for a practical touch target`,
  );
}

function writeResult(result) {
  const directory = process.env.AURKA_ARTIFACT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "browser-smoke.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

async function main() {
  const databaseDirectory = mkdtempSync(
    path.join(os.tmpdir(), "aurka-browser-smoke-"),
  );
  const servicePort = await freePort();
  const treasuryPort = await freePort();
  const traderPort = await freePort();
  let service = startService(servicePort, databaseDirectory);
  const treasury = startProcess(
    [
      "--filter",
      "@aurka/treasury-app",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(treasuryPort),
    ],
    {
      AURKA_SERVICE_URL: `http://127.0.0.1:${servicePort}`,
      VITE_AURKA_TRADER_URL: `http://127.0.0.1:${traderPort}`,
      VITE_AURKA_TREASURY_URL: `http://127.0.0.1:${treasuryPort}`,
    },
  );
  const trader = startProcess(
    [
      "--filter",
      "@aurka/trader-app",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(traderPort),
    ],
    {
      AURKA_SERVICE_URL: `http://127.0.0.1:${servicePort}`,
      VITE_AURKA_TRADER_URL: `http://127.0.0.1:${traderPort}`,
      VITE_AURKA_TREASURY_URL: `http://127.0.0.1:${treasuryPort}`,
    },
  );
  const processPidFile = process.env.AURKA_BROWSER_PID_FILE;
  writeProcessPidFile(processPidFile, [service, treasury, trader]);
  let browser;
  const result = { status: "passed", routes: [], checks: [] };
  let failure;
  try {
    await waitForHttp(
      `http://127.0.0.1:${servicePort}/health`,
      "Service",
      service,
    );
    await waitForHttp(
      `http://127.0.0.1:${treasuryPort}/`,
      "Treasury application",
      treasury,
    );
    await waitForHttp(
      `http://127.0.0.1:${traderPort}/`,
      "Trader application",
      trader,
    );

    const serviceUrl = `http://127.0.0.1:${servicePort}`;
    const position = await apiPosition(serviceUrl);
    const guided = await apiGuidedQuote(serviceUrl, position);
    const snapshot = position.currentPortfolio;
    const expectedAllocation = snapshot.assets
      .map((asset) => {
        const whole = Math.floor(asset.weightBps / 100);
        const fraction = String(asset.weightBps % 100).padStart(2, "0");
        return `${asset.symbol} ${whole}.${fraction}%`;
      })
      .join(", ");
    const expectedRequested = `${formatUnitsForSmoke(
      guided.quote.requestedTraderInputAmount,
      guided.inputAsset.decimals,
    )} ${guided.inputAsset.symbol}`;
    const expectedExecutable = `${formatUnitsForSmoke(
      guided.solved.proposal.traderInputAmount,
      guided.inputAsset.decimals,
    )} ${guided.inputAsset.symbol}`;
    const expectedReceive = `${formatUnitsForSmoke(
      guided.solved.proposal.traderOutputAmount,
      guided.outputAsset.decimals,
    )} ${guided.outputAsset.symbol}`;
    const expectedFee = `${formatUnitsForSmoke(
      guided.quote.fees.totalFeeAmount,
      guided.quote.currentPortfolio.valueDecimals,
    )} normalized settlement value units`;

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await visit(
      page,
      `http://127.0.0.1:${treasuryPort}`,
      ["/", "/holdings", "/protections", "/activity", "/status"],
      result.routes,
    );
    await visit(
      page,
      `http://127.0.0.1:${traderPort}`,
      [
        "/",
        "/swap",
        "/activity",
        "/status",
        "/portfolio",
        "/history",
        "/trade",
      ],
      result.routes,
    );
    result.checks.push(
      "desktop/mobile/narrow routes, headings, labels, and navigation",
    );

    await page.goto(`http://127.0.0.1:${traderPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "No activity yet" }).waitFor();
    check(
      await page.getByRole("link", { name: "Try a swap" }).isVisible(),
      "Empty trader activity does not offer the swap next step",
    );
    await page.goto(`http://127.0.0.1:${treasuryPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Confirmed treasury fee shares" })
      .waitFor();
    check(
      await page
        .getByText(
          "No confirmed settlement fee evidence is available for this treasury.",
        )
        .isVisible(),
      "Fresh demo did not show the evidence-backed empty fee state",
    );
    result.checks.push("fresh-start empty activity and fee next steps");

    await page.goto(`http://127.0.0.1:${treasuryPort}/holdings`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Available to exchange" })
      .waitFor();
    const treasurySelector = page.getByRole("combobox", {
      name: "Treasury configuration",
    });
    await treasurySelector.selectOption(position.id);
    check(
      (await treasurySelector.inputValue()) === position.id,
      "Treasury source selector did not retain the selected configuration",
    );
    check(
      (await page.getByText(position.name, { exact: true }).count()) > 0,
      "Selected treasury source name is not visible",
    );
    check(
      await page
        .getByText(`${snapshot.nav} value units`, { exact: true })
        .isVisible(),
      "Holdings did not show the server portfolio value",
    );
    check(
      await page
        .getByRole("img", {
          name: `Treasury allocation: ${expectedAllocation}`,
        })
        .isVisible(),
      "Allocation graphic did not expose the server allocation text equivalent",
    );
    for (const asset of snapshot.assets) {
      const row = page
        .locator("table")
        .first()
        .locator("tbody tr")
        .filter({ hasText: asset.symbol });
      check(
        await row.getByText(asset.balance, { exact: true }).isVisible(),
        `${asset.symbol} balance is not visible from the server snapshot`,
      );
    }
    check(
      await page
        .getByText("Per-trade cap", { exact: true })
        .locator("..")
        .getByText(`${position.policy.maximumTransactionValue} value units`, {
          exact: true,
        })
        .isVisible(),
      "Holdings did not show the server per-trade cap",
    );
    const capacitySection = page
      .locator("section")
      .filter({ hasText: "Available to exchange" })
      .last();
    check(
      await capacitySection
        .getByText("Current safe maximum", { exact: true })
        .locator("..")
        .getByText(`${guided.quote.maximumSafeTraderInputAmount} value units`, {
          exact: true,
        })
        .isVisible(),
      "Holdings did not show the server directional safe maximum",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Available to exchange" })
      .waitFor();
    check(
      (await page.getByText(position.name, { exact: true }).count()) > 0,
      "Direct holdings refresh did not restore the selected source",
    );
    result.checks.push(
      "server-backed holdings, allocation text alternative, capacity, source selection, and refresh",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${traderPort}/`, {
      waitUntil: "domcontentloaded",
    });
    check(
      await page
        .getByRole("heading", { name: /Exchange assets with a treasury/ })
        .isVisible(),
      "Trader entry explanation is missing",
    );
    check(
      await page
        .getByRole("link", { name: /Explore a demo treasury/ })
        .isVisible(),
      "Trader demo treasury action is missing",
    );
    check(
      await page.getByRole("link", { name: /^Try a swap/ }).isVisible(),
      "Trader swap action is missing",
    );
    check(
      (await page
        .getByRole("link", { name: "Treasury space" })
        .getAttribute("href")) === `http://127.0.0.1:${treasuryPort}`,
      "Trader role switch does not use configured treasury URL",
    );
    await page.getByRole("link", { name: /^Try a swap/ }).click();
    await page.getByRole("heading", { name: "Try a swap" }).waitFor();
    check(
      await page
        .getByText(`Using ${position.name}`, { exact: false })
        .isVisible(),
      "Guided swap did not identify the selected liquidity source",
    );
    check(
      await page
        .getByText(
          `${guided.inputAsset.symbol} → ${guided.outputAsset.symbol} demo direction`,
          { exact: false },
        )
        .isVisible(),
      "Guided swap did not identify the supported source direction",
    );
    check(
      await page.getByRole("combobox", { name: "You pay token" }).isVisible(),
      "Guided swap entry is missing its input token selector",
    );
    check(
      await page.getByLabel("Amount to pay", { exact: true }).isVisible(),
      "Guided swap entry is missing its human-readable amount input",
    );
    check(
      (await page.getByText("Position ID", { exact: true }).count()) === 0,
      "Guided swap requires a technical position identifier",
    );
    const getQuoteButton = page.getByRole("button", {
      name: "Get quote",
      exact: true,
    });
    await assertTouchTarget(getQuoteButton, "Get quote button");
    const solveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/solve") &&
        response.request().method() === "POST",
    );
    await getQuoteButton.click();
    const solveResponse = await solveResponsePromise;
    const solveEnvelope = await solveResponse.json();
    check(
      solveEnvelope?.ok === true,
      "Guided solve response was not a successful API envelope",
    );
    check(
      solveEnvelope.data?.proposal?.traderInputAmount ===
        guided.solved.proposal.traderInputAmount &&
        solveEnvelope.data?.proposal?.traderOutputAmount ===
          guided.solved.proposal.traderOutputAmount &&
        solveEnvelope.data?.proposal?.totalFeeAmount ===
          guided.solved.proposal.totalFeeAmount,
      "Visible guided quote does not match the server solve response",
    );
    await page
      .getByRole("heading", { name: "Review what would happen" })
      .waitFor();
    check(
      await page.getByText(expectedRequested, { exact: true }).isVisible(),
      "Guided quote does not show the server requested amount",
    );
    check(
      await page.getByText(expectedExecutable, { exact: true }).isVisible(),
      "Guided quote does not show the server executable amount",
    );
    check(
      await page.getByText(expectedReceive, { exact: true }).isVisible(),
      "Guided quote does not show the server expected receive amount",
    );
    check(
      await page.getByText(expectedFee, { exact: true }).isVisible(),
      "Guided quote does not show the server total fee",
    );
    check(
      await page.getByText("Partial fill", { exact: true }).isVisible(),
      "Guided quote does not explain its partial fill",
    );
    check(
      await page
        .getByText("You pay (executable now)", { exact: true })
        .isVisible(),
      "Guided quote does not show its executable amount",
    );
    check(
      await page.getByText("per-trade cap", { exact: false }).isVisible(),
      "Guided quote does not explain the server binding rule",
    );
    const portfolioPreview = page
      .getByRole("heading", { name: "Treasury before → expected after" })
      .locator("..")
      .locator("..");
    for (const asset of guided.quote.expectedPostTradePortfolio.assets.filter(
      (asset) => asset.value !== "100000",
    )) {
      const row = portfolioPreview
        .locator("tbody tr")
        .filter({ hasText: asset.symbol });
      check(
        (await row.innerText()).includes(asset.value),
        `${asset.symbol} expected post-trade value is missing from the preview`,
      );
    }
    const prepareButton = page.getByRole("button", {
      name: "Prepare unsigned preview",
      exact: true,
    });
    check(
      await prepareButton.isDisabled(),
      "Unsigned preparation is available before the quote is reviewed",
    );
    await page.getByRole("checkbox").check();
    check(
      !(await prepareButton.isDisabled()),
      "Reviewed quote did not enable unsigned preparation",
    );
    const idempotencyKeys = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/v1/execute")
      ) {
        const body = request.postDataJSON();
        idempotencyKeys.push(body?.idempotencyKey);
      }
    });
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/v1/execute"),
      ),
      prepareButton.click(),
    ]);
    await page
      .getByRole("heading", {
        name: "Prepared — unsigned, not submitted",
      })
      .waitFor();
    await assertTouchTarget(prepareButton, "Prepare unsigned preview button");
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().endsWith("/v1/execute"),
      ),
      prepareButton.click(),
    ]);
    check(
      idempotencyKeys.length === 2 && idempotencyKeys[0] === idempotencyKeys[1],
      "Repeated unsigned preparation did not reuse its idempotency key",
    );
    await page.goto(`http://127.0.0.1:${traderPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Swap activity" }).waitFor();
    await page.getByText(/Prepared · unsigned, not submitted/).waitFor();
    check(
      await page.getByText(/Prepared · unsigned, not submitted/).isVisible(),
      "Prepared swap did not appear in browsable activity",
    );
    check(
      await page
        .getByText(
          `${guided.quote.requestedTraderInputAmount} settlement value units`,
          { exact: true },
        )
        .isVisible(),
      "Prepared activity did not retain the server requested value",
    );
    check(
      await page
        .getByText(
          `${guided.quote.executableTraderInputAmount} settlement value units`,
          { exact: true },
        )
        .isVisible(),
      "Prepared activity did not retain the server executed value",
    );
    check(
      await page
        .getByText(/estimated value units · not earned/, { exact: false })
        .isVisible(),
      "Unsent preparation was presented as an earned fee",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/Prepared · unsigned, not submitted/).waitFor();
    await page.goto(`http://127.0.0.1:${treasuryPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Confirmed treasury fee shares" })
      .waitFor();
    check(
      await page
        .getByText(
          "No confirmed settlement fee evidence is available for this treasury.",
        )
        .isVisible(),
      "Treasury empty earned-fee state is missing",
    );
    result.checks.push(
      "browsable prepared activity and evidence-backed empty fee summary",
    );
    await page.goto(`http://127.0.0.1:${traderPort}/swap`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Try a swap" }).waitFor();
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/v1/solve")),
      page.getByRole("button", { name: "Get quote", exact: true }).click(),
    ]);
    await page
      .getByRole("heading", { name: "Review what would happen" })
      .waitFor();
    const refreshQuoteButton = page.getByRole("button", {
      name: "Refresh quote",
      exact: true,
    });
    await page.getByRole("checkbox").check();
    const refreshSolveResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/v1/solve") &&
        response.request().method() === "POST",
    );
    await refreshQuoteButton.click();
    await refreshSolveResponsePromise;
    await page
      .getByRole("heading", { name: "Review what would happen" })
      .waitFor();
    check(
      !(await page.getByRole("checkbox").isChecked()),
      "Refreshing a quote did not require renewed review",
    );
    check(
      await page
        .getByRole("button", { name: "Prepare unsigned preview" })
        .isDisabled(),
      "Refreshing a quote retained an actionable preparation state",
    );
    await page.getByLabel("Amount to pay", { exact: true }).fill("50000");
    check(
      (await page
        .getByRole("heading", { name: "Review what would happen" })
        .count()) === 0,
      "Changing the amount left an actionable quote on screen",
    );
    result.checks.push(
      "guided entry, human-readable partial-fill review, expiry boundary, and idempotent unsigned preparation",
    );

    await page.goto(`http://127.0.0.1:${traderPort}/swap`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Try a swap" }).waitFor();
    await page.getByLabel("Amount to pay", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Get quote", exact: true }).click();
    await page.getByRole("alert").waitFor();
    check(
      (await page.getByRole("alert").innerText()).includes(
        "Enter an amount greater than zero",
      ),
      "Rejected zero-amount request did not provide a useful error",
    );
    result.checks.push("rejected request and actionable error recovery");

    await page.goto(`http://127.0.0.1:${treasuryPort}/`, {
      waitUntil: "domcontentloaded",
    });
    check(
      await page
        .getByRole("heading", { name: /organization’s liquidity/ })
        .isVisible(),
      "Treasury entry explanation is missing",
    );
    check(
      await page
        .getByRole("link", { name: /Explore a demo treasury/ })
        .isVisible(),
      "Treasury demo action is missing",
    );
    check(
      (await page
        .getByRole("link", { name: "Trader space" })
        .getAttribute("href")) === `http://127.0.0.1:${traderPort}`,
      "Treasury role switch does not use configured trader URL",
    );
    await page.goto(`http://127.0.0.1:${treasuryPort}/holdings`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { name: "Available to exchange" })
      .waitFor();
    check(
      await page
        .getByRole("combobox", { name: "Treasury configuration" })
        .isVisible(),
      "Treasury configuration selector is missing",
    );
    check(
      await page.getByText("Available now", { exact: true }).isVisible(),
      "Directional capacity is missing from holdings",
    );
    check(
      (await page
        .getByRole("link", { name: "Preview a trade" })
        .getAttribute("href")) === `http://127.0.0.1:${traderPort}/swap`,
      "Treasury preview does not link to the configured trader swap",
    );
    result.checks.push(
      "named treasury, directional capacity, and preview path",
    );
    await page.keyboard.press("Tab");
    check(
      await page.evaluate(() => document.activeElement?.tagName === "A"),
      "Keyboard focus did not reach a navigation link",
    );
    check(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return false;
        const outline = getComputedStyle(active);
        return (
          outline.outlineStyle !== "none" &&
          Number.parseFloat(outline.outlineWidth) >= 2
        );
      }),
      "Keyboard focus did not have a visible outline",
    );
    result.checks.push("role switching and keyboard focus");

    const fixture = createCanonicalFixture();
    const account = privateKeyToAccount(PRIVATE_TEST_KEY);
    await page.goto(`http://127.0.0.1:${traderPort}/trade`, {
      waitUntil: "domcontentloaded",
    });
    const values = {
      "Position ID": position.id,
      "Trader address": account.address,
      "Input token address": fixture.intent.traderInputToken,
      "Output token address": fixture.intent.traderOutputToken,
      "Requested value (settlement units)": "10000",
      "Minimum output value (settlement units)": "0",
      "Intent nonce": "987",
    };
    for (const [label, value] of Object.entries(values))
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByRole("button", { name: "Get quote", exact: true }).click();
    await page.getByText("Intent to authorize", { exact: true }).waitFor();
    await page.getByText("Intent to authorize", { exact: true }).click();
    const intent = JSON.parse(await page.locator("details pre").textContent());
    const signature = await account.sign({
      hash: hashIntent(intent, fixture.snapshot),
    });
    await page
      .getByLabel("Trader intent signature", { exact: true })
      .fill(signature);
    await page
      .getByRole("button", { name: "Prepare transaction", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Unsigned transaction — not broadcast" })
      .waitFor();
    const transaction = JSON.parse(
      await page.locator("section").last().locator("pre").textContent(),
    );
    check(
      typeof transaction.data === "string" && transaction.data.startsWith("0x"),
      "Browser flow did not produce execution calldata",
    );
    result.checks.push(
      "quote, solve, external signature, and unsigned transaction",
    );

    await page.goto(`http://127.0.0.1:${treasuryPort}/risk`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: "View Risk Details" })
      .first()
      .click();
    await page
      .getByText("Effective mode: Unavailable", { exact: false })
      .waitFor();
    check(
      await page
        .getByText("Always-applicable hard rules", { exact: true })
        .isVisible(),
      "Protections does not explain the hard-policy boundary",
    );
    check(
      await page
        .getByText("Risk signer authority", { exact: true })
        .isVisible(),
      "Protections does not expose unavailable signer authority",
    );
    await page
      .getByRole("button", { name: "Show simulated example", exact: true })
      .click();
    check(
      await page
        .getByText("Before · hard-policy capacity", { exact: true })
        .isVisible(),
      "Protections simulation does not show its before state",
    );
    check(
      await page
        .getByText("After · simulated temporary capacity", { exact: true })
        .isVisible(),
      "Protections simulation does not show its after state",
    );
    await page
      .getByRole("button", { name: "Reset simulated example", exact: true })
      .click();
    check(
      (await page
        .getByText("Before · hard-policy capacity", { exact: true })
        .count()) === 0,
      "Protections simulation did not reset",
    );
    result.checks.push(
      "hard-policy explanation, unavailable effective risk, signer state, and isolated simulation",
    );

    await page.goto(`http://127.0.0.1:${traderPort}/history`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("Execution hash").fill(`0x${"ff".repeat(32)}`);
    await page.getByRole("button", { name: "Look up" }).click();
    await page.getByRole("alert").waitFor();
    result.checks.push("visible API error state");
    await page.goto(`http://127.0.0.1:${traderPort}/swap`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Get quote", exact: true }).click();
    await page
      .getByRole("heading", { name: "Review what would happen" })
      .waitFor();
    const expiringPrepareButton = page.getByRole("button", {
      name: "Prepare unsigned preview",
      exact: true,
    });
    await page.clock.install();
    await page.clock.fastForward(61_000);
    await page.getByText("Quote expired", { exact: true }).waitFor();
    check(
      await expiringPrepareButton.isDisabled(),
      "Expired quote still allows unsigned preparation",
    );
    result.checks.push("quote expiry invalidates preparation");

    await stopProcess(service);
    rmSync(databaseDirectory, { recursive: true, force: true });
    mkdirSync(databaseDirectory, { recursive: true });
    service = startService(servicePort, databaseDirectory);
    writeProcessPidFile(processPidFile, [service, treasury, trader]);
    await waitForHttp(
      `http://127.0.0.1:${servicePort}/health`,
      "Reset service",
      service,
    );
    await page.goto(`http://127.0.0.1:${traderPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "No activity yet" }).waitFor();
    await page.goto(`http://127.0.0.1:${treasuryPort}/activity`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByText(
        "No confirmed settlement fee evidence is available for this treasury.",
      )
      .waitFor();
    result.checks.push("fresh service reset removes local preparation records");

    await stopProcess(service);
    await page.goto(`http://127.0.0.1:${traderPort}/`, {
      waitUntil: "domcontentloaded",
    });
    check(
      await page
        .getByRole("heading", { name: /Exchange assets with a treasury/ })
        .isVisible(),
      "Product explanation disappeared during an API outage",
    );
    await page.goto(`http://127.0.0.1:${traderPort}/swap`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("alert").waitFor();
    check(
      (await page.getByRole("alert").innerText()).includes(
        "liquidity source could not be loaded",
      ),
      "Swap outage state did not explain the unavailable action",
    );
    await page.goto(`http://127.0.0.1:${treasuryPort}/holdings`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("alert").waitFor();
    check(
      (await page.getByRole("alert").innerText()).includes(
        "treasury data service could not answer",
      ),
      "Holdings outage state did not explain the unavailable data",
    );
    await page.goto(`http://127.0.0.1:${traderPort}/status`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("alert").waitFor();
    check(
      (await page.getByRole("alert").innerText()).includes(
        "Diagnostics are unavailable",
      ),
      "Status outage state does not explain recovery",
    );
    result.checks.push(
      "product explanation and relevant actions survive API outage",
    );
    check(
      pageErrors.length === 0,
      `Browser page errors: ${pageErrors.join("; ")}`,
    );
    result.checks.push("no browser page errors");
  } catch (error) {
    failure = error;
    result.status = "failed";
    result.reason =
      error instanceof Error ? error.message : "browser_smoke_failed";
  } finally {
    if (browser) await browser.close().catch(() => {});
    await Promise.all([
      stopProcess(treasury),
      stopProcess(trader),
      stopProcess(service),
    ]);
    rmSync(databaseDirectory, { recursive: true, force: true });
    if (processPidFile) rmSync(processPidFile, { force: true });
  }
  if (failure) {
    result.processes = [
      ["service", service],
      ["treasury", treasury],
      ["trader", trader],
    ].map(([name, processHandle]) => ({
      name,
      stdout: processHandle.stdout.values(),
      stderr: processHandle.stderr.values(),
    }));
    writeResult(result);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
    return;
  }
  writeResult(result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const result = {
    status: "failed",
    reason: error instanceof Error ? error.message : "browser_smoke_failed",
  };
  writeResult(result);
  console.error(JSON.stringify(result));
  process.exitCode = 1;
});
