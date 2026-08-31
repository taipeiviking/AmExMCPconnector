import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent,
  type Tray
} from "electron";
import {
  createDemoCore,
  openEncryptedCore,
  type AmexAccount,
  type AuditEvent,
  type EncryptedCoreRuntime,
  type FinanceQueryService,
  type FraudAlert
} from "../core";
import { createElectronSafeStorageKeyProtector } from "../storage";
import { type AppConfiguration } from "../config/environment";
import { McpHttpServer } from "../mcp/http-server";
import {
  IPC,
  type AccountSummaryView,
  type AlertSummaryView,
  type AuditSummaryView,
  type DesktopAction,
  type DesktopRequest,
  type DesktopActionResult,
  type DesktopSnapshot
} from "../shared/ipc";
import { createDashboardWindow } from "./window";
import { createTrayController } from "./tray";
import { SingleFlightResource } from "./single-flight-resource";
import { initializeEncryptedRuntime } from "./initialize-encrypted-runtime";
import { runLocalTestDrive } from "./local-test-drive";
import {
  deleteLocalDataTargets,
  initializeLocalDataOwnership,
  inventoryLocalDataTargets
} from "./data-deletion";

const TUNNEL_DOCS = "https://developers.openai.com/api/docs/guides/secure-mcp-tunnels";
const VALID_ACTIONS = new Set<DesktopAction>([
  "refresh",
  "authorize-us-account",
  "import-jp-statement",
  "prepare-export",
  "open-data-folder",
  "open-export-folder",
  "open-log-folder",
  "open-tunnel-docs",
  "run-safe-test-drive",
  "delete-all-local-data",
  "lock"
]);

interface ActiveCore {
  service: FinanceQueryService;
  portfolioId: string;
  listAuditEvents: () => Promise<readonly AuditEvent[]>;
  accountIdsWithData: () => Promise<ReadonlySet<string>>;
  addJapanAccount?: (input: AddAccountInput) => Promise<string>;
  renameAccount?: (accountId: string, label: string) => Promise<void>;
  disconnectJapanAccount?: (accountId: string) => Promise<void>;
  discardChanges: () => void;
  close: () => Promise<void>;
}

interface AddAccountInput {
  accountClass: "personal" | "company";
  label: string;
  legalEntityName: string;
}

interface ActiveRuntime {
  active: ActiveCore;
  mcp?: McpHttpServer;
  mcpError?: string;
}

export class DesktopController {
  private window?: BrowserWindow;
  private tray?: Tray;
  private readonly runtime: SingleFlightResource<ActiveRuntime>;
  private storageState: DesktopSnapshot["storage"]["state"] = "locked";
  private storageError?: string;
  private mcpError?: string;
  private quitting = false;
  private commandTail: Promise<void> = Promise.resolve();
  private lifecycleState: "running" | "locking" | "deleting" | "quitting" = "running";
  private dataOwnershipReady = false;

  constructor(private readonly configuration: AppConfiguration) {
    this.runtime = new SingleFlightResource(
      () => this.stageRuntime(),
      (resource) => this.disposeRuntime(resource)
    );
  }

  private get active(): ActiveCore | undefined {
    return this.runtime.current?.active;
  }

  private get mcp(): McpHttpServer | undefined {
    return this.runtime.current?.mcp;
  }

