/* global AbortSignal, URL, console, document, fetch, innerWidth, process, setTimeout */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";
import { chromium } from "playwright";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_STOP_TIMEOUT_MS = 2_000;

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

function startProcess(args, environment) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.env.PNPM_BIN ?? "pnpm", args, {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stdout, stderr };
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
    if (processHandle.child.exitCode !== null)
      throw new Error(`${label} exited before startup`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become reachable in time`);
}

async function apiData(url, label) {
  const response = await fetch(url);
  const body = await response.json();
  check(
    response.ok && body?.ok === true,
    `${label} did not return a successful API envelope`,
  );
  return body.data;
}

async function assertPage(page, url, route, routes) {
  await page.goto(`${url}${route}`, { waitUntil: "networkidle" });
  await page.locator("h1").first().waitFor();
  check(
    (await page.locator("h1").count()) === 1,
    `Expected one page heading on ${route}`,
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  check(
    !overflow,
    `Horizontal overflow on ${route} at ${await page.evaluate(() => innerWidth)}px`,
  );
  routes.push(route);
}

async function main() {
  const databaseDirectory = mkdtempSync(
    path.join(os.tmpdir(), "aurka-browser-smoke-"),
  );
  const servicePort = await freePort();
  const appPort = await freePort();
  let service = startProcess(["--filter", "@aurka/services", "start"], {
    HOST: "127.0.0.1",
    PORT: String(servicePort),
    DATABASE_URL: path.join(databaseDirectory, "service.sqlite"),
  });
  const app = startProcess(
    [
      "--filter",
      "@aurka/trader-app",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(appPort),
      "--strictPort",
    ],
    {
      AURKA_SERVICE_URL: `http://127.0.0.1:${servicePort}`,
    },
  );
  const processPidFile = process.env.AURKA_BROWSER_PID_FILE;
  if (processPidFile)
    writeFileSync(processPidFile, `${service.child.pid}\n${app.child.pid}\n`);
  let browser;
  const result = { status: "passed", routes: [], checks: [] };
  const artifactDirectory = process.env.AURKA_ARTIFACT_DIR;
  if (artifactDirectory) mkdirSync(artifactDirectory, { recursive: true });
  try {
    const appUrl = `http://127.0.0.1:${appPort}`;
    await waitForHttp(
      `http://127.0.0.1:${servicePort}/health`,
      "Service",
      service,
    );
    await waitForHttp(`${appUrl}/spaces`, "Canonical application", app);
    const health = await apiData(
      `${appUrl}/api/health`,
      "Built-app API health",
    );
    check(
      health.status === "ok",
      "Built app API proxy did not reach the service",
    );
    const positions = await apiData(
      `${appUrl}/api/v1/positions`,
      "Built-app positions",
    );
    const position = positions.items[0];
    check(position?.id, "Built app API returned no Space");
    const spaceId = encodeURIComponent(position.id);
    const ruleActivity = await apiData(
      `${appUrl}/api/v1/activity?spaceId=${spaceId}&type=RULE_CHANGE&from=0&to=4102444800`,
      "Built-app typed activity",
    );
    check(
      Array.isArray(ruleActivity.items) && ruleActivity.nextCursor === null,
      "Built app typed activity filter returned an invalid page",
    );

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 844 },
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of [
        "/spaces",
        `/spaces/${spaceId}`,
        `/spaces/${spaceId}/overview`,
        `/spaces/${spaceId}/holdings`,
        `/spaces/${spaceId}/settings`,
        "/trade",
        `/trade/${spaceId}`,
        "/activity",
      ])
        await assertPage(page, appUrl, route, result.routes);
      if (width < 768) {
        const menu = page.getByRole("button", { name: "Open navigation menu" });
        await menu.focus();
        await page.keyboard.press("Enter");
        check(
          await page
            .getByRole("navigation", { name: "Mobile navigation" })
            .isVisible(),
          `Keyboard menu activation failed at ${width}px`,
        );
        await page.keyboard.press("Escape");
        check(
          !(await page
            .getByRole("navigation", { name: "Mobile navigation" })
            .isVisible()),
          "Escape did not close the keyboard-opened mobile menu",
        );
        await menu.click();
        check(
          await page
            .getByRole("navigation", { name: "Mobile navigation" })
            .isVisible(),
          `Mobile menu did not open at ${width}px`,
        );
        check(
          await page
            .getByRole("link", { name: "Spaces", exact: true })
            .last()
            .isVisible(),
          `Mobile Spaces link missing at ${width}px`,
        );
        await page.keyboard.press("Escape");
        check(
          !(await page
            .getByRole("navigation", { name: "Mobile navigation" })
            .isVisible()),
          "Escape did not close the mobile menu",
        );
      }
    }
    result.checks.push(
      "canonical routes, deep links, one heading, and no mobile overflow",
    );

    await page.setViewportSize({ width: 1280, height: 844 });
    await page.goto(`${appUrl}/spaces`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Trade", exact: true }).click();
    await page.waitForURL("**/trade");
    check(
      page.url() === `${appUrl}/trade`,
      "Spaces to Trade navigation changed the wrong route",
    );
    await page.goBack();
    await page.waitForURL("**/spaces");
    await page.goForward();
    await page.waitForURL("**/trade");
    result.checks.push("pointer navigation plus browser back/forward");

    await page.goto(`${appUrl}/spaces`, { waitUntil: "networkidle" });
    await page.getByRole("link", { name: "Open Space", exact: true }).click();
    await page.waitForURL(`**/spaces/${spaceId}`);
    await page
      .getByRole("link", { name: "Trade this Space", exact: true })
      .click();
    await page.waitForURL(`**/trade/${spaceId}`);
    result.checks.push(
      "Space identity preserved across Space-to-Trade navigation",
    );

    const aliases = {
      "/": "/spaces",
      "/start": "/spaces",
      "/dashboard": "/spaces",
      "/swap": "/trade",
      "/history": "/activity",
      "/executions": "/activity",
      "/portfolio": "/spaces",
      "/liquidity": "/spaces",
    };
    for (const [alias, canonical] of Object.entries(aliases)) {
      await page.goto(`${appUrl}${alias}`, { waitUntil: "networkidle" });
      check(
        new URL(page.url()).pathname === canonical,
        `${alias} did not redirect to ${canonical}`,
      );
    }
    for (const alias of ["/holdings", "/positions"]) {
      await page.goto(`${appUrl}${alias}`, { waitUntil: "networkidle" });
      check(
        new URL(page.url()).pathname === `/spaces/${spaceId}/holdings`,
        `${alias} did not redirect to Space holdings`,
      );
    }
    for (const alias of ["/protections", "/risk", "/status"]) {
      await page.goto(`${appUrl}${alias}`, { waitUntil: "networkidle" });
      check(
        new URL(page.url()).pathname === `/spaces/${spaceId}/settings`,
        `${alias} did not redirect to Space settings`,
      );
    }
    result.checks.push("legacy aliases redirect to canonical routes");

    await page.goto(`${appUrl}/trade/${spaceId}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Trade" }).waitFor();
    await page.getByRole("button", { name: "Get quote", exact: true }).click();
    await page
      .getByRole("heading", { name: "Review what would happen" })
      .waitFor();
    result.checks.push("Space parameter propagated to a successful quote");

    const agentPrompt = page.getByRole("textbox", {
      name: "Ask the live trade assistant",
    });
    await agentPrompt.fill("I want fdits rules?");
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Let's narrow that down" })
      .waitFor();
    if (artifactDirectory)
      await page.screenshot({
        path: path.join(artifactDirectory, "agent-clarification-desktop.png"),
        fullPage: true,
      });

    await page.setViewportSize({ width: 390, height: 844 });
    await agentPrompt.fill("Explain this Space's current rules");
    await page.getByRole("button", { name: "Ask agent", exact: true }).click();
    await page.getByRole("region", { name: "Space rules answer" }).waitFor();
    if (artifactDirectory)
      await page.screenshot({
        path: path.join(artifactDirectory, "agent-rules-mobile.png"),
        fullPage: true,
      });
    result.checks.push(
      "ambiguous assistant prompt clarifies and selected-Space rules render on desktop/mobile",
    );

    await page.goto(
      `${appUrl}/activity?spaceId=${spaceId}&type=RULE_CHANGE&status=CONFIRMED`,
      { waitUntil: "networkidle" },
    );
    const activityFilters = page
      .locator("section")
      .filter({ hasText: "Filter activity" });
    check(
      (await activityFilters.locator("select").nth(1).inputValue()) ===
        "RULE_CHANGE",
      "Activity type filter was not restored from the URL",
    );
    check(
      (await activityFilters.locator("select").nth(2).inputValue()) ===
        "CONFIRMED",
      "Activity status filter was not restored from the URL",
    );
    await page.goto(`${appUrl}/spaces/${spaceId}/overview`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Recent activity" }).waitFor();
    const fullHistory = page.getByRole("link", {
      name: "View full activity",
    });
    await fullHistory.click();
    await page.waitForURL(`**/activity?spaceId=${spaceId}`);
    result.checks.push(
      "typed Activity filters and Space Recent activity share the same feed",
    );

    await page.goto(`${appUrl}/spaces/not-a-real-space`, {
      waitUntil: "networkidle",
    });
    await page.getByRole("heading", { name: "Space not found" }).waitFor();
    result.checks.push("meaningful unknown Space state");

    check(
      pageErrors.length === 0,
      `Browser page errors: ${pageErrors.join("; ")}`,
    );
    result.checks.push("no browser page errors");
  } catch (error) {
    result.status = "failed";
    result.reason =
      error instanceof Error ? error.message : "browser_smoke_failed";
    result.processes = [
      ["service", service],
      ["app", app],
    ].map(([name, processHandle]) => ({
      name,
      stdout: processHandle.stdout,
      stderr: processHandle.stderr,
    }));
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopProcess(app);
    await stopProcess(service);
    rmSync(databaseDirectory, { recursive: true, force: true });
    if (processPidFile) rmSync(processPidFile, { force: true });
  }
  if (result.status === "passed") console.log(JSON.stringify(result, null, 2));
  if (artifactDirectory) {
    writeFileSync(
      path.join(artifactDirectory, "browser-smoke.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "failed",
      reason: error instanceof Error ? error.message : "browser_smoke_failed",
    }),
  );
  process.exitCode = 1;
});
