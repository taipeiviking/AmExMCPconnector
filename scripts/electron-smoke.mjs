import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const dataDirectory = await mkdtemp(join(tmpdir(), "amex-connector-smoke-"));
const mcpPort = await reserveEphemeralPort();
const debugPort = await reserveEphemeralPort();
const output = [];

const child = spawn(
  electronExecutable,
  [`--remote-debugging-port=${debugPort}`, projectRoot],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      AMEX_APP_ENV: "test",
      AMEX_DATA_DIR: dataDirectory,
      AMEX_DEMO_MODE: "true",
      AMEX_START_MINIMIZED: "true",
      AMEX_MCP_MODE: "local",
      AMEX_MCP_HOST: "127.0.0.1",
      AMEX_MCP_PORT: String(mcpPort),
      AMEX_MCP_AUTH_MODE: "loopback-only",
      OPENAI_TUNNEL_ENABLED: "false",
      OPENAI_TUNNEL_AUTO_START: "false",
      AMEX_US_AGGREGATOR: "disabled",
      AMEX_FX_RATE_SOURCE: "manual",
      AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL: "true",
      AMEX_TELEMETRY_ENABLED: "false",
      AMEX_CRASH_REPORTING_ENABLED: "false"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }
);

child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

try {
  const health = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/healthz`);
    if (!response.ok) throw new Error(`health endpoint returned ${response.status}`);
    return response.json();
  }, "loopback MCP health check");

  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) throw new Error(`DevTools target list returned ${response.status}`);
    const targets = await response.json();
    const dashboard = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!dashboard) throw new Error("dashboard target is not ready");
    return dashboard;
  }, "Electron dashboard target");

  const snapshot = await retry(async () => {
    const value = await evaluateInRenderer(
      page.webSocketDebuggerUrl,
      `globalThis.amexConnector?.getSnapshot().then((snapshot) => ({
        bridgeReady: typeof globalThis.amexConnector.performAction === "function",
        storageState: snapshot.storage.state,
        mcpState: snapshot.mcp.state,
        toolCount: snapshot.mcp.toolCount,
        exposure: snapshot.mcp.exposure,
        accountCount: snapshot.accounts.length,
        notices: snapshot.notices
      }))`
    );
    if (value?.bridgeReady !== true) throw new Error("sandboxed preload bridge is not installed yet");
    return value;
  }, "sandboxed preload bridge and initial snapshot");

  if (
    snapshot?.bridgeReady !== true ||
    snapshot.storageState !== "unlocked" ||
    snapshot.mcpState !== "running" ||
    snapshot.toolCount !== 7 ||
    snapshot.exposure !== "loopback-only" ||
    snapshot.accountCount !== 4
  ) {
    throw new Error(`unexpected renderer snapshot: ${JSON.stringify(snapshot)}`);
  }

  const ui = await retry(async () => {
    const rendered = await evaluateInRenderer(
      page.webSocketDebuggerUrl,
      `(async () => {
        document.querySelector('[data-section="accounts"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const cards = [...document.querySelectorAll('.compact-account-card')];
        const accountText = document.querySelector('#accounts')?.textContent ?? '';
        const accountResult = {
          active: document.querySelector('#accounts')?.classList.contains('active') === true,
          heading: document.querySelector('#accounts h2')?.textContent,
          cardCount: cards.length,
          encryptedTags: document.querySelectorAll('.compact-account-card .secure-tag').length,
          greenStatuses: document.querySelectorAll('.connection-status.connected .status-dot').length,
          hasLongCardNumber: /(?:\\d[ -]?){13,19}/u.test(accountText),
          bodyBackground: getComputedStyle(document.body).backgroundColor,
          accountMetric: document.querySelector('#account-count')?.textContent,
          cardsText: document.querySelector('#accounts-cards')?.textContent,
          notice: document.querySelector('#notice')?.textContent,
          pageTitle: document.querySelector('#page-title')?.textContent
        };
        document.querySelector('[data-section="getting-started"]')?.click();
        const wizardResult = {
          stepCount: document.querySelectorAll('[data-wizard-step]').length,
          pathCount: document.querySelectorAll('[data-account-path]').length,
          active: document.querySelector('#getting-started')?.classList.contains('active') === true
        };
        const testDrive = await globalThis.amexConnector.performAction('run-safe-test-drive');
        document.querySelector('[data-section="accounts"]')?.click();
        return { accountResult, wizardResult, testDrive };
      })()`
    );
    if (rendered?.accountResult?.cardCount !== 4) {
      throw new Error(`synthetic account cards have not rendered yet: ${JSON.stringify(rendered)}`);
    }
    return rendered;
  }, "rendered onboarding and Accounts UI");

  if (
    ui?.accountResult?.active !== true ||
    ui.accountResult.heading !== "Accounts" ||
    ui.accountResult.encryptedTags !== 4 ||
    ui.accountResult.greenStatuses < 1 ||
    ui.accountResult.hasLongCardNumber !== false ||
    ui.accountResult.bodyBackground !== "rgb(23, 25, 28)" ||
    ui?.wizardResult?.active !== true ||
    ui.wizardResult.stepCount !== 5 ||
    ui.wizardResult.pathCount !== 4 ||
    ui?.testDrive?.ok !== true ||
    ui.testDrive.testDrive?.checks?.length !== 4
  ) {
    throw new Error(`unexpected rendered UI state: ${JSON.stringify(ui)}`);
  }

  const screenshotPath = process.env.AMEX_SMOKE_SCREENSHOT_PATH;
  if (screenshotPath) {
    const screenshot = await sendDevToolsCommand(page.webSocketDebuggerUrl, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false
    });
    if (typeof screenshot?.data !== "string" || screenshot.data.length < 10_000) {
      throw new Error("Accounts screenshot capture returned an unexpectedly small payload.");
    }
    await writeFile(resolve(screenshotPath), Buffer.from(screenshot.data, "base64"));
  }

  if (health?.status !== "ok" || health?.scope !== "loopback") {
    throw new Error(`unexpected health response: ${JSON.stringify(health)}`);
  }

  process.stdout.write("Electron smoke test passed: encrypted first-run storage, trusted renderer IPC, five-step onboarding, dark Accounts cards, safe test drive, and loopback MCP are running.\n");
} catch (error) {
  const detail = output.slice(-30).join("");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nElectron output:\n${detail}` : ""}`);
} finally {
  if (child.exitCode === null) child.kill();
  await waitForExit(child);
  const tempRoot = `${resolve(tmpdir())}${sep}`.toLowerCase();
  const resolvedDataDirectory = resolve(dataDirectory).toLowerCase();
  if (!resolvedDataDirectory.startsWith(tempRoot)) {
    throw new Error("Refusing to clean a smoke-test directory outside the operating-system temp directory.");
  }
  await rm(dataDirectory, { recursive: true, force: true, maxRetries: 3 });
}

async function reserveEphemeralPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  if (!port) throw new Error("Could not reserve a loopback test port.");
  return port;
}

async function retry(operation, label) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}.`);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function evaluateInRenderer(webSocketUrl, expression) {
  const result = await sendDevToolsCommand(webSocketUrl, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return result?.result?.value;
}

async function sendDevToolsCommand(webSocketUrl, method, params = {}) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools WebSocket failed to open.")), { once: true });
  });
  try {
    const id = 1;
    socket.send(JSON.stringify({ id, method, params }));
    const message = await new Promise((resolveMessage, reject) => {
      const timer = setTimeout(() => reject(new Error("Renderer evaluation timed out.")), 10_000);
      socket.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data));
        if (parsed.id !== id) return;
        clearTimeout(timer);
        resolveMessage(parsed);
      });
    });
    if (message.error || message.result?.exceptionDetails) {
      throw new Error(`DevTools command failed: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`);
    }
    return message.result;
  } finally {
    socket.close();
  }
}

function appendOutput(stream, chunk) {
  output.push(`[${stream}] ${String(chunk)}`);
  while (output.length > 100) output.shift();
}

async function waitForExit(processHandle) {
  if (processHandle.exitCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => processHandle.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000))
  ]);
}