  async start(): Promise<void> {
    this.registerIpc();
    // Finish the first encrypted-runtime attempt before loading the renderer so
    // its initial snapshot cannot become permanently stale at "zero accounts".
    await this.unlock();
    this.window = createDashboardWindow({
      screenshotProtection: this.configuration.screenshotProtection,
      devTools: this.configuration.environment !== "production" && !app.isPackaged,
      onRequestClose: () => this.window?.hide()
    });
    this.tray = createTrayController({
      showDashboard: () => void this.showDashboard(),
      lock: () => void this.lock(),
      quit: () => void this.quit(),
      statusLabel: () => `MCP: ${this.mcp?.status.state ?? "stopped"}`
    });

    if (this.configuration.startWithWindows && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true });
    }

    if (!this.configuration.startMinimized) await this.showDashboard();
  }

  async showDashboard(): Promise<void> {
    if (this.quitting || this.lifecycleState !== "running") return;
    const expectedRevision = this.runtime.revision;
    if (!this.active) await this.unlock();
    if (expectedRevision !== this.runtime.revision || !this.active) return;
    const window = this.window;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async lock(): Promise<void> {
    if (this.lifecycleState === "quitting" || this.lifecycleState === "deleting") return;
    if (this.lifecycleState === "locking") {
      await this.commandTail;
      return;
    }
    this.lifecycleState = "locking";
    this.window?.hide();
    try {
      await this.commandTail;
      await this.runtime.release();
      this.storageState = "locked";
      this.storageError = undefined;
      this.mcpError = undefined;
    } finally {
      if (!this.quitting) this.lifecycleState = "running";
    }
  }

  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.lifecycleState = "quitting";
    ipcMain.removeHandler(IPC.getSnapshot);
    ipcMain.removeHandler(IPC.performAction);
    await this.commandTail;
    await this.runtime.release().catch(() => undefined);
    this.tray?.destroy();
    this.window?.destroy();
    app.exit(0);
  }

  async getSnapshot(): Promise<DesktopSnapshot> {
    const active = this.active;
    const notices: string[] = [];
    if (this.configuration.demoMode) {
      notices.push("Synthetic demo records are enabled explicitly and remain separate from the encrypted production store.");
    }
    if (this.configuration.raw.AMEX_US_AGGREGATOR === "disabled") {
      notices.push("U.S. consent aggregation is disabled until an approved read-only provider is configured.");
    }
    if (this.configuration.tunnel.autoStart) {
      notices.push("Tunnel auto-start is reserved but not implemented in this scaffold; use the documented manual client workflow.");
    }
    if (!this.dataOwnershipReady) {
      notices.push("Destructive cleanup is disabled because the configured data folders could not be proven app-owned.");
    }
    if (this.storageError) notices.push(this.storageError);
    if (this.mcpError) notices.push(this.mcpError);

    let accounts: AmexAccount[] = [];
    let accountIdsWithData: ReadonlySet<string> = new Set();
    let alerts: FraudAlert[] = [];
    let audit: AuditEvent[] = [];
    if (active) {
      try {
        accounts = [...(await active.service.listAccounts({ portfolioId: active.portfolioId }))];
        accountIdsWithData = await active.accountIdsWithData();
        alerts = [
          ...(await active.service.listFraudAlerts({
            target: { kind: "portfolio", portfolioId: active.portfolioId },
            limit: 50
          }))
        ];
        audit = [...(await active.listAuditEvents())];
      } catch (error) {
        notices.push(error instanceof Error ? error.message : "Local financial data could not be read.");
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      version: app.getVersion(),
      environment: this.configuration.environment,
      demoMode: this.configuration.demoMode,
      portfolioId: active?.portfolioId ?? this.configuration.defaults.portfolioId,
      baseCurrency: this.configuration.defaults.baseCurrency,
      storage: {
        state: this.storageState,
        protection: "AES-256-GCM database · Windows safeStorage/DPAPI-wrapped key",
        dataDirectory: this.configuration.storage.dataDirectory
      },
      mcp: {
        state: this.mcp?.status.state ?? "stopped",
        ...(this.mcp?.status.endpoint ? { endpoint: this.mcp.status.endpoint } : {}),
        toolCount: 7,
        exposure: "loopback-only"
      },
      tunnel: tunnelView(this.configuration),
      accounts: accounts.map((account) => toAccountView(account, accountIdsWithData.has(account.id))),
      alerts: alerts.map(toAlertView),
      audit: audit.slice(0, 100).map(toAuditView),
      notices
    };
  }

  private async unlock(): Promise<void> {
    if (this.quitting || this.lifecycleState !== "running" || this.active) return;
    this.storageError = undefined;
    this.mcpError = undefined;
    try {
      const activeRuntime = await this.runtime.acquire();
      if (!activeRuntime) return;
      this.storageState = "unlocked";
      this.mcpError = activeRuntime.mcpError;
    } catch (error) {
      this.storageState = "unavailable";
      this.storageError = `Encrypted storage is unavailable; financial queries remain locked. ${
        error instanceof Error ? error.message : "Unknown storage error."
      }`;
      if (this.configuration.environment !== "production") console.error("Encrypted runtime startup failed", error);
    }
  }

  private async stageRuntime(): Promise<ActiveRuntime> {
    this.dataOwnershipReady = await initializeLocalDataOwnership(this.localDataTargets());
    await mkdir(this.configuration.storage.dataDirectory, { recursive: true });
    const encrypted = await this.openEncryptedRuntime();
    try {
      const active: ActiveCore = this.configuration.demoMode
        ? (() => {
            const demo = createDemoCore({ now: () => new Date() });
            let discardChanges = false;
            return {
              service: demo.service,
              portfolioId: "demo-portfolio-all",
              listAuditEvents: async () => demo.audit.list(),
              accountIdsWithData: async () => {
                const demoAccounts = await demo.store.listAccounts();
                const transactions = await demo.store.listTransactions({ accountIds: demoAccounts.map((account) => account.id) });
                return new Set(transactions.map((transaction) => transaction.source.accountId));
              },
              discardChanges: () => {
                discardChanges = true;
              },
              close: async () => encrypted.store.close({ save: !discardChanges })
            };
          })()
        : (() => {
            let discardChanges = false;
            return {
              service: encrypted.service,
              portfolioId: this.configuration.defaults.portfolioId,
              listAuditEvents: async () => encrypted.audit.listAuditEvents(100),
              accountIdsWithData: async () => {
                const snapshot = await encrypted.store.loadSnapshot();
                return new Set([
                  ...snapshot.transactions.map((transaction) => transaction.source.accountId),
                  ...snapshot.statements.map((statement) => statement.accountId)
                ]);
              },
              addJapanAccount: (input: AddAccountInput) => this.addJapanAccount(encrypted, input),
              renameAccount: (accountId: string, label: string) => this.renameAccount(encrypted, accountId, label),
              disconnectJapanAccount: (accountId: string) => this.disconnectJapanAccount(encrypted, accountId),
              discardChanges: () => {
                discardChanges = true;
              },
              close: async () => encrypted.store.close({ save: !discardChanges })
            };
          })();

      if (this.configuration.mcp.mode === "disabled") return { active };
      if (this.configuration.mcp.authMode === "bearer") {
        return {
          active,
          mcpError:
            "Bearer mode is configured, but the Windows credential-reference resolver is a release gate in this scaffold; MCP remains stopped."
        };
      }

      const mcp = new McpHttpServer(active.service, {
        host: this.configuration.mcp.host,
        port: this.configuration.mcp.port,
        path: this.configuration.mcp.path,
        rateLimitPerMinute: this.configuration.mcp.rateLimitPerMinute
      });
      try {
        await mcp.start();
        return { active, mcp };
      } catch (error) {
        if (this.configuration.environment !== "production") console.error("MCP transport startup failed", error);
        return {
          active,
          mcpError: `The loopback MCP endpoint could not start. ${
            error instanceof Error ? error.message : "Unknown transport error."
          }`
        };
      }
    } catch (error) {
      await encrypted.store.close({ save: false }).catch(() => undefined);
      throw error;
    }
  }

  private async disposeRuntime(resource: ActiveRuntime): Promise<void> {
    try {
      if (resource.mcp) await resource.mcp.stop();
    } finally {
      await resource.active.close();
    }
  }

  private addJapanAccount(encrypted: EncryptedCoreRuntime, input: AddAccountInput): Promise<string> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      if (!portfolio) throw new Error("The owner portfolio is unavailable.");
      const now = new Date().toISOString();
      const accountId = `account-jp-${randomUUID()}`;
      const account: AmexAccount = {
        id: accountId,
        displayName: input.label,
        legalEntityId: `entity-${randomUUID()}`,
        legalEntityName: input.legalEntityName,
        country: "JP",
        currency: "JPY",
        accountClass: input.accountClass,
        businessPurpose: null,
        collectionMethod: "statement_import",
        authorization: { state: "import_only", checkedAt: now },
        active: true,
        createdAt: now,
        updatedAt: now
      };
      await encrypted.store.replaceSnapshotWithAudit({
        ...snapshot,
        accounts: [...snapshot.accounts, account],
        portfolios: snapshot.portfolios.map((candidate) =>
          candidate.id === portfolio.id
            ? { ...candidate, accountIds: [...candidate.accountIds, accountId], updatedAt: now }
            : candidate
        )
      }, {
        id: randomUUID(),
        occurredAt: now,
        action: "account_configured",
        outcome: "success",
        accountIds: [accountId],
        portfolioId: portfolio.id,
        metadata: { country: "JP", accountClass: input.accountClass, collectionMethod: "statement_import" }
      });
      return accountId;
    });
  }

  private renameAccount(encrypted: EncryptedCoreRuntime, accountId: string, label: string): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
      if (!account || !portfolio?.accountIds.includes(accountId)) throw new Error("Account is unavailable in this portfolio.");
      const now = new Date().toISOString();
      await encrypted.store.replaceSnapshotWithAudit({
        ...snapshot,
        accounts: snapshot.accounts.map((candidate) =>
          candidate.id === accountId ? { ...candidate, displayName: label, updatedAt: now } : candidate
        )
      }, {
        id: randomUUID(),
        occurredAt: now,
        action: "account_label_changed",
        outcome: "success",
        accountIds: [accountId],
        portfolioId: portfolio.id,
        metadata: { source: "desktop_ui" }
      });
    });
  }

  private disconnectJapanAccount(encrypted: EncryptedCoreRuntime, accountId: string): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
      if (
        !account ||
        !portfolio?.accountIds.includes(accountId) ||
        account.collectionMethod !== "statement_import"
      ) {
        throw new Error("Import-only account is unavailable in this portfolio.");
      }
      const now = new Date().toISOString();
      await encrypted.store.replaceSnapshotWithAudit({
        ...snapshot,
        accounts: snapshot.accounts.map((candidate) =>
          candidate.id === accountId ? { ...candidate, active: false, updatedAt: now } : candidate
        )
      }, {
        id: randomUUID(),
        occurredAt: now,
        action: "account_disconnected",
        outcome: "success",
        accountIds: [accountId],
        portfolioId: portfolio.id,
        metadata: { retainedEncryptedData: true, collectionMethod: "statement_import" }
      });
    });
  }

  private enqueueCoreWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lifecycleState !== "running" || this.quitting) {
      return Promise.reject(new Error("The local store is locking or closing and cannot accept account changes."));
    }
    const execution = this.commandTail.then(operation, operation);
    this.commandTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }

  private async openEncryptedRuntime(): Promise<EncryptedCoreRuntime> {
    const encrypted = await openEncryptedCore({
      filePath: this.configuration.storage.databasePath,
      keyProtector: createElectronSafeStorageKeyProtector(),
      locateFile: (fileName) => resolve(__dirname, "../vendor", fileName)
    });
    return initializeEncryptedRuntime(encrypted, this.configuration.defaults.portfolioId);
  }

  private registerIpc(): void {
    ipcMain.handle(IPC.getSnapshot, async (event) => {
      this.assertTrustedIpcSender(event);
      return this.getSnapshot();
    });
    ipcMain.handle(IPC.performAction, async (event, request: unknown) => {
      this.assertTrustedIpcSender(event);
      const parsed = parseDesktopRequest(request);
      if (!parsed) throw new Error("Unsupported desktop action.");
      return this.performRequest(parsed);
    });
  }

  private assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
    const window = this.window;
    const expectedUrl = window?.webContents.getURL();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      expectedUrl === undefined ||
      expectedUrl.length === 0 ||
      event.senderFrame.url !== expectedUrl
    ) {
      throw new Error("Rejected an IPC request outside the trusted dashboard frame.");
    }
  }

  private async performRequest(request: DesktopRequest): Promise<DesktopActionResult> {
    if (typeof request === "string") return this.performAction(request);
    if (this.lifecycleState !== "running" || this.quitting) {
      return { ok: false, message: "The local store is locking or closing. No account setting was changed." };
    }
    const active = this.active;
    if (!active) return { ok: false, message: "Unlock the encrypted local store before changing account settings." };

    switch (request.kind) {
      case "add-account": {
        if (request.country === "US") {
          await dialog.showMessageBox(this.window!, {
            type: "info",
            title: "U.S. consent is not configured",
            message: "No account was added and no sign-in was started.",
            detail:
              "U.S. personal and company cards require an approved read-only consent provider. This scaffold has no live provider adapter and never asks for an Amex password."
          });
          return { ok: false, message: "U.S. account setup remains unavailable until an approved provider is configured." };
        }
        if (!active.addJapanAccount) {
          return { ok: false, message: "Synthetic demo accounts cannot be changed. Use an empty local installation for setup." };
        }
        let accountId: string;
        try {
          accountId = await active.addJapanAccount({
            accountClass: request.accountClass,
            label: request.label,
            legalEntityName: request.legalEntityName
          });
        } catch (error) {
          return this.handleAccountWriteFailure(active, error);
        }
        return {
          ok: true,
          message: `Added ${request.label} as an import-only Japan ${request.accountClass} account (${formatLocalIdentifier(accountId)}). No Amex credentials were requested.`
        };
      }
      case "rename-account":
        if (!active.renameAccount) {
          return { ok: false, message: "Synthetic demo labels are fixed and cannot be saved." };
        }
        try {
          await active.renameAccount(request.accountId, request.label);
        } catch (error) {
          return this.handleAccountWriteFailure(active, error);
        }
        return { ok: true, message: "The encrypted local account label was updated." };
      case "disconnect-account": {
        const account = (await active.service.listAccounts({ portfolioId: active.portfolioId })).find(
          (candidate) => candidate.id === request.accountId
        );
        if (!account) return { ok: false, message: "That account is not in the selected local portfolio." };
        if (account.collectionMethod === "provider") {
          return {
            ok: false,
            message: "No live U.S. provider connection exists in this scaffold. A future disconnect must revoke provider consent and delete its protected token."
          };
        }
        if (!active.disconnectJapanAccount) {
          return { ok: false, message: "Synthetic demo accounts cannot be disconnected." };
        }
        const confirmation = await dialog.showMessageBox(this.window!, {
          type: "warning",
          title: "Disconnect this import-only account?",
          message: `Disconnect ${account.displayName}?`,
          detail:
            "Future ChatGPT reads for this account will stop. Existing encrypted statement history is retained unless you separately use Delete local financial data.",
          buttons: ["Cancel", "Disconnect"],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        });
        if (confirmation.response !== 1) return { ok: false, message: "Disconnect canceled." };
        try {
          await active.disconnectJapanAccount(account.id);
        } catch (error) {
          return this.handleAccountWriteFailure(active, error);
        }
        return { ok: true, message: "The Japan import-only account is disconnected; its encrypted local data was retained." };
      }
    }
  }

  private async handleAccountWriteFailure(active: ActiveCore, error: unknown): Promise<DesktopActionResult> {
    active.discardChanges();
    await this.commandTail;
    await this.runtime.release().catch(() => undefined);
    this.storageState = "unavailable";
    this.mcpError = undefined;
    this.storageError = "An account setting could not be saved atomically. The in-memory store was discarded and financial queries remain locked.";
    if (this.configuration.environment !== "production") console.error("Encrypted account mutation failed", error);
    return { ok: false, message: this.storageError };
  }

  private async performAction(action: DesktopAction): Promise<DesktopActionResult> {
    if (this.lifecycleState !== "running" || this.quitting) {
      return { ok: false, message: "The local store is locking or closing. No action was started." };
    }
    switch (action) {
      case "refresh":
        return { ok: true, message: "Local status refreshed." };
      case "authorize-us-account":
        await dialog.showMessageBox(this.window!, {
          type: "info",
          title: "U.S. consent adapter not configured",
          message: "No authorization was started.",
          detail:
            "Enable only a reviewed consent-based read-only provider adapter. This app never asks for or stores an Amex password."
        });
        return { ok: false, message: "U.S. authorization remains disabled until an approved provider is configured." };
      case "import-jp-statement":
        return this.selectStatementFile();
      case "prepare-export":
        await dialog.showMessageBox(this.window!, {
          type: "info",
          title: "Export preview requires mapping",
          message: "No file was created.",
          detail:
            "Choose an account/entity mapping, reconcile the statement, review duplicate candidates, and approve the exact preview before generating a QuickBooks or Money Forward package."
        });
        return { ok: false, message: "No export was created; exact human approval is required." };
      case "open-data-folder":
        return this.openFolder(this.configuration.storage.dataDirectory, "Opened the local data folder.");
      case "open-export-folder":
        return this.openFolder(this.configuration.storage.exportDirectory, "Opened the export folder.");
      case "open-log-folder":
        return this.openFolder(this.configuration.storage.logDirectory, "Opened the local log folder.");
      case "open-tunnel-docs":
        await shell.openExternal(TUNNEL_DOCS);
        return { ok: true, message: "Opened the official Secure MCP Tunnel documentation." };
      case "run-safe-test-drive": {
        const snapshot = await this.getSnapshot();
        const testDrive = runLocalTestDrive({
          storageState: snapshot.storage.state,
          mcpState: snapshot.mcp.state,
          mcpExposure: snapshot.mcp.exposure,
          toolCount: snapshot.mcp.toolCount
        });
        return {
          ok: testDrive.passed,
          message: testDrive.passed
            ? "Local test drive passed. Synthetic input was discarded and no account data was saved."
            : "The local test drive found an item that needs attention. Review the checks below.",
          testDrive
        };
      }
      case "delete-all-local-data":
        return this.deleteAllLocalData();
      case "lock":
        await this.lock();
        return { ok: true, message: "Local data locked and the MCP endpoint stopped." };
    }
  }

  private async deleteAllLocalData(): Promise<DesktopActionResult> {
    const warning = await dialog.showMessageBox(this.window!, {
      type: "warning",
      title: "Preview local financial-data deletion?",
      message: "The app will lock, stop its local MCP endpoint, and inventory only paths explicitly marked as owned by this installation.",
      detail:
        "This does not clear onboarding preferences, revoke external provider consent, delete copies stored elsewhere, or remove tunnel-client profiles.",
      buttons: ["Cancel", "Continue"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (warning.response !== 1) return { ok: false, message: "Local data deletion canceled." };
    if (this.lifecycleState !== "running" || this.quitting) {
      return { ok: false, message: "Cleanup was not started because the local store is already locking or closing." };
    }

    this.lifecycleState = "deleting";
    try {
      await this.commandTail;
      await this.runtime.release();
      this.storageState = "locked";
      this.storageError = undefined;
      this.mcpError = undefined;
      if (!this.dataOwnershipReady) {
        this.lifecycleState = "running";
        await this.unlock();
        return {
          ok: false,
          message: "Cleanup is unavailable because the configured folders are not exclusively marked as owned by this app. Nothing was deleted."
        };
      }

      const inventory = await inventoryLocalDataTargets(this.localDataTargets());
      const confirmation = await dialog.showMessageBox(this.window!, {
        type: "warning",
        title: "Final confirmation",
        message: `Delete ${inventory.fileCount} app-owned file${inventory.fileCount === 1 ? "" : "s"} (${formatBytes(inventory.totalBytes)})?`,
        detail: [
          "Only the encrypted database and the app-marked imports, exports, and logs shown below will be removed:",
          ...inventory.paths,
          "Onboarding preferences, external consent, tunnel profiles, and copies outside these paths will remain."
        ].join("\n"),
        buttons: ["Cancel", "Delete local financial data"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) {
        this.lifecycleState = "running";
        await this.unlock();
        return { ok: false, message: "Local financial-data deletion canceled; the encrypted store was reopened." };
      }

      const deleted = await deleteLocalDataTargets(this.localDataTargets());
      this.dataOwnershipReady = false;
      return {
        ok: true,
        message: `Deleted ${deleted.fileCount} app-owned local financial-data file${deleted.fileCount === 1 ? "" : "s"}. Onboarding preferences and external data were not changed; restart the app to create a new empty store.`
      };
    } catch (error) {
      this.storageState = "unavailable";
      this.storageError = "Local financial-data cleanup failed closed; no broader path was deleted.";
      if (this.configuration.environment !== "production") console.error("Local data cleanup failed", error);
      return { ok: false, message: this.storageError };
    } finally {
      if (!this.quitting) this.lifecycleState = "running";
    }
  }

  private async selectStatementFile(): Promise<DesktopActionResult> {
    const result = await dialog.showOpenDialog(this.window!, {
      title: "Choose an official Japan Amex statement export",
      properties: ["openFile"],
      filters: [
        { name: "Supported statement exports", extensions: ["csv", "xlsx", "qif", "pdf"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    const selected = result.filePaths[0];
    if (result.canceled || !selected) return { ok: false, message: "Statement selection canceled." };

    const extension = extname(selected).toLowerCase();
    const allowed = new Set(this.configuration.raw.AMEX_JP_ALLOWED_EXTENSIONS.split(",").map((value) => value.trim().toLowerCase()));
    const fileStats = await stat(selected);
    const maximumBytes = this.configuration.raw.AMEX_JP_IMPORT_MAX_MB * 1024 * 1024;
    if (!fileStats.isFile() || !allowed.has(extension) || fileStats.size > maximumBytes) {
      return { ok: false, message: "The selected file failed the local extension, type, or size policy." };
    }

    return {
      ok: true,
      message:
        "File selected for local preview only. Choose a target account and review parsed totals before any import is committed.",
      selectedFile: { name: basename(selected), size: fileStats.size, extension }
    };
  }

  private async openFolder(path: string, message: string): Promise<DesktopActionResult> {
    await mkdir(path, { recursive: true });
    const error = await shell.openPath(path);
    return error ? { ok: false, message: "Windows could not open the requested local folder." } : { ok: true, message };
  }

  private localDataTargets() {
    return {
      dataDirectory: this.configuration.storage.dataDirectory,
      databasePath: this.configuration.storage.databasePath,
      importDirectory: this.configuration.storage.importDirectory,
      exportDirectory: this.configuration.storage.exportDirectory,
      logDirectory: this.configuration.storage.logDirectory
    };
  }
}

function tunnelView(configuration: AppConfiguration): DesktopSnapshot["tunnel"] {
  const configured = Boolean(configuration.tunnel.tunnelId && configuration.tunnel.clientPath);
  const state: DesktopSnapshot["tunnel"]["state"] = !configuration.tunnel.enabled
    ? "disabled"
    : !configured
      ? "not-configured"
      : "manual";
  return {
    enabled: configuration.tunnel.enabled,
    autoStart: configuration.tunnel.autoStart,
    configured,
    state,
    ...(configuration.tunnel.tunnelId ? { tunnelIdHint: maskIdentifier(configuration.tunnel.tunnelId) } : {})
  };
}

function toAccountView(account: AmexAccount, hasImportedData: boolean): AccountSummaryView {
  const authorizationState = account.authorization.state;
  const queryReady =
    account.active &&
    (account.collectionMethod === "provider" ? authorizationState === "authorized" : hasImportedData);
  return {
    id: account.id,
    name: account.displayName,
    legalEntity: account.legalEntityName,
    country: account.country,
    currency: account.currency,
    accountClass: account.accountClass,
    authorizationState,
    syncState: !account.active
      ? "disconnected"
      : authorizationState === "authorized"
        ? "authorization_ready"
        : authorizationState === "import_only" && hasImportedData
          ? "import_data_available"
          : authorizationState === "import_only"
            ? "awaiting_first_import"
          : "attention_required",
    localIdentifier: formatLocalIdentifier(account.id),
    connectionType: account.collectionMethod === "provider" ? "read_only_consent" : "official_statement_import",
    active: account.active,
    queryReady
  };
}

function toAlertView(alert: FraudAlert): AlertSummaryView {
  return {
    id: alert.id,
    accountId: alert.accountId,
    title: alert.title,
    severity: alert.severity,
    status: alert.status,
    detectedAt: alert.detectedAt,
    explanation: alert.explanation
  };
}

function toAuditView(event: AuditEvent): AuditSummaryView {
  const target = event.portfolioId ?? (event.accountIds.join(", ") || "local application");
  return {
    id: event.id,
    occurredAt: event.occurredAt,
    action: event.action,
    outcome: event.outcome,
    target
  };
}

function maskIdentifier(value: string): string {
  if (value.length <= 10) return "configured";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}

function formatLocalIdentifier(value: string): string {
  return value.length <= 14 ? `Local ID ${value}` : `Local ID ${value.slice(0, 7)}…${value.slice(-4)}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function parseDesktopRequest(value: unknown): DesktopRequest | undefined {
  if (typeof value === "string") return VALID_ACTIONS.has(value as DesktopAction) ? (value as DesktopAction) : undefined;
  if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "add-account") {
    if (
      !["US", "JP"].includes(String(candidate.country)) ||
      !["personal", "company"].includes(String(candidate.accountClass)) ||
      !isSafeLabel(candidate.label, 80) ||
      !isSafeLabel(candidate.legalEntityName, 120)
    ) {
      return undefined;
    }
    return {
      kind: "add-account",
      country: candidate.country as "US" | "JP",
      accountClass: candidate.accountClass as "personal" | "company",
      label: (candidate.label as string).trim(),
      legalEntityName: (candidate.legalEntityName as string).trim()
    };
  }
  if (candidate.kind === "rename-account") {
    if (!isSafeIdentifier(candidate.accountId) || !isSafeLabel(candidate.label, 80)) return undefined;
    return {
      kind: "rename-account",
      accountId: candidate.accountId as string,
      label: (candidate.label as string).trim()
    };
  }
  if (candidate.kind === "disconnect-account") {
    if (!isSafeIdentifier(candidate.accountId)) return undefined;
    return { kind: "disconnect-account", accountId: candidate.accountId as string };
  }
  return undefined;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isSafeLabel(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}
