import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

if (process.platform !== "win32") {
  throw new Error("The packaged executable smoke test runs only on Windows.");
}

const projectRoot = resolve(import.meta.dirname, "..");
const executable = resolve(projectRoot, "release", "win-unpacked", "Amex Local Finance Connector.exe");
await access(executable).catch(() => {
  throw new Error(`Packaged executable not found at ${executable}. Run npm run package:win first.`);
});

const smokeRoot = await mkdtemp(join(tmpdir(), "amex-connector-packaged-smoke-"));
const dataDirectory = join(smokeRoot, "financial-data");
const userDataDirectory = join(smokeRoot, "electron-profile");
const debugPort = await reserveEphemeralPort();
const output = [];
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    !name.toUpperCase().startsWith("AMEX_") &&
    !name.toUpperCase().startsWith("OPENAI_TUNNEL_") &&
    name.toUpperCase() !== "ELECTRON_RUN_AS_NODE"
  )
);

const child = spawn(executable, [
  `--user-data-dir=${userDataDirectory}`,
  `--remote-debugging-port=${debugPort}`,
  "--amex-packaged-smoke-exit-after-ms=15000"
], {
  cwd: dirname(executable),
  env: {
    ...inheritedEnvironment,
    AMEX_DATA_DIR: dataDirectory,
    AMEX_DEMO_MODE: "false",
    AMEX_START_MINIMIZED: "true",
    AMEX_START_WITH_WINDOWS: "false",
    AMEX_MCP_MODE: "disabled",
    AMEX_MCP_HOST: "127.0.0.1",
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
});

child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));

try {
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) throw new Error(`DevTools target list returned ${response.status}`);
    const targets = await response.json();
    const dashboard = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!dashboard) throw new Error("dashboard target is not ready");
    return dashboard;
  }, "packaged dashboard target", 10_000);
  const snapshot = await retry(async () => {
    const value = await evaluateInRenderer(
      page.webSocketDebuggerUrl,
      `globalThis.amexConnector?.getSnapshot().then((snapshot) => ({
        bridgeReady: typeof globalThis.amexConnector.performAction === "function",
        storageState: snapshot.storage.state,
        mcpState: snapshot.mcp.state,
        demoMode: snapshot.demoMode,
        environment: snapshot.environment,
        screenshotProtectionEnabled: snapshot.privacy.screenshotProtectionEnabled,
        screenshotControlAvailable: snapshot.privacy.screenshotControlAvailable,
        screenshotSettingScope: snapshot.privacy.settingScope,
        screenshotQuickToggleHidden: document.querySelector('#screenshot-quick-toggle')?.hidden,
        screenshotToggleHidden: document.querySelector('#screenshot-protection-toggle')?.hidden,
        screenshotWarningHidden: document.querySelector('#screenshot-warning')?.hidden,
        screenshotPillHidden: document.querySelector('#screenshot-pill')?.hidden
      }))`
    );
    if (
      value?.bridgeReady !== true ||
      value.screenshotQuickToggleHidden !== false ||
      value.screenshotToggleHidden !== false
    ) {
      throw new Error("sandboxed preload bridge or protected screenshot UI is not ready yet");
    }
    return value;
  }, "packaged controller readiness", 10_000);
  if (
    snapshot?.storageState !== "unlocked" ||
    snapshot.mcpState !== "stopped" ||
    snapshot.demoMode !== false ||
    snapshot.environment !== "production" ||
    snapshot.screenshotProtectionEnabled !== true ||
    snapshot.screenshotControlAvailable !== true ||
    snapshot.screenshotSettingScope !== "session" ||
    snapshot.screenshotQuickToggleHidden !== false ||
    snapshot.screenshotToggleHidden !== false ||
    snapshot.screenshotWarningHidden !== true ||
    snapshot.screenshotPillHidden !== true
  ) {
    throw new Error(`unexpected packaged snapshot: ${JSON.stringify(snapshot)}`);
  }

  const localControls = await evaluateInRenderer(
    page.webSocketDebuggerUrl,
    `(async () => {
      const add = await globalThis.amexConnector.performAction({
        kind: 'add-account',
        country: 'JP',
        accountClass: 'personal',
        label: 'Packaged smoke account',
        legalEntityName: 'Synthetic local owner'
      });
      const afterAdd = await globalThis.amexConnector.getSnapshot();
      const account = afterAdd.accounts.find((candidate) => candidate.name === 'Packaged smoke account');
      if (!account) return { add, error: 'created account was not visible' };
      const portfolio = await globalThis.amexConnector.performAction({
        kind: 'update-portfolio',
        name: 'Packaged smoke portfolio',
        accountIds: [account.id]
      });
      const rename = await globalThis.amexConnector.performAction({
        kind: 'rename-account',
        accountId: account.id,
        label: 'Renamed packaged smoke account'
      });
      const finalSnapshot = await globalThis.amexConnector.getSnapshot();
      return {
        add,
        portfolio,
        rename,
        accountCount: finalSnapshot.accounts.length,
        accountName: finalSnapshot.accounts.find((candidate) => candidate.id === account.id)?.name,
        inPortfolio: finalSnapshot.accounts.find((candidate) => candidate.id === account.id)?.inPortfolio,
        portfolioName: finalSnapshot.portfolio.name,
        portfolioAccountIds: finalSnapshot.portfolio.accountIds
      };
    })()`
  );
  if (
    localControls?.add?.ok !== true ||
    localControls?.portfolio?.ok !== true ||
    localControls?.rename?.ok !== true ||
    localControls.accountCount !== 1 ||
    localControls.accountName !== "Renamed packaged smoke account" ||
    localControls.inPortfolio !== true ||
    localControls.portfolioName !== "Packaged smoke portfolio" ||
    localControls.portfolioAccountIds?.length !== 1
  ) {
    throw new Error(`unexpected packaged local-control result: ${JSON.stringify(localControls)}`);
  }
  if (child.exitCode !== null) throw new Error(`packaged app exited early with code ${child.exitCode}`);

  const exitCode = await waitForExit(child, 20_000);
  if (exitCode !== 0) throw new Error(`packaged app did not exit cleanly (code ${String(exitCode)})`);

  process.stdout.write(
    "Packaged Windows smoke test passed: the unsigned-alpha executable started protected with its session-only screenshot control available, used isolated encrypted storage, kept MCP disabled by default, saved account/portfolio controls, and exited through the application shutdown path.\n"
  );
} catch (error) {
  const detail = output.slice(-30).join("");
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nPackaged output:\n${detail}` : ""}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await waitForExit(child, 5_000).catch(() => undefined);
  }
  const tempRoot = `${resolve(tmpdir())}${sep}`.toLowerCase();
  const resolvedSmokeRoot = resolve(smokeRoot).toLowerCase();
  if (!resolvedSmokeRoot.startsWith(tempRoot)) {
    throw new Error("Refusing to clean a packaged-smoke directory outside the operating-system temp directory.");
  }
  await rm(smokeRoot, { recursive: true, force: true, maxRetries: 3 });
}

async function retry(operation, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged executable exited early with code ${child.exitCode}`);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error(`${label} did not complete: ${lastError instanceof Error ? lastError.message : "timeout"}`);
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
  if (!port) throw new Error("Could not reserve a loopback DevTools port for the packaged smoke test.");
  return port;
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

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return Promise.resolve(processHandle.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("packaged executable exit timed out")), timeoutMs);
    processHandle.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}
