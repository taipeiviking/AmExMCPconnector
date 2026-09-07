import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
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
  buildImportPreview,
  canonicalCurrencyAmount,
  detectReviewOnlyAlerts,
  DurableExportWorkflow,
  EncryptedDirectoryExportJournal,
  HmacExportApprovalAuthority,
  HUMAN_EXPORT_CONFIRMATION_PHRASE,
  parseStatementFile,
  type AmexAccount,
  type AuditEvent,
  type EncryptedCoreRuntime,
  type ExportMapping,
  type ExportPreview,
  type FinancialTransaction,
  type FinanceQueryService,
  type FraudAlert,
  type ImportPreview,
  type ParsedTransactionImport,
  type Portfolio,
  type Statement,
  type StatementBalanceInput,
  type DurableExportMaterializationResult
} from "../core";
import { createElectronSafeStorageKeyProtector, isStorageError } from "../storage";
import { WindowsGenericCredentialResolver } from "../security/windows-generic-credential-resolver";
import { WindowsGenericCredentialStore } from "../security/windows-generic-credential-store";
import {
  SecretReferenceError,
  type SecretReferenceResolver,
  type SecretReferenceStore
} from "../security/secret-reference";
import {
  EncryptedProviderBindingStore,
  EncryptedVaultProviderTokenStore,
  GenericProviderOAuthClient,
  GenericReadOnlyProviderHttpClient,
  PLAID_PROVIDER_ID,
  PlaidApiClient,
  PlaidHostedLinkProvider,
  PlaidReadOnlyFinancialProvider,
  ProviderIntegrationError,
  UsProviderSyncService,
  assertCompatibleProviderAccount,
  normalizedV1ReadOnlyScopes,
  parseNormalizedV1Accounts,
  startLoopbackOAuthCallbackListener,
  type LoopbackOAuthCallbackSession,
  type NormalizedV1ProviderAccount,
  type ProviderAuthorizationStatus,
  type ProviderDisconnectResult,
  type PreparedProviderRevocation,
  type UsProviderSyncResult
} from "../integrations";
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
  ArgumentTemplateOutboundTunnelAdapter,
  TunnelClientSupervisor,
  type TunnelClientStatus
} from "./tunnel-client-supervisor";
import {
  deleteLocalDataTargets,
  initializeLocalDataOwnership,
  inventoryLocalDataTargets
} from "./data-deletion";
import {
  applyConfiguredCategoryMapping,
  assertCategoryMappingUnchanged
} from "./category-mapping-workflow";
import { preflightUsProvider } from "./us-provider-readiness";
import { presentImportPreview } from "./import-preview-presentation";
import {
  readPlaidProviderSettings,
  writePlaidProviderSettings,
  type PlaidEnvironment
} from "./plaid-provider-settings";
import { assertImportSourceUnchanged } from "./import-source-verifier";
import {
  configureOwnerPortfolio,
  removeAccountFromQueryPortfolios,
  setOwnerAlertDisposition,
  type OwnerAlertDisposition
} from "./local-management";

const CUSTOM_MCP_DOCS = "https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta";
const PLAID_DASHBOARD = "https://dashboard.plaid.com/signup";
const VALID_ACTIONS = new Set<DesktopAction>([
  "refresh",
  "authorize-us-account",
  "import-jp-statement",
  "prepare-export",
  "open-data-folder",
  "open-export-folder",
  "open-log-folder",
  "open-tunnel-docs",
  "open-plaid-dashboard",
  "preflight-us-provider",
  "run-safe-test-drive",
  "save-synthetic-sample-statement",
  "delete-all-local-data",
  "lock"
]);

interface ActiveCore {
  service: FinanceQueryService;
  portfolioId: string;
  listAllAccounts: () => Promise<readonly AmexAccount[]>;
  getPortfolio: () => Promise<Portfolio | undefined>;
  listAuditEvents: () => Promise<readonly AuditEvent[]>;
  appendAudit?: (event: AuditEvent) => Promise<void>;
  accountIdsWithData: () => Promise<ReadonlySet<string>>;
  addJapanAccount?: (input: AddAccountInput) => Promise<string>;
  addUsAccount?: (input: AddAccountInput) => Promise<string>;
  renameAccount?: (accountId: string, label: string) => Promise<void>;
  updatePortfolio?: (name: string, accountIds: readonly string[]) => Promise<void>;
  setAlertDisposition?: (alertId: string, status: OwnerAlertDisposition) => Promise<void>;
  disconnectJapanAccount?: (accountId: string) => Promise<void>;
  disconnectUsAccount?: (accountId: string) => Promise<void>;
  setProviderBinding?: (accountId: string, binding: ProviderBinding) => Promise<void>;
  getProviderBinding?: (accountId: string) => Promise<ProviderBinding | undefined>;
  setProviderAuthorization?: (accountId: string, status: ProviderAuthorizationStatus) => Promise<void>;
  syncUsAccount?: (provider: UsProviderRuntime, accountId: string) => Promise<UsProviderSyncResult>;
  previewJapanImport?: (input: JapanImportPreviewInput) => Promise<JapanImportCandidate>;
  commitJapanImport?: (candidate: JapanImportCandidate) => Promise<JapanImportCommitResult>;
  previewExport?: (request: PrepareExportRequest) => Promise<ExportCandidate>;
  materializeExport?: (
    candidate: ExportCandidate,
    destinationDirectory: string
  ) => Promise<ExportMaterializationOutcome>;
  discardChanges: () => void;
  close: () => Promise<void>;
}

interface AddAccountInput {
  accountClass: "personal" | "company";
  label: string;
  legalEntityName: string;
}

interface JapanImportPreviewInput {
  readonly accountId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly statementBalance?: StatementBalanceInput;
}

interface JapanImportCandidate {
  readonly accountId: string;
  readonly fileName: string;
  readonly parsed: ParsedTransactionImport;
  readonly preview: ImportPreview;
  readonly baselineDigest: string;
  readonly categoryMappingFingerprint?: string;
  readonly categoryMappingsApplied: number;
  readonly statementBalance?: StatementBalanceInput;
}

interface PendingJapanImport {
  readonly candidate: JapanImportCandidate;
  readonly selectedPath: string;
  readonly byteLength: number;
  readonly modifiedAtMs: number;
  readonly maximumBytes: number;
  readonly expiresAt: string;
}

interface JapanImportCommitResult {
  readonly imported: number;
  readonly duplicatesSkipped: number;
  readonly warningCount: number;
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

type PrepareExportRequest = Extract<DesktopRequest, { kind: "prepare-export" }>;

interface ExportCandidate {
  readonly account: AmexAccount;
  readonly preview: ExportPreview;
  readonly request: PrepareExportRequest;
}

interface ExportMaterializationOutcome extends DurableExportMaterializationResult {
  readonly auditStatus: "recorded" | "unconfirmed";
  readonly auditFailureCode?: string;
}

interface ExportRuntime {
  readonly workflow: DurableExportWorkflow;
  readonly journal: EncryptedDirectoryExportJournal;
  readonly approvalAuthority: HmacExportApprovalAuthority;
}

interface ProviderBinding {
  readonly providerAccountId: string;
  readonly lastFour?: string;
}

interface SharedUsProviderRuntime {
  readonly providerId: string;
  readonly tokens: EncryptedVaultProviderTokenStore;
  readonly bindings: EncryptedProviderBindingStore;
  readonly sync: UsProviderSyncService;
}

type UsProviderRuntime =
  | (SharedUsProviderRuntime & {
      readonly kind: "generic-loopback";
      readonly oauth: GenericProviderOAuthClient;
      readonly financial: GenericReadOnlyProviderHttpClient;
    })
  | (SharedUsProviderRuntime & {
      readonly kind: "plaid-hosted-link";
      readonly oauth: PlaidHostedLinkProvider;
      readonly financial: PlaidReadOnlyFinancialProvider;
    });

interface ActiveRuntime {
  active: ActiveCore;
  mcp?: McpHttpServer;
  tunnel?: TunnelClientSupervisor;
  provider?: UsProviderRuntime;
  providerError?: string;
  mcpError?: string;
  tunnelError?: string;
}

export interface DesktopControllerOptions {
  readonly screenshotControlAvailable?: boolean;
}

export class DesktopController {
  private window?: BrowserWindow;
  private tray?: Tray;
  private readonly runtime: SingleFlightResource<ActiveRuntime>;
  private storageState: DesktopSnapshot["storage"]["state"] = "locked";
  private storageError?: string;
  private mcpError?: string;
  private tunnelError?: string;
  private providerError?: string;
  private quitting = false;
  private commandTail: Promise<void> = Promise.resolve();
  private lifecycleState: "running" | "locking" | "deleting" | "quitting" = "running";
  private dataOwnershipReady = false;
  private autoLockTimer?: NodeJS.Timeout;
  private readonly providerOperations = new Set<Promise<unknown>>();
  private readonly consentSessions = new Map<string, LoopbackOAuthCallbackSession>();
  private consentOwnerAccountId?: string;
  private readonly pendingJapanImports = new Map<string, PendingJapanImport>();
  private readonly screenshotControlAvailable: boolean;
  private screenshotProtectionEnabled: boolean;
  private plaidEnvironment: PlaidEnvironment;
  private plaidRedirectUri?: string;

  constructor(
    private readonly configuration: AppConfiguration,
    options: DesktopControllerOptions = {}
  ) {
    this.screenshotControlAvailable =
      options.screenshotControlAvailable ?? configuration.environment !== "production";
    this.screenshotProtectionEnabled = configuration.screenshotProtection;
    this.plaidEnvironment = configuration.raw.AMEX_US_AGGREGATOR_ENVIRONMENT;
    this.plaidRedirectUri = configuration.raw.AMEX_US_PLAID_REDIRECT_URI;
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

  private get tunnel(): TunnelClientSupervisor | undefined {
    return this.runtime.current?.tunnel;
  }

  private get provider(): UsProviderRuntime | undefined {
    return this.runtime.current?.provider;
  }

  async start(): Promise<void> {
    this.registerIpc();
    // Finish the first encrypted-runtime attempt before loading the renderer so
    // its initial snapshot cannot become permanently stale at "zero accounts".
    await this.unlock();
    this.window = createDashboardWindow({
      screenshotProtection: this.screenshotProtectionEnabled,
      devTools: this.configuration.environment !== "production" && !app.isPackaged,
      onRequestClose: () => this.window?.hide()
    });
    this.tray = createTrayController({
      showDashboard: () => void this.showDashboard(),
      lock: () => void this.lock(),
      quit: () => void this.quit(),
      statusLabel: () => `MCP: ${this.mcp?.status.state ?? "stopped"}`
    });

    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: this.configuration.startWithWindows });

    if (!this.configuration.startMinimized) await this.showDashboard();
  }

  async showDashboard(): Promise<void> {
    if (this.quitting || this.lifecycleState !== "running") return;
    if (!this.active) await this.unlock();
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
    this.clearAutoLockTimer();
    this.window?.hide();
    try {
      await this.cutExternalInterfaces(this.runtime.current);
      await this.commandTail;
      await this.runtime.release();
      this.storageState = "locked";
      this.storageError = undefined;
      this.mcpError = undefined;
      this.tunnelError = undefined;
      this.providerError = undefined;
    } finally {
      if (!this.quitting) this.lifecycleState = "running";
    }
  }

  async quit(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.lifecycleState = "quitting";
    this.clearAutoLockTimer();
    ipcMain.removeHandler(IPC.getSnapshot);
    ipcMain.removeHandler(IPC.performAction);
    await this.cutExternalInterfaces(this.runtime.current);
    await this.commandTail;
    await this.runtime.release().catch(() => undefined);
    this.tray?.destroy();
    this.window?.destroy();
    app.exit(0);
  }

  async getSnapshot(): Promise<DesktopSnapshot> {
    this.touchActivity();
    const active = this.active;
    const notices: string[] = [];
    if (this.configuration.demoMode) {
      notices.push("Synthetic demo records are enabled explicitly and remain separate from the encrypted production store.");
    }
    // An unconfigured U.S. provider is an expected first-run capability state,
    // not an error worth interrupting every screen with. The Getting Started
    // and Accounts pages show that state persistently with actionable guidance.
    if (!this.dataOwnershipReady) {
      notices.push("Destructive cleanup is disabled because the configured data folders could not be proven app-owned.");
    }
    if (this.storageError) notices.push(this.storageError);
    if (this.mcpError) notices.push(this.mcpError);
    if (this.tunnelError) notices.push(this.tunnelError);
    if (this.providerError) notices.push(this.providerError);

    let accounts: AmexAccount[] = [];
    let portfolio: Portfolio | undefined;
    let accountIdsWithData: ReadonlySet<string> = new Set();
    let alerts: FraudAlert[] = [];
    let audit: AuditEvent[] = [];
    if (active) {
      try {
        accounts = [...(await active.listAllAccounts())];
        portfolio = await active.getPortfolio();
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
      portfolio: {
        id: portfolio?.id ?? (active?.portfolioId ?? this.configuration.defaults.portfolioId),
        name: portfolio?.name ?? "Owner-selected local portfolio",
        accountIds: [...(portfolio?.accountIds ?? [])],
        editable: !this.configuration.demoMode && this.storageState === "unlocked"
      },
      baseCurrency: this.configuration.defaults.baseCurrency,
      storage: {
        state: this.storageState,
        protection: "AES-256-GCM database · Windows safeStorage/DPAPI-wrapped key",
        dataDirectory: this.configuration.storage.dataDirectory
      },
      privacy: {
        screenshotProtectionEnabled: this.screenshotProtectionEnabled,
        screenshotControlAvailable: this.screenshotControlAvailable,
        settingScope: "session"
      },
      mcp: {
        state: this.mcp?.status.state ?? "stopped",
        ...(this.mcp?.status.endpoint ? { endpoint: this.mcp.status.endpoint } : {}),
        toolCount: 7,
        exposure: "loopback-only"
      },
      tunnel: tunnelView(this.configuration, this.tunnel?.status),
      provider: {
        configured: this.provider !== undefined,
        adapter: this.configuration.raw.AMEX_US_AGGREGATOR,
        environment: this.plaidEnvironment,
        setupSupported: this.configuration.raw.AMEX_US_AGGREGATOR === "plaid"
      },
      accounts: accounts.map((account) =>
        toAccountView(account, accountIdsWithData.has(account.id), portfolio?.accountIds.includes(account.id) ?? false)
      ),
      alerts: alerts.map(toAlertView),
      audit: audit.slice(0, 100).map(toAuditView),
      notices
    };
  }

  private async unlock(): Promise<void> {
    if (this.quitting || this.lifecycleState !== "running" || this.active) return;
    this.storageError = undefined;
    this.mcpError = undefined;
    this.tunnelError = undefined;
    this.providerError = undefined;
    try {
      const activeRuntime = await this.runtime.acquire();
      if (!activeRuntime) return;
      this.storageState = "unlocked";
      this.mcpError = activeRuntime.mcpError;
      this.tunnelError = activeRuntime.tunnelError;
      this.providerError = activeRuntime.providerError;
      this.touchActivity();
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
    let providerSettingsError: string | undefined;
    if (this.configuration.raw.AMEX_US_AGGREGATOR === "plaid") {
      try {
        const settings = await readPlaidProviderSettings(
          this.configuration.storage.dataDirectory,
          this.configuration.raw.AMEX_US_AGGREGATOR_ENVIRONMENT,
          this.configuration.raw.AMEX_US_PLAID_REDIRECT_URI
        );
        this.plaidEnvironment = settings.environment;
        this.plaidRedirectUri = settings.redirectUri;
      } catch {
        providerSettingsError =
          "The saved Plaid environment setting is invalid. Open U.S. personal setup and save it again.";
      }
    }
    const encrypted = await this.openEncryptedRuntime();
    const providerTokens = new EncryptedVaultProviderTokenStore(
      encrypted.secrets,
      async () => await encrypted.database.save()
    );
    const providerBindings = new EncryptedProviderBindingStore(
      encrypted.secrets,
      async () => await encrypted.database.save()
    );
    let exportRuntime: ExportRuntime | undefined;
    let provider: UsProviderRuntime | undefined;
    let providerError: string | undefined = providerSettingsError;
    try {
      if (!this.configuration.demoMode) exportRuntime = await this.openExportRuntime(encrypted);
      if (
        !this.configuration.demoMode &&
        this.configuration.raw.AMEX_US_AGGREGATOR !== "disabled" &&
        providerSettingsError === undefined
      ) {
        try {
          provider = this.createUsProviderRuntime(encrypted, providerTokens, providerBindings);
        } catch (error) {
          providerError = `The configured U.S. provider runtime was rejected. ${
            error instanceof Error ? error.message : "Unknown provider configuration error."
          }`;
        }
      }
      const active: ActiveCore = this.configuration.demoMode
        ? (() => {
            const demo = createDemoCore({ now: () => new Date() });
            let discardChanges = false;
            return {
              service: demo.service,
              portfolioId: "demo-portfolio-all",
              listAllAccounts: async () => demo.store.listAccounts(),
              getPortfolio: async () => demo.store.getPortfolio("demo-portfolio-all"),
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
              listAllAccounts: async () => encrypted.store.listAccounts(),
              getPortfolio: async () => encrypted.store.getPortfolio(this.configuration.defaults.portfolioId),
              listAuditEvents: async () => encrypted.audit.listAuditEvents(100),
              appendAudit: (event: AuditEvent) => encrypted.audit.append(event),
              accountIdsWithData: async () => {
                const snapshot = await encrypted.store.loadSnapshot();
                return new Set([
                  ...snapshot.transactions.map((transaction) => transaction.source.accountId),
                  ...snapshot.statements.map((statement) => statement.accountId)
                ]);
              },
              addJapanAccount: (input: AddAccountInput) => this.addJapanAccount(encrypted, input),
              disconnectUsAccount: (accountId: string) =>
                this.disconnectUsAccount(
                  encrypted,
                  provider?.providerId ?? this.configuration.raw.AMEX_US_AGGREGATOR,
                  providerTokens,
                  providerBindings,
                  accountId
                ),
              ...(provider === undefined
                ? {}
                : {
                    addUsAccount: (input: AddAccountInput) => this.addUsAccount(encrypted, input),
                    setProviderBinding: (accountId: string, binding: ProviderBinding) =>
                      provider!.bindings.put(provider!.providerId, accountId, binding),
                    getProviderBinding: (accountId: string) =>
                      provider!.bindings.get(provider!.providerId, accountId),
                    setProviderAuthorization: (accountId: string, status: ProviderAuthorizationStatus) =>
                      this.setProviderAuthorization(encrypted, provider!, accountId, status),
                    syncUsAccount: (_provider: UsProviderRuntime, accountId: string) =>
                      this.enqueueCoreWrite(() => provider!.sync.sync(accountId))
                  }),
              renameAccount: (accountId: string, label: string) => this.renameAccount(encrypted, accountId, label),
              updatePortfolio: (name: string, accountIds: readonly string[]) =>
                this.updatePortfolio(encrypted, name, accountIds),
              setAlertDisposition: (alertId: string, status: OwnerAlertDisposition) =>
                this.setAlertDisposition(encrypted, alertId, status),
              disconnectJapanAccount: (accountId: string) => this.disconnectJapanAccount(encrypted, accountId),
              previewJapanImport: (input: JapanImportPreviewInput) => this.previewJapanImport(encrypted, input),
              commitJapanImport: (candidate: JapanImportCandidate) => this.commitJapanImport(encrypted, candidate),
              previewExport: (request: PrepareExportRequest) => this.previewExport(encrypted, exportRuntime!, request),
              materializeExport: (candidate: ExportCandidate, destinationDirectory: string) =>
                this.materializeExport(encrypted, exportRuntime!, candidate, destinationDirectory),
              discardChanges: () => {
                discardChanges = true;
              },
              close: async () => {
                exportRuntime?.journal.close();
                exportRuntime?.approvalAuthority.close();
                await encrypted.store.close({ save: !discardChanges });
              }
            };
          })();

      const providerFields = {
        ...(provider === undefined ? {} : { provider }),
        ...(providerError === undefined ? {} : { providerError })
      };
      if (this.configuration.mcp.mode === "disabled") return { active, ...providerFields };
      const bearerToken = this.configuration.mcp.authMode === "bearer"
        ? await this.resolveBearerToken()
        : undefined;

      const mcp = new McpHttpServer(active.service, {
        host: this.configuration.mcp.host,
        port: this.configuration.mcp.port,
        path: this.configuration.mcp.path,
        rateLimitPerMinute: this.configuration.mcp.rateLimitPerMinute,
        requestTimeoutMs: this.configuration.mcp.requestTimeoutMs,
        maximumPageSize: this.configuration.mcp.maxPageSize,
        onActivity: () => this.touchActivity(),
        ...(bearerToken === undefined ? {} : { bearerToken })
      });
      try {
        await mcp.start();
        const endpoint = mcp.status.endpoint;
        let tunnel: TunnelClientSupervisor | undefined;
        try {
          tunnel = this.configuration.tunnel.enabled && endpoint
            ? this.createTunnelSupervisor(endpoint)
            : undefined;
        } catch (error) {
          return {
            active,
            mcp,
            ...providerFields,
            tunnelError: `The private tunnel client configuration was rejected. ${error instanceof Error ? error.message : "Unknown configuration error."}`
          };
        }
        if (tunnel && this.configuration.tunnel.autoStart) {
          await tunnel.start().catch((error) => {
            if (this.configuration.environment !== "production") console.error("Tunnel startup failed", error);
          });
        }
        return { active, mcp, ...(tunnel === undefined ? {} : { tunnel }), ...providerFields };
      } catch (error) {
        if (this.configuration.environment !== "production") console.error("MCP transport startup failed", error);
        return {
          active,
          ...providerFields,
          mcpError: `The loopback MCP endpoint could not start. ${
            error instanceof Error ? error.message : "Unknown transport error."
          }`
        };
      }
    } catch (error) {
      exportRuntime?.journal.close();
      exportRuntime?.approvalAuthority.close();
      await encrypted.store.close({ save: false }).catch(() => undefined);
      throw error;
    }
  }

  private async disposeRuntime(resource: ActiveRuntime): Promise<void> {
    try {
      await this.cutExternalInterfaces(resource);
      await Promise.allSettled([...this.providerOperations]);
    } finally {
      await resource.active.close();
    }
  }

  private async cutExternalInterfaces(resource: ActiveRuntime | undefined): Promise<void> {
    this.pendingJapanImports.clear();
    resource?.provider?.financial.abortPending();
    resource?.provider?.oauth.abortPending();
    const sessions = [...this.consentSessions.values()];
    this.consentSessions.clear();
    this.consentOwnerAccountId = undefined;
    await Promise.allSettled([
      ...sessions.map(async (session) => await session.close()),
      ...(resource?.tunnel === undefined ? [] : [resource.tunnel.stop()]),
      ...(resource?.mcp === undefined ? [] : [resource.mcp.stop()])
    ]);
  }

  private createTunnelSupervisor(localMcpEndpoint: string): TunnelClientSupervisor {
    const { clientPath, clientSha256, tunnelId } = this.configuration.tunnel;
    if (!clientPath || !clientSha256 || !tunnelId || this.configuration.tunnel.arguments.length === 0) {
      throw new Error("The private connection is missing its vetted client path, SHA-256, tunnel ID, or argument template.");
    }
    return new TunnelClientSupervisor(
      {
        executablePath: clientPath,
        executableVerification: {
          expectedSha256: clientSha256,
          allowedDirectories: [dirname(clientPath)]
        },
        tunnelId,
        profile: this.configuration.tunnel.profile,
        localMcpEndpoint
      },
      new ArgumentTemplateOutboundTunnelAdapter(
        "openai-secure-mcp",
        this.configuration.tunnel.arguments
      )
    );
  }

  private createUsProviderRuntime(
    encrypted: EncryptedCoreRuntime,
    tokenStore: EncryptedVaultProviderTokenStore,
    bindings: EncryptedProviderBindingStore
  ): UsProviderRuntime {
    const raw = this.configuration.raw;
    if (raw.AMEX_US_AGGREGATOR === "plaid") {
      const clientIdReference = raw.AMEX_US_AGGREGATOR_CLIENT_ID_REF;
      const clientSecretReference = raw.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF;
      if (!clientIdReference || !clientSecretReference) {
        throw new Error("The protected Plaid application credential references are incomplete.");
      }
      const resolver = new WindowsGenericCredentialResolver();
      const api = new PlaidApiClient(
        {
          environment: this.plaidEnvironment,
          clientIdReference,
          secretReference: clientSecretReference,
          requestTimeoutMs: this.configuration.mcp.requestTimeoutMs,
          maximumResponseBytes: raw.AMEX_US_PROVIDER_MAX_RESPONSE_MB * 1024 * 1024
        },
        resolver
      );
      const oauth = new PlaidHostedLinkProvider(
        {
          clientName: "Amex Local Connector",
          ...(this.plaidRedirectUri === undefined ? {} : { redirectUri: this.plaidRedirectUri }),
          transactionHistoryDays: raw.AMEX_US_SYNC_LOOKBACK_DAYS
        },
        api,
        tokenStore
      );
      const financial = new PlaidReadOnlyFinancialProvider(
        {
          maximumPageSize: this.configuration.mcp.maxPageSize,
          defaultLookbackDays: raw.AMEX_US_SYNC_LOOKBACK_DAYS
        },
        api,
        oauth
      );
      const sync = new UsProviderSyncService(encrypted.store, financial, bindings, {
        providerId: PLAID_PROVIDER_ID,
        portfolioId: this.configuration.defaults.portfolioId,
        lookbackDays: raw.AMEX_US_SYNC_LOOKBACK_DAYS,
        pageSize: this.configuration.mcp.maxPageSize,
        alertsEnabled: raw.AMEX_ALERTS_ENABLED,
        highValueUsd: String(raw.AMEX_ALERT_HIGH_VALUE_USD)
      });
      return {
        kind: "plaid-hosted-link",
        providerId: PLAID_PROVIDER_ID,
        oauth,
        financial,
        tokens: tokenStore,
        bindings,
        sync
      };
    }
    if (raw.AMEX_US_AGGREGATOR !== "approved-provider-generic") {
      throw new Error(
        "Only the explicitly configured approved-provider-generic adapter is implemented; no Amex site scraping or guessed API is available."
      );
    }
    const required = {
      apiBaseUrl: raw.AMEX_US_AGGREGATOR_BASE_URL,
      authorizationEndpoint: raw.AMEX_US_OAUTH_AUTHORIZATION_URL,
      tokenEndpoint: raw.AMEX_US_OAUTH_TOKEN_URL,
      clientIdReference: raw.AMEX_US_AGGREGATOR_CLIENT_ID_REF,
      clientSecretReference: raw.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF
    };
    if (Object.values(required).some((value) => value === undefined)) {
      throw new Error("The approved provider endpoints and protected client credential references are incomplete.");
    }
    if (raw.AMEX_US_PROVIDER_RESPONSE_PROFILE !== "normalized_v1") {
      throw new Error("The provider response profile is unsupported.");
    }
    const redirect = new URL(raw.AMEX_US_AGGREGATOR_REDIRECT_URI);
    if (Number(redirect.port) !== raw.AMEX_US_OAUTH_CALLBACK_PORT) {
      throw new Error("The provider redirect URI port must match AMEX_US_OAUTH_CALLBACK_PORT.");
    }
    const configuredScopes = raw.AMEX_US_AGGREGATOR_SCOPES.split(",").map((scope) => scope.trim());
    if (
      configuredScopes.length === 0 ||
      configuredScopes.some((scope) => scope.length === 0) ||
      new Set(configuredScopes).size !== configuredScopes.length
    ) {
      throw new Error("Provider scopes must be a non-empty comma-separated set without duplicates.");
    }
    const scopes = normalizedV1ReadOnlyScopes(configuredScopes);

    const providerId = raw.AMEX_US_AGGREGATOR;
    const resolver = new WindowsGenericCredentialResolver();
    const oauth = new GenericProviderOAuthClient(
      {
        providerId,
        authorizationEndpoint: required.authorizationEndpoint!,
        tokenEndpoint: required.tokenEndpoint!,
        ...(raw.AMEX_US_OAUTH_REVOCATION_URL === undefined
          ? {}
          : { revocationEndpoint: raw.AMEX_US_OAUTH_REVOCATION_URL }),
        clientIdReference: required.clientIdReference!,
        clientSecretReference: required.clientSecretReference!,
        readOnlyScopes: scopes,
        redirectUri: raw.AMEX_US_AGGREGATOR_REDIRECT_URI,
        refreshSkewSeconds: raw.AMEX_US_TOKEN_REFRESH_SKEW_SECONDS,
        requestTimeoutMs: this.configuration.mcp.requestTimeoutMs
      },
      resolver,
      tokenStore
    );
    const financial = new GenericReadOnlyProviderHttpClient(
      {
        providerId,
        apiBaseUrl: required.apiBaseUrl!,
        endpoints: {
          accounts: raw.AMEX_US_API_ACCOUNTS_PATH,
          accountStatus: raw.AMEX_US_API_ACCOUNT_STATUS_PATH,
          transactions: raw.AMEX_US_API_TRANSACTIONS_PATH,
          statements: raw.AMEX_US_API_STATEMENTS_PATH,
          statement: raw.AMEX_US_API_STATEMENT_PATH
        },
        requestTimeoutMs: this.configuration.mcp.requestTimeoutMs,
        maximumResponseBytes: raw.AMEX_US_PROVIDER_MAX_RESPONSE_MB * 1024 * 1024,
        maximumPageSize: this.configuration.mcp.maxPageSize
      },
      oauth
    );
    const sync = new UsProviderSyncService(encrypted.store, financial, bindings, {
      providerId,
      portfolioId: this.configuration.defaults.portfolioId,
      lookbackDays: raw.AMEX_US_SYNC_LOOKBACK_DAYS,
      pageSize: this.configuration.mcp.maxPageSize,
      alertsEnabled: raw.AMEX_ALERTS_ENABLED,
      highValueUsd: String(raw.AMEX_ALERT_HIGH_VALUE_USD)
    });
    return {
      kind: "generic-loopback",
      providerId,
      oauth,
      financial,
      tokens: tokenStore,
      bindings,
      sync
    };
  }

  private async resolveBearerToken(): Promise<string> {
    const reference = this.configuration.mcp.bearerTokenReference;
    if (!reference) throw new Error("The protected MCP bearer-token reference is missing.");
    const resolver = new WindowsGenericCredentialResolver();
    const bytes = await resolver.resolve(reference);
    try {
      const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (token.length < 32 || token.length > 8192 || /[\u0000\r\n]/u.test(token)) {
        throw new Error("The protected MCP bearer token is invalid.");
      }
      return token;
    } finally {
      bytes.fill(0);
    }
  }

  private async openExportRuntime(encrypted: EncryptedCoreRuntime): Promise<ExportRuntime> {
    const namespace = "export-runtime-v1";
    let approvalKey = encrypted.secrets.get(namespace, "approval-hmac");
    let journalKey = encrypted.secrets.get(namespace, "journal-aead");
    let changed = false;
    if (!approvalKey) {
      approvalKey = randomBytes(32);
      encrypted.secrets.put(namespace, "approval-hmac", approvalKey);
      changed = true;
    }
    if (!journalKey) {
      journalKey = randomBytes(32);
      encrypted.secrets.put(namespace, "journal-aead", journalKey);
      changed = true;
    }
    try {
      if (changed) await encrypted.database.save();
      const approvalAuthority = new HmacExportApprovalAuthority(approvalKey);
      const journal = new EncryptedDirectoryExportJournal(
        join(this.configuration.storage.exportDirectory, ".approval-history"),
        journalKey
      );
      return {
        approvalAuthority,
        journal,
        workflow: new DurableExportWorkflow({ approvalAuthority, journal })
      };
    } finally {
      approvalKey.fill(0);
      journalKey.fill(0);
    }
  }

  private async previewExport(
    encrypted: EncryptedCoreRuntime,
    exportRuntime: ExportRuntime,
    request: PrepareExportRequest
  ): Promise<ExportCandidate> {
    const snapshot = await encrypted.store.loadSnapshot();
    const account = snapshot.accounts.find((candidate) => candidate.id === request.accountId);
    if (!account || !account.active) {
      throw new Error("Select an active account on this installation.");
    }
    const transactions = snapshot.transactions.filter(
      (transaction) => transaction.source.accountId === account.id
    );
    if (transactions.length === 0) throw new Error("This account has no local transactions to export.");
    const mapping = buildExportMapping(request, account);
    return {
      account,
      preview: await exportRuntime.workflow.preview({ mapping, transactions }),
      request
    };
  }

  private materializeExport(
    encrypted: EncryptedCoreRuntime,
    exportRuntime: ExportRuntime,
    candidate: ExportCandidate,
    destinationDirectory: string
  ): Promise<ExportMaterializationOutcome> {
    return this.enqueueCoreWrite(async () => {
      const currentSnapshot = await encrypted.store.loadSnapshot();
      const currentAccount = currentSnapshot.accounts.find((account) => account.id === candidate.account.id);
      if (!currentAccount || !currentAccount.active) {
        throw new Error("The selected account changed after preview. Review the export again.");
      }
      const currentTransactions = currentSnapshot.transactions.filter(
        (transaction) => transaction.source.accountId === currentAccount.id
      );
      const currentMapping = buildExportMapping(candidate.request, currentAccount);
      const approval = exportRuntime.workflow.approve({
        preview: candidate.preview,
        approvedBy: "local-owner",
        confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE
      });
      const materialized = await exportRuntime.workflow.materialize({
        preview: candidate.preview,
        approval,
        destinationDirectory,
        currentState: { mapping: currentMapping, transactions: currentTransactions }
      });
      try {
        await encrypted.audit.append({
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          action: "export_package_materialized",
          outcome: "success",
          accountIds: [candidate.account.id],
          portfolioId: this.configuration.defaults.portfolioId,
          metadata: {
            format: candidate.preview.plan.mapping.format,
            exportedTransactions: candidate.preview.duplicateReport.eligibleTransactionCount,
            duplicatesSkipped: candidate.preview.duplicateReport.excludedTransactionCount,
            previewFingerprint: candidate.preview.previewFingerprint,
            manifestFingerprint: materialized.manifestSha256,
            publicationStatus: materialized.publicationStatus,
            journalStatus: materialized.journalStatus,
            automaticPosting: false
          }
        });
        return { ...materialized, auditStatus: "recorded" };
      } catch (error) {
        if (this.configuration.environment !== "production") {
          console.error("Published export audit could not be confirmed", error);
        }
        return {
          ...materialized,
          auditStatus: "unconfirmed",
          auditFailureCode: safeFailureCode(error, "EXPORT_AUDIT_UNCONFIRMED")
        };
      }
    });
  }

  private touchActivity(): void {
    if (this.configuration.storage.autoLockMinutes <= 0 || this.lifecycleState !== "running" || !this.active) return;
    this.clearAutoLockTimer();
    this.autoLockTimer = setTimeout(
      () => void this.lock(),
      this.configuration.storage.autoLockMinutes * 60_000
    );
    this.autoLockTimer.unref?.();
  }

  private clearAutoLockTimer(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    this.autoLockTimer = undefined;
  }

  private addUsAccount(encrypted: EncryptedCoreRuntime, input: AddAccountInput): Promise<string> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      if (!portfolio) throw new Error("The owner portfolio is unavailable.");
      const now = new Date().toISOString();
      const accountId = `account-us-${randomUUID()}`;
      const account: AmexAccount = {
        id: accountId,
        displayName: input.label,
        legalEntityId: `entity-${randomUUID()}`,
        legalEntityName: input.legalEntityName,
        country: "US",
        currency: "USD",
        accountClass: input.accountClass,
        businessPurpose: null,
        collectionMethod: "provider",
        authorization: {
          state: "reauthorization_required",
          checkedAt: now,
          reason: "provider_consent_required"
        },
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
        metadata: {
          country: "US",
          accountClass: input.accountClass,
          collectionMethod: "provider",
          provider: this.configuration.raw.AMEX_US_AGGREGATOR
        }
      });
      return accountId;
    });
  }

  private setProviderAuthorization(
    encrypted: EncryptedCoreRuntime,
    provider: UsProviderRuntime,
    accountId: string,
    status: ProviderAuthorizationStatus
  ): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
      if (
        !account ||
        !portfolio ||
        account.country !== "US" ||
        account.collectionMethod !== "provider" ||
        status.providerId !== provider.providerId ||
        status.localAccountId !== accountId
      ) {
        throw new Error("The selected U.S. provider account is unavailable on this installation.");
      }
      const state = status.state === "not_authorized" ? "reauthorization_required" : status.state;
      const now = new Date().toISOString();
      await encrypted.store.replaceSnapshotWithAudit({
        ...snapshot,
        accounts: snapshot.accounts.map((candidate) =>
          candidate.id === accountId
            ? {
                ...candidate,
                authorization: {
                  state,
                  checkedAt: status.checkedAt,
                  ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
                  ...(status.reason === undefined
                    ? status.state === "not_authorized"
                      ? { reason: "provider_consent_required" }
                      : {}
                    : { reason: status.reason })
                },
                updatedAt: now
              }
            : candidate
        )
      }, {
        id: randomUUID(),
        occurredAt: now,
        action: "provider_authorization_checked",
        outcome: "success",
        accountIds: [accountId],
        portfolioId: portfolio.id,
        metadata: {
          provider: provider.providerId,
          state,
          automaticReauthorization: false
        }
      });
    });
  }

  private disconnectUsAccount(
    encrypted: EncryptedCoreRuntime,
    providerId: string,
    tokens: EncryptedVaultProviderTokenStore,
    bindings: EncryptedProviderBindingStore,
    accountId: string
  ): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const portfolio = snapshot.portfolios.find(
        (candidate) => candidate.id === this.configuration.defaults.portfolioId
      );
      const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
      if (
        !account ||
        !portfolio ||
        account.country !== "US" ||
        account.collectionMethod !== "provider"
      ) {
        throw new Error("The selected U.S. provider account is unavailable on this installation.");
      }
      const now = new Date().toISOString();
      const disconnectedAccount: AmexAccount = {
        ...account,
        active: false,
        authorization: {
          state: "revoked",
          checkedAt: now,
          reason: "local_credentials_deleted_remote_revocation_unconfirmed"
        },
        updatedAt: now
      };
      const disconnectedSnapshot = removeAccountFromQueryPortfolios(snapshot, accountId, now);
      const event: AuditEvent = {
        id: randomUUID(),
        occurredAt: now,
        action: "account_disconnected",
        outcome: "success",
        accountIds: [accountId],
        portfolioId: portfolio.id,
        metadata: {
          provider: providerId,
          localCredentialsDeleted: true,
          remoteRevocation: "pending_or_unconfirmed",
          retainedEncryptedFinancialData: true
        }
      };

      encrypted.database.exec("BEGIN IMMEDIATE TRANSACTION");
      try {
        tokens.deleteInMemory(providerId, accountId);
        bindings.deleteInMemory(providerId, accountId);
        const updated = encrypted.database.run(
          "UPDATE accounts SET payload_json = ? WHERE id = ?",
          [JSON.stringify(disconnectedAccount), accountId]
        );
        if (updated !== 1) throw new Error("The selected U.S. provider account changed during disconnect.");
        for (const changedPortfolio of disconnectedSnapshot.portfolios) {
          const original = snapshot.portfolios.find((candidate) => candidate.id === changedPortfolio.id);
          if (original !== undefined && JSON.stringify(original) !== JSON.stringify(changedPortfolio)) {
            const portfolioUpdated = encrypted.database.run(
              "UPDATE portfolios SET payload_json = ? WHERE id = ?",
              [JSON.stringify(changedPortfolio), changedPortfolio.id]
            );
            if (portfolioUpdated !== 1) {
              throw new Error("A query portfolio changed during account disconnect.");
            }
          }
        }
        encrypted.database.run(
          `INSERT INTO audit_events(id, occurred_at, action, outcome, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
          [event.id, event.occurredAt, event.action, event.outcome, JSON.stringify(event)]
        );
        encrypted.database.exec("COMMIT");
      } catch (error) {
        try {
          encrypted.database.exec("ROLLBACK");
        } catch {
          // The caller discards this runtime if rollback cannot complete.
        }
        throw error;
      }
      await encrypted.database.save();
    });
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
      if (!account || !portfolio) throw new Error("Account is unavailable on this installation.");
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

  private updatePortfolio(
    encrypted: EncryptedCoreRuntime,
    name: string,
    accountIds: readonly string[]
  ): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const now = new Date().toISOString();
      const next = configureOwnerPortfolio(
        snapshot,
        this.configuration.defaults.portfolioId,
        { name, accountIds },
        now
      );
      await encrypted.store.replaceSnapshotWithAudit(next, {
        id: randomUUID(),
        occurredAt: now,
        action: "portfolio_configuration_changed",
        outcome: "success",
        accountIds: [...accountIds],
        portfolioId: this.configuration.defaults.portfolioId,
        metadata: { accountCount: accountIds.length, source: "desktop_ui" }
      });
    });
  }

  private setAlertDisposition(
    encrypted: EncryptedCoreRuntime,
    alertId: string,
    status: OwnerAlertDisposition
  ): Promise<void> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const now = new Date().toISOString();
      const alert = snapshot.fraudAlerts.find((candidate) => candidate.id === alertId);
      const next = setOwnerAlertDisposition(
        snapshot,
        this.configuration.defaults.portfolioId,
        alertId,
        status,
        now
      );
      await encrypted.store.replaceSnapshotWithAudit(next, {
        id: randomUUID(),
        occurredAt: now,
        action: "fraud_alert_reviewed",
        outcome: "success",
        accountIds: alert === undefined ? [] : [alert.accountId],
        portfolioId: this.configuration.defaults.portfolioId,
        metadata: { disposition: status, reviewOnly: true, providerAction: false }
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
        !portfolio ||
        account.collectionMethod !== "statement_import"
      ) {
        throw new Error("Import-only account is unavailable on this installation.");
      }
      const now = new Date().toISOString();
      const withoutAccount = removeAccountFromQueryPortfolios(snapshot, accountId, now);
      await encrypted.store.replaceSnapshotWithAudit({
        ...withoutAccount,
        accounts: withoutAccount.accounts.map((candidate) =>
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

  private async previewJapanImport(
    encrypted: EncryptedCoreRuntime,
    input: JapanImportPreviewInput
  ): Promise<JapanImportCandidate> {
    const snapshot = await encrypted.store.loadSnapshot();
    const account = snapshot.accounts.find((candidate) => candidate.id === input.accountId);
    if (
      !account ||
      !account.active ||
      account.country !== "JP" ||
      account.collectionMethod !== "statement_import"
    ) {
      throw new Error("Select an active Japan statement-import account on this installation.");
    }
    const parsedSource = parseStatementFile(input.bytes, {
      account,
      importedAt: new Date().toISOString(),
      sourceFileName: input.fileName
    });
    const categoryMapping = await applyConfiguredCategoryMapping(
      parsedSource,
      this.configuration.raw.AMEX_CATEGORY_MAPPING_FILE
    );
    const parsed = categoryMapping.parsed;
    const existingTransactions = snapshot.transactions.filter(
      (transaction) => transaction.source.accountId === account.id
    );
    const existingSourceFingerprints = snapshot.statements
      .filter((statement) => statement.accountId === account.id)
      .map((statement) => statement.sourceFileFingerprint);
    const preview = buildImportPreview(parsed, {
      existingTransactions,
      existingSourceFingerprints,
      ...(input.statementBalance === undefined ? {} : { statementBalance: input.statementBalance })
    });
    return {
      accountId: account.id,
      fileName: input.fileName,
      parsed,
      preview,
      baselineDigest: importBaselineDigest(snapshot.transactions, snapshot.statements, account.id),
      categoryMappingsApplied: categoryMapping.matchedTransactionCount,
      ...(categoryMapping.sourceFingerprint === undefined
        ? {}
        : { categoryMappingFingerprint: categoryMapping.sourceFingerprint }),
      ...(input.statementBalance === undefined ? {} : { statementBalance: input.statementBalance })
    };
  }

  private commitJapanImport(
    encrypted: EncryptedCoreRuntime,
    candidate: JapanImportCandidate
  ): Promise<JapanImportCommitResult> {
    return this.enqueueCoreWrite(async () => {
      const snapshot = await encrypted.store.loadSnapshot();
      const account = snapshot.accounts.find((item) => item.id === candidate.accountId);
      const portfolio = snapshot.portfolios.find(
        (item) => item.id === this.configuration.defaults.portfolioId
      );
      if (
        !account ||
        !portfolio ||
        !account.active ||
        account.country !== "JP" ||
        account.collectionMethod !== "statement_import"
      ) {
        throw new Error("The selected Japan account changed before import approval. Preview the file again.");
      }
      await assertCategoryMappingUnchanged(
        this.configuration.raw.AMEX_CATEGORY_MAPPING_FILE,
        candidate.categoryMappingFingerprint
      );
      if (importBaselineDigest(snapshot.transactions, snapshot.statements, account.id) !== candidate.baselineDigest) {
        throw new Error("The account data changed after preview. Preview the statement again before approving it.");
      }
      const errorIssues = candidate.preview.issues.filter((issue) => issue.severity === "error");
      const conflictingReferences = candidate.preview.duplicateFindings.filter(
        (finding) => finding.classification === "external_id_conflict"
      );
      if (errorIssues.length > 0 || conflictingReferences.length > 0) {
        throw new Error("The statement has invalid rows or conflicting references and was not imported.");
      }
      if (candidate.preview.reconciliation.status === "mismatch") {
        throw new Error("The statement balances do not reconcile. Nothing was imported.");
      }
      if (candidate.preview.acceptedTransactions.length === 0) {
        throw new Error("The statement contains no new valid transactions to import.");
      }

      const now = new Date().toISOString();
      let acceptedTransactions: readonly FinancialTransaction[] = candidate.preview.acceptedTransactions;
      let statement: Statement | undefined;
      if (candidate.statementBalance !== undefined) {
        if (candidate.preview.duplicateFindings.length > 0) {
          throw new Error("A reconciled statement cannot be committed while duplicate rows are present. Review or remove them first.");
        }
        const statementId = `stmt_${createHash("sha256")
          .update(`${account.id}\u0000${candidate.preview.sourceFingerprint}`)
          .digest("hex")
          .slice(0, 24)}`;
        acceptedTransactions = candidate.preview.acceptedTransactions.map((transaction) => ({
          ...transaction,
          statementId
        }));
        statement = {
          id: statementId,
          accountId: account.id,
          periodStart: candidate.statementBalance.periodStart,
          periodEnd: candidate.statementBalance.periodEnd,
          openingBalance: {
            amount: canonicalCurrencyAmount(
              candidate.statementBalance.openingBalance,
              account.currency,
              "opening balance"
            ),
            currency: account.currency
          },
          closingBalance: {
            amount: canonicalCurrencyAmount(
              candidate.statementBalance.closingBalance,
              account.currency,
              "closing balance"
            ),
            currency: account.currency
          },
          transactionIds: acceptedTransactions.map((transaction) => transaction.id),
          importedAt: now,
          sourceFileFingerprint: candidate.preview.sourceFingerprint
        };
      }

      const newAlerts = this.configuration.raw.AMEX_ALERTS_ENABLED
        ? detectReviewOnlyAlerts(acceptedTransactions, {
            detectedAt: now,
            largeAmountThresholds: {
              USD: String(this.configuration.raw.AMEX_ALERT_HIGH_VALUE_USD),
              JPY: String(this.configuration.raw.AMEX_ALERT_HIGH_VALUE_JPY)
            }
          })
        : [];
      const existingAlertIds = new Set(snapshot.fraudAlerts.map((alert) => alert.id));
      const nextSnapshot = {
        ...snapshot,
        transactions: [...snapshot.transactions, ...acceptedTransactions],
        statements: statement === undefined ? snapshot.statements : [...snapshot.statements, statement],
        fraudAlerts: [
          ...snapshot.fraudAlerts,
          ...newAlerts.filter((alert) => !existingAlertIds.has(alert.id))
        ]
      };
      await encrypted.store.replaceSnapshotWithAudit(nextSnapshot, {
        id: randomUUID(),
        occurredAt: now,
        action: "statement_import_committed",
        outcome: "success",
        accountIds: [account.id],
        portfolioId: portfolio.id,
        metadata: {
          format: candidate.parsed.metadata.format,
          parsedRows: candidate.parsed.metadata.parsedRows,
          importedTransactions: acceptedTransactions.length,
          duplicatesSkipped: candidate.preview.duplicateFindings.length,
          warningCount: candidate.preview.issues.filter((issue) => issue.severity === "warning").length,
          reconciliation: candidate.preview.reconciliation.status,
          sourceFingerprint: candidate.preview.sourceFingerprint,
          categoryMappingsApplied: candidate.categoryMappingsApplied,
          ...(candidate.categoryMappingFingerprint === undefined
            ? {}
            : { categoryMappingFingerprint: candidate.categoryMappingFingerprint })
        }
      });
      return {
        imported: acceptedTransactions.length,
        duplicatesSkipped: candidate.preview.duplicateFindings.length,
        warningCount: candidate.preview.issues.filter((issue) => issue.severity === "warning").length,
        ...(candidate.statementBalance === undefined
          ? {}
          : {
              periodStart: candidate.statementBalance.periodStart,
              periodEnd: candidate.statementBalance.periodEnd
            })
      };
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

  private trackProviderOperation<T>(operation: Promise<T>): Promise<T> {
    this.providerOperations.add(operation);
    void operation.finally(() => this.providerOperations.delete(operation)).catch(() => undefined);
    return operation;
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

  private async authorizeUsAccount(
    active: ActiveCore,
    provider: UsProviderRuntime,
    accountId: string
  ): Promise<DesktopActionResult> {
    if (
      !active.setProviderAuthorization ||
      !active.setProviderBinding ||
      !active.syncUsAccount
    ) {
      return { ok: false, message: "The encrypted provider runtime is unavailable." };
    }
    if (this.consentOwnerAccountId !== undefined) {
      return {
        ok: false,
        message: this.consentOwnerAccountId === accountId
          ? "Authorization is already in progress for this account."
          : "Finish or cancel the current account authorization before connecting another account."
      };
    }
    // Every account uses the same fixed loopback callback port, so consent must
    // be globally single-flight. Set the owner before the first await.
    this.consentOwnerAccountId = accountId;

    let callbackSession: LoopbackOAuthCallbackSession | undefined;
    let consentCallbackAccepted = false;
    let consentCompleted = false;
    let consentCreatedNewGrant = false;
    let initialConsentBrowserOpened = false;
    let bindingSaved = false;
    let priorBinding: ProviderBinding | undefined;
    try {
      const account = (await active.listAllAccounts()).find(
        (candidate) => candidate.id === accountId
      );
      if (!account || !account.active || account.country !== "US" || account.collectionMethod !== "provider") {
        return { ok: false, message: "Select an active U.S. consent account on this installation." };
      }
      priorBinding = await active.getProviderBinding?.(accountId);
      const consent = provider.kind === "plaid-hosted-link"
        ? await provider.oauth.beginHostedConsent(accountId, priorBinding?.providerAccountId)
        : await provider.oauth.beginConsent(accountId);
      await active.setProviderAuthorization(accountId, {
        providerId: provider.providerId,
        localAccountId: accountId,
        state: "pending",
        checkedAt: new Date().toISOString(),
        expiresAt: consent.expiresAt
      });
      let completed: ProviderAuthorizationStatus;
      let providerAccount: NormalizedV1ProviderAccount;
      if (provider.kind === "plaid-hosted-link") {
        await shell.openExternal(consent.authorizationUrl);
        initialConsentBrowserOpened = priorBinding === undefined;
        const plaidCompletion = await provider.oauth.completeHostedConsent(accountId);
        // The Hosted Link adapter has validated the exact selected card,
        // persisted its per-account token, and removed any unpersisted Item on
        // failure before returning here.
        consentCallbackAccepted = true;
        consentCompleted = true;
        consentCreatedNewGrant = priorBinding === undefined;
        completed = plaidCompletion.authorization;
        providerAccount = plaidCompletion.account;
      } else {
        const authorizationUrl = new URL(consent.authorizationUrl);
        const expectedState = authorizationUrl.searchParams.get("state");
        if (!expectedState) throw new Error("The provider consent URL did not contain a state value.");
        callbackSession = await startLoopbackOAuthCallbackListener({
          redirectUri: this.configuration.raw.AMEX_US_AGGREGATOR_REDIRECT_URI,
          expectedState
        });
        this.consentSessions.set(accountId, callbackSession);
        await shell.openExternal(consent.authorizationUrl);
        const callback = await callbackSession.callback;
        // From this point the provider may have created a grant even if token
        // persistence or response validation fails locally.
        consentCallbackAccepted = true;
        completed = await provider.oauth.completeConsent(accountId, callback);
        consentCompleted = true;
        consentCreatedNewGrant = true;

        const discoveryResult = await provider.financial.listAccounts(accountId);
        const discovered = parseNormalizedV1Accounts(discoveryResult.data);
        if (discovered.length !== 1) {
          throw new ProviderIntegrationError(
            "INVALID_PROVIDER_RESPONSE",
            "Individually authorized setup requires the provider to return exactly one account."
          );
        }
        providerAccount = discovered[0]!;
      }
      assertCompatibleProviderAccount(account, providerAccount);
      if (providerAccount.status !== "active") {
        throw new ProviderIntegrationError(
          providerAccount.status === "reauthorization_required"
            ? "AUTHORIZATION_REQUIRED"
            : "PROVIDER_UNAVAILABLE",
          providerAccount.status === "reauthorization_required"
            ? "The provider requires this account to be authorized again."
            : "The approved data provider is temporarily unavailable."
        );
      }
      await active.setProviderBinding(accountId, {
        providerAccountId: providerAccount.id,
        ...(providerAccount.last_four === undefined ? {} : { lastFour: providerAccount.last_four })
      });
      bindingSaved = true;
      await active.setProviderAuthorization(accountId, {
        ...completed,
        state: "authorized",
        ...(providerAccount.authorization_expires_at === undefined
          ? {}
          : { expiresAt: providerAccount.authorization_expires_at })
      });

      try {
        const sync = await active.syncUsAccount(provider, accountId);
        return {
          ok: true,
          message: `Connected exactly one read-only U.S. account and synchronized ${sync.importedTransactions} new transaction${
            sync.importedTransactions === 1 ? "" : "s"
          } and ${sync.importedStatements} new statement${sync.importedStatements === 1 ? "" : "s"}.`
        };
      } catch (error) {
        if (isStorageError(error)) {
          return this.handleAccountWriteFailure(
            active,
            error,
            "Provider data reached memory, but the encrypted local sync could not be saved atomically. Local financial queries were locked."
          );
        }
        try {
          await this.updateProviderStatusAfterFailure(active, provider, accountId, error);
        } catch (statusError) {
          return this.handleAccountWriteFailure(active, statusError);
        }
        return {
          ok: true,
          message:
            "Read-only consent and the exact account binding were saved, but the initial provider sync did not complete. Use Check now to retry; no reauthorization is requested unless the provider requires it."
        };
      }
    } catch (error) {
      if (this.lifecycleState !== "running" || this.quitting) {
        return { ok: false, message: "Authorization stopped because the encrypted local store was locked or closed." };
      }
      if (isStorageError(error)) {
        const newGrantMayExist = initialConsentBrowserOpened || (
          provider.kind === "generic-loopback" && consentCallbackAccepted
        );
        return this.handleAccountWriteFailure(
          active,
          error,
          newGrantMayExist
            ? "Encrypted provider authorization could not be saved atomically, so local queries were locked. A provider grant may have been created; revoke it in the provider portal before retrying."
            : consentCompleted && provider.kind === "plaid-hosted-link"
              ? "The Plaid update repaired the existing connection, but its local status could not be saved atomically. The existing connection was not revoked; restart and retry the local status check."
              : undefined
        );
      }
      let cleanupRevocation: ProviderDisconnectResult["remoteRevocation"] | undefined;
      if (consentCompleted && consentCreatedNewGrant) {
        try {
          cleanupRevocation = (await provider.oauth.disconnect(accountId)).remoteRevocation;
          if (bindingSaved) {
            if (priorBinding === undefined) await provider.bindings.delete(provider.providerId, accountId);
            else await provider.bindings.put(provider.providerId, accountId, priorBinding);
          }
        } catch (cleanupError) {
          if (isStorageError(cleanupError)) {
            return this.handleAccountWriteFailure(
              active,
              cleanupError,
              "Failed provider authorization could not be cleaned up in encrypted storage, so local queries were locked. Revoke the possibly created grant in the provider portal."
            );
          }
          cleanupRevocation = "failed";
        }
      } else if (consentCompleted) {
        // A Plaid update-mode flow repairs the existing Item and keeps the
        // same token. Never remove that Item merely because a later local
        // validation or metadata write failed.
        cleanupRevocation = "not_configured";
        if (bindingSaved && priorBinding !== undefined) {
          try {
            await provider.bindings.put(provider.providerId, accountId, priorBinding);
          } catch (cleanupError) {
            if (isStorageError(cleanupError)) return this.handleAccountWriteFailure(active, cleanupError);
          }
        }
      } else {
        provider.oauth.cancelConsent(accountId);
      }
      try {
        await this.updateProviderStatusAfterFailure(active, provider, accountId, error);
      } catch (statusError) {
        return this.handleAccountWriteFailure(active, statusError);
      }
      const grantNotice = !consentCompleted
        ? initialConsentBrowserOpened && !(
            error instanceof ProviderIntegrationError && error.code === "CONSENT_CANCELLED"
          )
          ? " A new Plaid connection may remain if remote cleanup could not be confirmed; review and revoke it in the Plaid portal before retrying."
          : ""
        : !consentCreatedNewGrant
          ? " The existing provider connection was not revoked; retry the local check without creating another connection."
        : cleanupRevocation === "succeeded"
          ? " Any newly created provider grant was revoked."
          : " A provider grant may remain; revoke this connection in the provider portal before retrying.";
      return {
        ok: false,
        message: `${providerFailureMessage(error, "The U.S. provider authorization did not complete.")}${grantNotice}`
      };
    } finally {
      this.consentSessions.delete(accountId);
      if (this.consentOwnerAccountId === accountId) this.consentOwnerAccountId = undefined;
      await callbackSession?.close().catch(() => undefined);
    }
  }

  private async syncUsAccount(
    active: ActiveCore,
    provider: UsProviderRuntime,
    accountId: string
  ): Promise<DesktopActionResult> {
    if (!active.setProviderAuthorization || !active.syncUsAccount) {
      return { ok: false, message: "The encrypted provider runtime is unavailable." };
    }
    try {
      const authorization = await provider.oauth.checkAuthorization(accountId);
      await active.setProviderAuthorization(accountId, authorization);
      if (authorization.state !== "authorized") {
        return {
          ok: false,
          message: authorization.state === "reauthorization_required" || authorization.state === "not_authorized"
            ? "This account must be reconnected through the provider's read-only consent page."
            : "The provider is temporarily unavailable. Existing encrypted local data remains readable."
        };
      }
      const result = await active.syncUsAccount(provider, accountId);
      return {
        ok: true,
        message: `Provider sync completed for the selected account: ${result.importedTransactions} new transaction${
          result.importedTransactions === 1 ? "" : "s"
        }, ${result.importedStatements} new statement${result.importedStatements === 1 ? "" : "s"}, and ${
          result.duplicatesSkipped
        } duplicate${result.duplicatesSkipped === 1 ? "" : "s"} skipped.`
      };
    } catch (error) {
      if (isStorageError(error)) return this.handleAccountWriteFailure(active, error);
      try {
        await this.updateProviderStatusAfterFailure(active, provider, accountId, error);
      } catch (statusError) {
        return this.handleAccountWriteFailure(active, statusError);
      }
      return { ok: false, message: providerFailureMessage(error, "The selected provider account could not sync.") };
    }
  }

  private async updateProviderStatusAfterFailure(
    active: ActiveCore,
    provider: UsProviderRuntime,
    accountId: string,
    error: unknown
  ): Promise<void> {
    if (!active.setProviderAuthorization || this.lifecycleState !== "running" || this.quitting) return;
    const authorizationRequired =
      error instanceof ProviderIntegrationError &&
      error.code === "AUTHORIZATION_REQUIRED";
    const status: ProviderAuthorizationStatus = {
      providerId: provider.providerId,
      localAccountId: accountId,
      state: authorizationRequired ? "reauthorization_required" : "unavailable",
      checkedAt: new Date().toISOString(),
      reason: authorizationRequired ? "provider_reauthorization_required" : "provider_temporarily_unavailable"
    };
    await active.setProviderAuthorization(accountId, status);
  }

  private async refreshProviderAccounts(): Promise<DesktopActionResult> {
    const active = this.active;
    if (!active) {
      return { ok: false, message: "Unlock the encrypted local store before checking account status." };
    }
    const provider = this.provider;
    if (!provider || !active.syncUsAccount || !active.setProviderAuthorization) {
      return {
        ok: true,
        message: "Local status refreshed. No approved U.S. provider runtime is configured."
      };
    }
    let accounts: readonly AmexAccount[];
    try {
      accounts = await active.listAllAccounts();
    } catch {
      return { ok: false, message: "Local account status could not be read safely." };
    }
    const selected = accounts.filter(
      (account) => account.active && account.country === "US" && account.collectionMethod === "provider"
    );
    if (selected.length === 0) {
      return { ok: true, message: "Local status refreshed. There are no active U.S. consent accounts to check." };
    }

    const results: DesktopActionResult[] = [];
    for (const account of selected) {
      results.push(await this.trackProviderOperation(this.syncUsAccount(active, provider, account.id)));
    }
    const synchronized = results.filter((result) => result.ok).length;
    const attention = results.length - synchronized;
    return {
      // A completed status check refreshes the dashboard even when one account
      // reports that owner action or a later provider retry is required.
      ok: true,
      message: attention === 0
        ? `Checked and synchronized ${synchronized} U.S. consent account${synchronized === 1 ? "" : "s"}.`
        : `Checked ${results.length} U.S. consent account${results.length === 1 ? "" : "s"}: ${synchronized} synchronized and ${attention} need attention. ${
            results.find((result) => !result.ok)?.message ?? "Review the selected account status."
          }`
    };
  }

  private async getUsProviderReadiness() {
    return await preflightUsProvider({
      configuration: this.configuration,
      storageState: this.storageState,
      runtimeAvailable: this.provider !== undefined,
      ...(this.providerError === undefined ? {} : { runtimeError: this.providerError }),
      credentialResolver: new WindowsGenericCredentialResolver(),
      providerEnvironment: this.plaidEnvironment
    });
  }

  private async configurePlaid(input: Extract<DesktopRequest, { kind: "configure-plaid" }>): Promise<DesktopActionResult> {
    if (this.configuration.raw.AMEX_US_AGGREGATOR !== "plaid") {
      return { ok: false, message: "This installation is not using the built-in Plaid setup path." };
    }
    const active = this.active;
    if (!active) return { ok: false, message: "Unlock local data before changing Plaid setup." };
    const connected = (await active.listAllAccounts()).filter(
      (account) => account.active && account.country === "US" && account.collectionMethod === "provider"
    );
    if (connected.length > 0) {
      return {
        ok: false,
        message:
          "Disconnect every active U.S. account before changing the Plaid environment or app credentials. This prevents saved account grants from being mixed across Plaid apps or Sandbox and Production."
      };
    }
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    const redirectUri = input.redirectUri?.trim();
    if (redirectUri !== undefined && redirectUri.length > 0 && !isSafePlaidRedirectUri(redirectUri)) {
      return {
        ok: false,
        message:
          "The optional OAuth return URL must be a plain HTTPS URL already allowlisted in your Plaid Dashboard. It cannot contain credentials, a query, or a fragment."
      };
    }
    try {
      await this.verifyPlaidCredentials(input.environment, clientId, clientSecret);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof ProviderIntegrationError
          ? providerFailureMessage(error, "Plaid did not accept this setup.")
          : "Plaid setup could not be verified. Check the selected environment, client ID, network connection, and matching secret. No account consent was created."
      };
    }

    const clientIdReference = this.configuration.raw.AMEX_US_AGGREGATOR_CLIENT_ID_REF;
    const clientSecretReference = this.configuration.raw.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF;
    if (!clientIdReference || !clientSecretReference) {
      return { ok: false, message: "The protected Plaid credential references are unavailable." };
    }
    const resolver = new WindowsGenericCredentialResolver();
    const store = new WindowsGenericCredentialStore();
    let previousClientId: Uint8Array | undefined;
    let previousClientSecret: Uint8Array | undefined;
    const nextClientId = Buffer.from(clientId, "utf8");
    const nextClientSecret = Buffer.from(clientSecret, "utf8");
    let savedClientId = false;
    let savedClientSecret = false;
    try {
      previousClientId = await resolveOptionalSecret(resolver, clientIdReference);
      previousClientSecret = await resolveOptionalSecret(resolver, clientSecretReference);
      await store.write(clientIdReference, nextClientId);
      savedClientId = true;
      await store.write(clientSecretReference, nextClientSecret);
      savedClientSecret = true;
      await writePlaidProviderSettings(
        this.configuration.storage.dataDirectory,
        input.environment,
        input.environment === "production" && redirectUri ? redirectUri : undefined
      );
    } catch {
      await Promise.allSettled([
        restoreOptionalSecret(store, clientIdReference, previousClientId, savedClientId),
        restoreOptionalSecret(store, clientSecretReference, previousClientSecret, savedClientSecret)
      ]);
      return {
        ok: false,
        message: "Plaid verified the values, but Windows could not save the complete credential pair. The prior credential state was restored where possible."
      };
    } finally {
      nextClientId.fill(0);
      nextClientSecret.fill(0);
      previousClientId?.fill(0);
      previousClientSecret?.fill(0);
    }

    this.plaidEnvironment = input.environment;
    this.plaidRedirectUri = input.environment === "production" && redirectUri ? redirectUri : undefined;
    try {
      await this.reloadUnlockedRuntime();
    } catch {
      return {
        ok: false,
        message: "Plaid credentials were saved in Windows, but the encrypted runtime could not reload. Restart the tray app and check setup again."
      };
    }
    const providerReadiness = await this.getUsProviderReadiness();
    return {
      ok: providerReadiness.canStartConsent,
      message: providerReadiness.canStartConsent
        ? `Plaid accepted the ${input.environment} app credentials and they are saved for this Windows user. You can now add a U.S. personal account and continue in the separate consent browser.${
            input.environment === "production"
              ? " This credential check does not guarantee that Plaid has enabled American Express and Transactions for your Production app; the consent attempt verifies that next."
              : " Sandbox uses fake Plaid data only."
          }`
        : providerReadiness.explanation,
      providerReadiness
    };
  }

  private async verifyPlaidCredentials(
    environment: PlaidEnvironment,
    clientId: string,
    clientSecret: string
  ): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.configuration.mcp.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetch(`https://${environment}.plaid.com/institutions/get`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": clientSecret,
          "Plaid-Version": "2020-09-14"
        },
        body: JSON.stringify({
          count: 1,
          offset: 0,
          country_codes: ["US"],
          options: { products: ["transactions"] }
        }),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: abortController.signal
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new ProviderIntegrationError(
          "PROVIDER_REJECTED",
          "Plaid did not accept that client ID and secret for the selected environment."
        );
      }
      throw new ProviderIntegrationError("PROVIDER_UNAVAILABLE", "Plaid is temporarily unavailable for setup verification.");
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      throw new ProviderIntegrationError("PROVIDER_UNAVAILABLE", "Plaid could not be reached for setup verification.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async removePlaidCredentials(): Promise<DesktopActionResult> {
    const active = this.active;
    if (!active) return { ok: false, message: "Unlock local data before removing provider credentials." };
    const connected = (await active.listAllAccounts()).filter(
      (account) => account.active && account.country === "US" && account.collectionMethod === "provider"
    );
    if (connected.length > 0) {
      return {
        ok: false,
        message: "Disconnect every active U.S. account first so the app can request remote Plaid revocation before its app credentials are removed."
      };
    }
    const confirmation = await dialog.showMessageBox(this.window!, {
      type: "warning",
      title: "Remove Plaid app credentials?",
      message: "Remove the saved Plaid client ID and secret from Windows Credential Manager?",
      detail: "This does not close your Plaid developer account or change external copies. You can re-enter the credentials later from U.S. personal setup.",
      buttons: ["Cancel", "Remove credentials"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) return { ok: false, message: "Credential removal canceled." };
    const clientIdReference = this.configuration.raw.AMEX_US_AGGREGATOR_CLIENT_ID_REF;
    const clientSecretReference = this.configuration.raw.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF;
    if (!clientIdReference || !clientSecretReference) {
      return { ok: false, message: "The protected Plaid credential references are unavailable." };
    }
    const store = new WindowsGenericCredentialStore();
    try {
      await Promise.all([store.delete(clientIdReference), store.delete(clientSecretReference)]);
      await this.reloadUnlockedRuntime();
    } catch {
      return {
        ok: false,
        message: "Windows could not confirm removal of the complete Plaid credential pair. Check Windows Credential Manager before continuing."
      };
    }
    const providerReadiness = await this.getUsProviderReadiness();
    return {
      ok: true,
      message: "Plaid app credentials were removed from Windows Credential Manager. No Amex account data was sent or deleted.",
      providerReadiness
    };
  }

  private async reloadUnlockedRuntime(): Promise<void> {
    if (this.lifecycleState !== "running" || this.quitting) {
      throw new Error("The local runtime is already closing.");
    }
    this.lifecycleState = "locking";
    this.clearAutoLockTimer();
    try {
      await this.cutExternalInterfaces(this.runtime.current);
      await this.commandTail;
      await this.runtime.release();
      this.storageState = "locked";
      this.storageError = undefined;
      this.mcpError = undefined;
      this.tunnelError = undefined;
      this.providerError = undefined;
    } finally {
      if (!this.quitting) this.lifecycleState = "running";
    }
    await this.unlock();
    if (!this.active) throw new Error("The encrypted local runtime did not reopen.");
  }

  private async performRequest(request: DesktopRequest): Promise<DesktopActionResult> {
    this.touchActivity();
    if (typeof request === "string") return this.performAction(request);
    if (this.lifecycleState !== "running" || this.quitting) {
      return { ok: false, message: "The local store is locking or closing. No account setting was changed." };
    }
    if (request.kind === "set-screenshot-protection") {
      return this.setScreenshotProtection(request.enabled);
    }
    const active = this.active;
    if (!active) return { ok: false, message: "Unlock the encrypted local store before changing account settings." };

    switch (request.kind) {
      case "configure-plaid":
        return await this.configurePlaid(request);
      case "remove-plaid-credentials":
        return await this.removePlaidCredentials();
      case "add-account": {
        if (request.country === "US") {
          if (request.accountClass !== "personal") {
            return {
              ok: false,
              message: "U.S. company cards are not enabled in this test release. No account was added and no consent was started."
            };
          }
          const providerReadiness = await this.getUsProviderReadiness();
          if (!providerReadiness.canStartConsent) {
            return {
              ok: false,
              message: providerReadiness.explanation,
              providerReadiness
            };
          }
          const provider = this.provider;
          if (!provider || !active.addUsAccount) {
            return {
              ok: false,
              message: "U.S. setup is not ready. No account was added and no sign-in was started.",
              providerReadiness
            };
          }
          let accountId: string;
          try {
            accountId = await active.addUsAccount({
              accountClass: request.accountClass,
              label: request.label,
              legalEntityName: request.legalEntityName
            });
          } catch (error) {
            return this.handleAccountWriteFailure(active, error);
          }
          return await this.trackProviderOperation(this.authorizeUsAccount(active, provider, accountId));
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
      case "update-portfolio":
        if (!active.updatePortfolio) {
          return { ok: false, message: "Synthetic demo portfolio settings cannot be saved." };
        }
        try {
          await active.updatePortfolio(request.name, request.accountIds);
        } catch (error) {
          if (isStorageError(error)) return this.handleAccountWriteFailure(active, error);
          return { ok: false, message: error instanceof Error ? error.message : "The portfolio selection was not changed." };
        }
        return {
          ok: true,
          message: `Saved the owner-controlled portfolio with ${request.accountIds.length} selected account${request.accountIds.length === 1 ? "" : "s"}.`
        };
      case "set-alert-status": {
        if (!active.setAlertDisposition) {
          return { ok: false, message: "Synthetic demo alert status cannot be changed." };
        }
        if (request.status === "confirmed_suspicious") {
          const confirmation = await dialog.showMessageBox(this.window!, {
            type: "warning",
            title: "Flag this alert for local review?",
            message: "This records a local review label only.",
            detail:
              "The app will not contact Amex or the provider, freeze a card, submit a dispute, move money, or otherwise act on the account. Contact the issuer yourself if the activity is not yours.",
            buttons: ["Cancel", "Flag locally"],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          if (confirmation.response !== 1) return { ok: false, message: "Alert review change canceled." };
        }
        try {
          await active.setAlertDisposition(request.alertId, request.status);
        } catch (error) {
          if (isStorageError(error)) return this.handleAccountWriteFailure(active, error);
          return { ok: false, message: error instanceof Error ? error.message : "The alert review status was not changed." };
        }
        return {
          ok: true,
          message: request.status === "confirmed_suspicious"
            ? "Flagged for local review only. No issuer, provider, dispute, or card-control action was taken."
            : `Saved the local alert status as ${request.status}. No external action was taken.`
        };
      }
      case "import-jp-statement":
        return this.selectStatementFile(request);
      case "approve-jp-import":
        return this.approveJapanImport(request.previewId);
      case "cancel-jp-import":
        return this.cancelJapanImport(request.previewId);
      case "prepare-export":
        return this.prepareExportPackage(request);
      case "authorize-us-account": {
        const providerReadiness = await this.getUsProviderReadiness();
        if (!providerReadiness.canStartConsent) {
          return { ok: false, message: providerReadiness.explanation, providerReadiness };
        }
        const provider = this.provider;
        if (!provider) {
          return { ok: false, message: "U.S. setup is not ready.", providerReadiness };
        }
        return await this.trackProviderOperation(this.authorizeUsAccount(active, provider, request.accountId));
      }
      case "sync-us-account": {
        const provider = this.provider;
        if (!provider) return { ok: false, message: "An approved U.S. read-only provider is not configured." };
        return await this.trackProviderOperation(this.syncUsAccount(active, provider, request.accountId));
      }
      case "set-tunnel-running": {
        const tunnel = this.tunnel;
        if (!tunnel) {
          return {
            ok: false,
            message: "The private connection is not configured with a verified client, digest, tunnel ID, and reviewed arguments. Local MCP remains available."
          };
        }
        try {
          if (request.running) await tunnel.start();
          else await tunnel.stop();
          if (active.appendAudit) {
            await this.enqueueCoreWrite(() => active.appendAudit!({
              id: randomUUID(),
              occurredAt: new Date().toISOString(),
              action: request.running ? "tunnel_started" : "tunnel_stopped",
              outcome: "success",
              accountIds: [],
              portfolioId: active.portfolioId,
              metadata: {
                state: tunnel.status.state,
                outboundOnly: true,
                routeHealth: tunnel.status.health
              }
            }));
          }
          return {
            ok: true,
            message: request.running
              ? "The verified tunnel-client process is running outbound-only while this app remains unlocked; remote route health is not independently verified."
              : "The private connection is stopped; local MCP remains available on this computer."
          };
        } catch (error) {
          if (request.running) await tunnel.stop().catch(() => undefined);
          return {
            ok: false,
            message: `The private connection could not ${request.running ? "start" : "stop"} safely. ${
              error instanceof Error ? error.message : "Unknown tunnel error."
            }`
          };
        }
      }
      case "disconnect-account": {
        const account = (await active.listAllAccounts()).find(
          (candidate) => candidate.id === request.accountId
        );
        if (!account) return { ok: false, message: "That account is not available on this installation." };
        if (account.collectionMethod === "provider") {
          const provider = this.provider;
          if (!active.disconnectUsAccount) {
            return { ok: false, message: "Synthetic demo accounts cannot be disconnected." };
          }
          const confirmation = await dialog.showMessageBox(this.window!, {
            type: "warning",
            title: "Disconnect this consent account?",
            message: `Disconnect ${account.displayName}?`,
            detail:
              "The app will request provider revocation when supported, delete the local protected token and exact-account binding, and stop future reads. Existing encrypted financial history is retained unless separately deleted.",
            buttons: ["Cancel", "Disconnect"],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          if (confirmation.response !== 1) return { ok: false, message: "Disconnect canceled." };
          return await this.trackProviderOperation((async () => {
            let prepared: PreparedProviderRevocation | undefined;
            if (provider) {
              prepared = await provider.oauth.prepareDisconnect(account.id).catch(() => undefined);
            }
            try {
              // Stop local reads and atomically delete both protected local
              // references before any remote request is attempted.
              await active.disconnectUsAccount!(account.id);
            } catch (error) {
              prepared?.close();
              return this.handleAccountWriteFailure(active, error);
            }

            const remoteRevocation = prepared === undefined
              ? "not_configured"
              : await prepared.revoke();
            prepared?.close();
            if (active.appendAudit) {
              try {
                await this.enqueueCoreWrite(() => active.appendAudit!({
                  id: randomUUID(),
                  occurredAt: new Date().toISOString(),
                  action: "provider_remote_revocation_attempted",
                  outcome: remoteRevocation === "succeeded" ? "success" : "failure",
                  accountIds: [account.id],
                  portfolioId: active.portfolioId,
                  metadata: {
                    provider: provider?.providerId ?? this.configuration.raw.AMEX_US_AGGREGATOR,
                    remoteRevocation
                  }
                }));
              } catch (error) {
                return this.handleAccountWriteFailure(active, error);
              }
            }
            return {
              ok: true,
              message: remoteRevocation === "succeeded"
                ? "Local access was disabled first, protected credentials and the exact-account binding were deleted, and remote provider revocation was confirmed. Encrypted financial history was retained."
                : "Local access was disabled first and protected credentials and the exact-account binding were deleted. Remote provider revocation is unconfirmed; revoke this connection in the provider portal as well. Encrypted financial history was retained."
            };
          })());
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
    return { ok: false, message: "This desktop workflow is not available in the current runtime." };
  }

  private async setScreenshotProtection(enabled: boolean): Promise<DesktopActionResult> {
    if (!enabled && !this.screenshotControlAvailable) {
      return {
        ok: false,
        message: "Screenshot protection cannot be disabled in this build."
      };
    }
    const window = this.window;
    if (!window || window.isDestroyed()) {
      return { ok: false, message: "The dashboard window is unavailable." };
    }
    if (enabled === this.screenshotProtectionEnabled) {
      return {
        ok: true,
        message: enabled
          ? "Screenshot protection is already on."
          : "Screenshots are already allowed for this session."
      };
    }
    if (!enabled) {
      const confirmation = await dialog.showMessageBox(window, {
        type: "warning",
        title: "Allow screenshots for this session?",
        message: "Screen-capture protection will be turned off until you close the app.",
        detail:
          "Anything visible in this window—including personal financial data—may be captured by Windows, other apps, screen sharing, or recording tools. This Settings change is not saved. Installed builds start protected on the next launch; source runs still follow their explicit development configuration.",
        buttons: ["Keep protection on", "Allow screenshots this session"],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });
      if (confirmation.response !== 1) {
        return { ok: false, message: "Screenshot protection remains on." };
      }
    }
    try {
      window.setContentProtection(enabled);
      this.screenshotProtectionEnabled = enabled;
    } catch {
      return {
        ok: false,
        message: "The screenshot protection setting could not be changed."
      };
    }
    return {
      ok: true,
      message: enabled
        ? "Screenshot protection is on."
        : "Screenshots are allowed for this session. This Settings change was not saved."
    };
  }

  private async handleAccountWriteFailure(
    active: ActiveCore,
    error: unknown,
    message?: string
  ): Promise<DesktopActionResult> {
    active.discardChanges();
    const failedRuntime = this.runtime.current;
    if (!this.quitting) this.lifecycleState = "locking";
    await this.cutExternalInterfaces(failedRuntime);
    await this.commandTail;
    this.storageState = "unavailable";
    this.mcpError = undefined;
    this.tunnelError = undefined;
    this.storageError = message ?? "An account setting could not be saved atomically. The in-memory store was discarded and financial queries remain locked.";
    if (this.configuration.environment !== "production") console.error("Encrypted account mutation failed", error);
    setImmediate(() => {
      void this.runtime.release().catch(() => undefined).finally(() => {
        if (!this.quitting && this.lifecycleState === "locking") this.lifecycleState = "running";
      });
    });
    return { ok: false, message: this.storageError };
  }

  private async performAction(action: DesktopAction): Promise<DesktopActionResult> {
    if (this.lifecycleState !== "running" || this.quitting) {
      return { ok: false, message: "The local store is locking or closing. No action was started." };
    }
    switch (action) {
      case "refresh":
        return await this.refreshProviderAccounts();
      case "preflight-us-provider": {
        const providerReadiness = await this.getUsProviderReadiness();
        return {
          ok: providerReadiness.canStartConsent,
          message: providerReadiness.explanation,
          providerReadiness
        };
      }
      case "authorize-us-account":
        return await this.performAction("preflight-us-provider");
      case "import-jp-statement":
        return {
          ok: false,
          message: "Select a specific Japan account before choosing a statement so data cannot cross accounts."
        };
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
        await shell.openExternal(CUSTOM_MCP_DOCS);
        return { ok: true, message: "Opened the official OpenAI custom MCP setup documentation." };
      case "open-plaid-dashboard":
        await shell.openExternal(PLAID_DASHBOARD);
        return { ok: true, message: "Opened Plaid's official dashboard in your browser." };
      case "run-safe-test-drive": {
        const snapshot = await this.getSnapshot();
        const testDrive = runLocalTestDrive({
          storageState: snapshot.storage.state,
          mcpMode: this.configuration.mcp.mode,
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
      case "save-synthetic-sample-statement": {
        await mkdir(this.configuration.storage.importDirectory, { recursive: true });
        const save = await dialog.showSaveDialog(this.window!, {
          title: "Save a synthetic Japan statement for testing",
          defaultPath: resolve(this.configuration.storage.importDirectory, "synthetic-japan-statement.csv"),
          filters: [{ name: "CSV statement", extensions: ["csv"] }]
        });
        if (save.canceled || !save.filePath) return { ok: false, message: "Synthetic statement save canceled." };
        const sample = [
          "\uFEFFご利用日,ご利用店名,ご利用金額,照会番号,カテゴリ,メモ,国",
          "2026/08/28,SYNTHETIC TOKYO HOTEL,18500,SYN-0001,Travel,Synthetic test row,JP",
          "2026/08/29,SYNTHETIC RAIL PASS,4200,SYN-0002,Transport,Synthetic test row,JP",
          "2026/08/30,SYNTHETIC REFUND,-1200,SYN-0003,Refund,Synthetic test row,JP",
          ""
        ].join("\r\n");
        await writeFile(save.filePath, sample, { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
          if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
            throw new Error("The selected sample file already exists. Choose a new name so no file is overwritten.");
          }
          throw error;
        });
        return { ok: true, message: "Saved a clearly labeled synthetic CSV. You can now import it into a Japan test account." };
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
      // Deletion is a lock transition too: revoke external reachability and
      // cancel provider I/O before waiting for a queued sync or local write.
      await this.cutExternalInterfaces(this.runtime.current);
      await this.commandTail;
      await this.runtime.release();
      this.storageState = "locked";
      this.storageError = undefined;
      this.mcpError = undefined;
      this.tunnelError = undefined;
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

  private async selectStatementFile(
    request: Extract<DesktopRequest, { kind: "import-jp-statement" }>
  ): Promise<DesktopActionResult> {
    const active = this.active;
    if (!active?.previewJapanImport || !active.commitJapanImport) {
      return { ok: false, message: "Statement imports are unavailable in synthetic demo mode." };
    }
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
    const fileStats = await lstat(selected);
    const maximumBytes = this.configuration.raw.AMEX_JP_IMPORT_MAX_MB * 1024 * 1024;
    if (!fileStats.isFile() || fileStats.isSymbolicLink() || !allowed.has(extension) || fileStats.size > maximumBytes) {
      return { ok: false, message: "The selected file failed the local extension, type, or size policy." };
    }
    let bytes: Buffer | undefined;
    try {
      const sourceHandle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const beforeRead = await sourceHandle.stat();
        if (
          !beforeRead.isFile() ||
          beforeRead.size !== fileStats.size ||
          beforeRead.size < 1 ||
          beforeRead.size > maximumBytes ||
          beforeRead.mtimeMs !== fileStats.mtimeMs ||
          (fileStats.ino !== 0 && beforeRead.ino !== fileStats.ino) ||
          (fileStats.dev !== 0 && beforeRead.dev !== fileStats.dev)
        ) {
          return { ok: false, message: "The statement changed before it could be read. Choose it again." };
        }
        bytes = await sourceHandle.readFile();
        const afterRead = await sourceHandle.stat();
        if (
          bytes.byteLength !== beforeRead.size ||
          afterRead.size !== beforeRead.size ||
          afterRead.mtimeMs !== beforeRead.mtimeMs ||
          afterRead.ino !== beforeRead.ino ||
          afterRead.dev !== beforeRead.dev
        ) {
          return { ok: false, message: "The statement changed while it was being read. Choose it again." };
        }
      } finally {
        await sourceHandle.close();
      }
      const statementBalance = importStatementBalance(request);
      const candidate = await active.previewJapanImport({
        accountId: request.accountId,
        fileName: basename(selected),
        bytes,
        ...(statementBalance === undefined ? {} : { statementBalance })
      });
      const errors = candidate.preview.issues.filter((issue) => issue.severity === "error");
      const warnings = candidate.preview.issues.filter((issue) => issue.severity === "warning");
      const conflicts = candidate.preview.duplicateFindings.filter(
        (finding) => finding.classification === "external_id_conflict"
      );
      const blocked =
        errors.length > 0 ||
        conflicts.length > 0 ||
        (statementBalance !== undefined && candidate.preview.duplicateFindings.length > 0) ||
        candidate.preview.reconciliation.status === "mismatch" ||
        candidate.preview.acceptedTransactions.length === 0;
      const detail = [
        `File: ${candidate.fileName}`,
        `Format: ${candidate.parsed.metadata.format.toUpperCase()}${candidate.parsed.metadata.encoding ? ` · ${candidate.parsed.metadata.encoding}` : ""}`,
        `Parsed transaction rows: ${candidate.preview.candidateTransactions.length}`,
        `New valid transactions: ${candidate.preview.acceptedTransactions.length}`,
        `Duplicates skipped: ${candidate.preview.duplicateFindings.length}`,
        `Warnings: ${warnings.length}`,
        `Errors: ${errors.length}`,
        `Reconciliation: ${candidate.preview.reconciliation.status.replaceAll("_", " ")}`,
        statementBalance === undefined
          ? "No signed balances were supplied, so transactions can be committed but no statement balance record will be created."
          : `Balance difference: ${candidate.preview.reconciliation.difference ?? "—"} JPY`,
        conflicts.length > 0 ? "A reused reference has conflicting details; import is blocked." : "",
        statementBalance !== undefined && candidate.preview.duplicateFindings.length > 0
          ? "A reconciled statement cannot be imported while any duplicate rows are present. Review or remove them first."
          : "",
        ...errors.slice(0, 5).map((issue) => `Row ${issue.row ?? "?"}: ${issue.message}`),
        ...warnings.slice(0, 5).map((issue) => `Warning${issue.row ? ` row ${issue.row}` : ""}: ${issue.message}`)
      ].filter((line) => line.length > 0).join("\n");
      if (blocked) {
        await dialog.showMessageBox(this.window!, {
          type: "warning",
          title: "Statement cannot be imported",
          message: "No local financial records were changed.",
          detail,
          buttons: ["Close"],
          noLink: true
        });
        return {
          ok: false,
          message: "The statement failed validation, duplicate, or reconciliation checks. Nothing was imported.",
          selectedFile: { name: basename(selected), size: fileStats.size, extension }
        };
      }
      this.purgeExpiredJapanImportPreviews();
      for (const [previewId, pending] of this.pendingJapanImports) {
        if (pending.candidate.accountId === request.accountId) this.pendingJapanImports.delete(previewId);
      }
      if (this.pendingJapanImports.size >= 8) {
        return { ok: false, message: "Too many statement reviews are open. Cancel an older preview and try again." };
      }
      const previewId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      const importPreview = presentImportPreview({
        previewId,
        accountId: candidate.accountId,
        fileName: candidate.fileName,
        parsed: candidate.parsed,
        preview: candidate.preview,
        expiresAt,
        mappingMatchedCount: candidate.categoryMappingsApplied,
        ...(candidate.categoryMappingFingerprint === undefined
          ? {}
          : { mappingFingerprint: candidate.categoryMappingFingerprint })
      });
      this.pendingJapanImports.set(previewId, {
        candidate,
        selectedPath: selected,
        byteLength: fileStats.size,
        modifiedAtMs: fileStats.mtimeMs,
        maximumBytes,
        expiresAt
      });
      return {
        ok: true,
        message: `Review all ${candidate.preview.candidateTransactions.length} transaction row${candidate.preview.candidateTransactions.length === 1 ? "" : "s"}, signed totals, duplicates, and warnings below. Nothing has been imported yet.`,
        selectedFile: { name: basename(selected), size: fileStats.size, extension },
        importPreview
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The statement could not be parsed safely.";
      await dialog.showMessageBox(this.window!, {
        type: "warning",
        title: "Statement preview failed",
        message: "No local financial records were changed.",
        detail: message,
        buttons: ["Close"],
        noLink: true
      });
      return { ok: false, message };
    } finally {
      bytes?.fill(0);
    }
  }

  private purgeExpiredJapanImportPreviews(): void {
    const now = Date.now();
    for (const [previewId, pending] of this.pendingJapanImports) {
      if (Date.parse(pending.expiresAt) <= now) this.pendingJapanImports.delete(previewId);
    }
  }

  private cancelJapanImport(previewId: string): DesktopActionResult {
    this.purgeExpiredJapanImportPreviews();
    const existed = this.pendingJapanImports.delete(previewId);
    return existed
      ? { ok: true, message: "Statement preview canceled; no local records were changed." }
      : { ok: false, message: "That statement preview expired or was already used. No local records were changed." };
  }

  private async approveJapanImport(previewId: string): Promise<DesktopActionResult> {
    const active = this.active;
    if (!active?.commitJapanImport) {
      return { ok: false, message: "Statement imports are unavailable in synthetic demo mode." };
    }
    this.purgeExpiredJapanImportPreviews();
    const pending = this.pendingJapanImports.get(previewId);
    if (pending === undefined) {
      return { ok: false, message: "That statement preview expired or was already used. Choose and review the file again." };
    }
    // Review tokens are single-use even if a later file, mapping, store, or
    // encrypted-save check fails. A fresh preview is required for every retry.
    this.pendingJapanImports.delete(previewId);
    try {
      await assertImportSourceUnchanged(pending.selectedPath, {
        byteLength: pending.byteLength,
        modifiedAtMs: pending.modifiedAtMs,
        sha256: pending.candidate.preview.sourceFingerprint,
        maximumBytes: pending.maximumBytes
      });
      const committed = await active.commitJapanImport(pending.candidate);
      return {
        ok: true,
        message: `Imported ${committed.imported} reviewed transaction${committed.imported === 1 ? "" : "s"} into the encrypted local account.`,
        selectedFile: {
          name: pending.candidate.fileName,
          size: pending.byteLength,
          extension: extname(pending.candidate.fileName).toLowerCase()
        },
        importSummary: {
          accountId: pending.candidate.accountId,
          fileName: pending.candidate.fileName,
          parsed: pending.candidate.preview.candidateTransactions.length,
          imported: committed.imported,
          duplicatesSkipped: committed.duplicatesSkipped,
          warnings: committed.warningCount,
          ...(committed.periodStart === undefined ? {} : { periodStart: committed.periodStart }),
          ...(committed.periodEnd === undefined ? {} : { periodEnd: committed.periodEnd })
        }
      };
    } catch (error) {
      if (isStorageError(error)) return this.handleAccountWriteFailure(active, error);
      return {
        ok: false,
        message: error instanceof Error
          ? error.message
          : "The reviewed statement could not be committed safely. Nothing was imported."
      };
    }
  }

  private async prepareExportPackage(request: PrepareExportRequest): Promise<DesktopActionResult> {
    const active = this.active;
    if (!active?.previewExport || !active.materializeExport) {
      return { ok: false, message: "Durable exports are unavailable in synthetic demo mode." };
    }
    let candidate: ExportCandidate;
    try {
      candidate = await active.previewExport(request);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "The export preview could not be created." };
    }
    const duplicateReport = candidate.preview.duplicateReport;
    const detail = [
      `Account: ${candidate.account.displayName} (${formatLocalIdentifier(candidate.account.id)})`,
      `Entity: ${candidate.account.legalEntityName}`,
      `Format: ${candidate.preview.plan.mapping.format}`,
      `Selected transactions: ${duplicateReport.selectedTransactionCount}`,
      `Files will contain: ${duplicateReport.eligibleTransactionCount}`,
      `Duplicates excluded: ${duplicateReport.excludedTransactionCount}`,
      `Preview fingerprint: ${candidate.preview.previewFingerprint}`,
      ...candidate.preview.files.map(
        (file) => `${file.fileName} · ${formatBytes(file.byteLength)} · SHA-256 ${file.sha256}`
      ),
      ...candidate.preview.warnings.map((warning) => `Warning: ${warning}`),
      "No accounting API will be called. Only local import files and a checksum manifest can be created."
    ].join("\n");
    const confirmation = await dialog.showMessageBox(this.window!, {
      type: "question",
      title: "Approve this exact export preview?",
      message: `Create files for ${duplicateReport.eligibleTransactionCount} transaction${duplicateReport.eligibleTransactionCount === 1 ? "" : "s"}?`,
      detail,
      buttons: ["Cancel", "Approve exact preview"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) {
      return { ok: false, message: "Export canceled; no package files were created." };
    }
    const folder = await dialog.showOpenDialog(this.window!, {
      title: "Choose the parent folder for the approved export package",
      defaultPath: this.configuration.storage.exportDirectory,
      properties: ["openDirectory", "createDirectory"]
    });
    const parent = folder.filePaths[0];
    if (folder.canceled || !parent) {
      return { ok: false, message: "Export destination selection canceled; no package files were created." };
    }
    const folderName = `${candidate.preview.createdAt.replace(/[:.]/gu, "-")}-${candidate.preview.plan.mapping.format}-${candidate.preview.plan.id.slice(0, 8)}`;
    const destination = resolve(parent, folderName);
    try {
      const materialized = await active.materializeExport(candidate, destination);
      const folderOpenError = await shell.openPath(materialized.destinationDirectory);
      const warnings: string[] = [];
      if (materialized.journalStatus === "completion_unconfirmed") {
        warnings.push(
          `duplicate-prevention completion remains conservatively pending (${materialized.journalFailureCode ?? "EXPORT_JOURNAL_COMPLETION_FAILED"})`
        );
      }
      if (materialized.auditStatus === "unconfirmed") {
        warnings.push(`the encrypted audit receipt was not confirmed (${materialized.auditFailureCode ?? "EXPORT_AUDIT_UNCONFIRMED"})`);
      }
      if (folderOpenError) warnings.push("Windows could not open the folder automatically");
      if (materialized.auditStatus === "unconfirmed") {
        setImmediate(() => {
          void this.handleAccountWriteFailure(
            active,
            new Error(materialized.auditFailureCode ?? "EXPORT_AUDIT_UNCONFIRMED"),
            "The export files were published, but the encrypted audit receipt could not be confirmed. The local query runtime was locked; do not recreate the package."
          );
        });
      }
      return {
        ok: true,
        message: warnings.length === 0
          ? `Created and checksum-verified a human-approved export package with ${materialized.manifest.files.length} data file${materialized.manifest.files.length === 1 ? "" : "s"} plus its manifest.`
          : `Files were created at ${materialized.destinationDirectory}, but local completion evidence needs attention. Do not recreate this package.`,
        exportSummary: {
          accountId: candidate.account.id,
          format: candidate.preview.plan.mapping.format,
          exported: duplicateReport.eligibleTransactionCount,
          duplicatesSkipped: duplicateReport.excludedTransactionCount,
          files: materialized.manifest.files.map((file) => file.fileName),
          destinationDirectory: materialized.destinationDirectory,
          committedPaths: [...materialized.committedPaths],
          publicationStatus: materialized.publicationStatus,
          journalStatus: materialized.journalStatus,
          auditStatus: materialized.auditStatus,
          ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") })
        }
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error
          ? `Export failed closed: ${error.message}`
          : "Export failed closed before a verified package could be returned."
      };
    }
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

function providerFailureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ProviderIntegrationError)) return fallback;
  // ProviderIntegrationError is intentionally a stable, payload-free surface.
  return `${fallback} ${error.message}`;
}

function safeFailureCode(error: unknown, fallback: string): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,80}$/u.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function tunnelView(
  configuration: AppConfiguration,
  status?: TunnelClientStatus
): DesktopSnapshot["tunnel"] {
  const configured = Boolean(
    configuration.tunnel.tunnelId &&
      configuration.tunnel.clientPath &&
      configuration.tunnel.clientSha256 &&
      configuration.tunnel.arguments.length > 0
  );
  const state: DesktopSnapshot["tunnel"]["state"] = !configuration.tunnel.enabled
    ? "disabled"
    : !configured
      ? "not-configured"
      : status?.state ?? "stopped";
  return {
    enabled: configuration.tunnel.enabled,
    autoStart: configuration.tunnel.autoStart,
    configured,
    state,
    ...(configuration.tunnel.tunnelId ? { tunnelIdHint: maskIdentifier(configuration.tunnel.tunnelId) } : {}),
    ...(status?.lastError ? { lastError: status.lastError } : {})
  };
}

function toAccountView(
  account: AmexAccount,
  hasImportedData: boolean,
  inPortfolio: boolean
): AccountSummaryView {
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
    queryReady,
    inPortfolio
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

function importBaselineDigest(
  transactions: readonly FinancialTransaction[],
  statements: readonly Statement[],
  accountId: string
): string {
  const transactionRows = transactions
    .filter((transaction) => transaction.source.accountId === accountId)
    .map((transaction) => `${transaction.id}:${transaction.importFingerprint}`)
    .sort();
  const statementRows = statements
    .filter((statement) => statement.accountId === accountId)
    .map((statement) => `${statement.id}:${statement.sourceFileFingerprint}`)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ transactionRows, statementRows }))
    .digest("hex");
}

function importStatementBalance(
  request: Extract<DesktopRequest, { kind: "import-jp-statement" }>
): StatementBalanceInput | undefined {
  const fields = [request.periodStart, request.periodEnd, request.openingBalance, request.closingBalance];
  if (fields.every((value) => value === undefined)) return undefined;
  if (fields.some((value) => value === undefined)) {
    throw new Error("Statement reconciliation requires both period dates and both signed balances.");
  }
  return {
    periodStart: request.periodStart!,
    periodEnd: request.periodEnd!,
    openingBalance: request.openingBalance!,
    closingBalance: request.closingBalance!,
    currency: "JPY"
  };
}

function buildExportMapping(request: PrepareExportRequest, account: AmexAccount): ExportMapping {
  if (request.format.startsWith("quickbooks_")) {
    if (request.format === "quickbooks_qbo" && !request.bankId) {
      throw new Error("QuickBooks QBO requires the reviewed numeric Intuit bank ID (BID). Use CSV or QFX if you do not have it.");
    }
    const accountReference = request.accountReference ??
      `LOCAL-${createHash("sha256").update(account.id).digest("hex").slice(0, 12)}`;
    return {
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      format: request.format,
      currency: account.currency,
      quickBooks: {
        accountReference,
        accountName: request.accountName,
        ...(request.bankId === undefined ? {} : { bankId: request.bankId })
      }
    };
  }
  if (account.currency !== "JPY") {
    throw new Error("Money Forward files require an explicitly mapped JPY account.");
  }
  if (!request.liabilityAccount || !request.expenseAccount) {
    throw new Error("Money Forward requires reviewed liability and expense account names.");
  }
  return {
    accountId: account.id,
    legalEntityId: account.legalEntityId,
    format: request.format,
    currency: "JPY",
    moneyForward: {
      liabilityAccount: request.liabilityAccount,
      expenseAccount: request.expenseAccount,
      ...(request.department === undefined ? {} : { department: request.department }),
      ...(request.taxCategory === undefined ? {} : { taxCategory: request.taxCategory }),
      ...(request.encoding === undefined ? {} : { encoding: request.encoding })
    }
  };
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
  if (candidate.kind === "update-portfolio") {
    if (
      !isSafeLabel(candidate.name, 80) ||
      !Array.isArray(candidate.accountIds) ||
      candidate.accountIds.length > 256 ||
      !candidate.accountIds.every(isSafeIdentifier) ||
      new Set(candidate.accountIds).size !== candidate.accountIds.length
    ) {
      return undefined;
    }
    return {
      kind: "update-portfolio",
      name: (candidate.name as string).trim(),
      accountIds: [...candidate.accountIds] as string[]
    };
  }
  if (candidate.kind === "set-alert-status") {
    if (
      !isSafeIdentifier(candidate.alertId) ||
      !["reviewed", "dismissed", "confirmed_suspicious"].includes(String(candidate.status))
    ) {
      return undefined;
    }
    return {
      kind: "set-alert-status",
      alertId: candidate.alertId as string,
      status: candidate.status as OwnerAlertDisposition
    };
  }
  if (candidate.kind === "approve-jp-import" || candidate.kind === "cancel-jp-import") {
    if (!isSafeIdentifier(candidate.previewId)) return undefined;
    return { kind: candidate.kind, previewId: candidate.previewId as string };
  }
  if (candidate.kind === "authorize-us-account" || candidate.kind === "sync-us-account") {
    if (!isSafeIdentifier(candidate.accountId)) return undefined;
    return { kind: candidate.kind, accountId: candidate.accountId as string };
  }
  if (candidate.kind === "configure-plaid") {
    if (
      !["sandbox", "production"].includes(String(candidate.environment)) ||
      candidate.confirmedReadOnly !== true ||
      !isSafeCredentialText(candidate.clientId, 256) ||
      !isSafeCredentialText(candidate.clientSecret, 512) ||
      (candidate.redirectUri !== undefined &&
        candidate.redirectUri !== "" &&
        !isSafePlaidRedirectUri(candidate.redirectUri))
    ) {
      return undefined;
    }
    return {
      kind: "configure-plaid",
      environment: candidate.environment as "sandbox" | "production",
      clientId: (candidate.clientId as string).trim(),
      clientSecret: (candidate.clientSecret as string).trim(),
      ...(candidate.environment === "production" && candidate.redirectUri
        ? { redirectUri: (candidate.redirectUri as string).trim() }
        : {}),
      confirmedReadOnly: true
    };
  }
  if (candidate.kind === "remove-plaid-credentials") {
    return { kind: "remove-plaid-credentials" };
  }
  if (candidate.kind === "import-jp-statement") {
    if (!isSafeIdentifier(candidate.accountId)) return undefined;
    const values = [candidate.periodStart, candidate.periodEnd, candidate.openingBalance, candidate.closingBalance];
    const supplied = values.filter((value) => value !== undefined).length;
    if (supplied !== 0 && supplied !== 4) return undefined;
    if (
      supplied === 4 &&
      (!isIsoDate(candidate.periodStart) ||
        !isIsoDate(candidate.periodEnd) ||
        !isPlainMoney(candidate.openingBalance) ||
        !isPlainMoney(candidate.closingBalance))
    ) {
      return undefined;
    }
    return {
      kind: "import-jp-statement",
      accountId: candidate.accountId as string,
      ...(supplied === 0
        ? {}
        : {
            periodStart: candidate.periodStart as string,
            periodEnd: candidate.periodEnd as string,
            openingBalance: candidate.openingBalance as string,
            closingBalance: candidate.closingBalance as string
          })
    };
  }
  if (candidate.kind === "prepare-export") {
    const formats = new Set([
      "quickbooks_csv",
      "quickbooks_qbo",
      "quickbooks_qfx",
      "money_forward_statement_csv",
      "money_forward_journal_csv",
      "money_forward_ledger_csv"
    ]);
    if (
      !isSafeIdentifier(candidate.accountId) ||
      typeof candidate.format !== "string" ||
      !formats.has(candidate.format) ||
      !isSafeLabel(candidate.accountName, 80)
    ) {
      return undefined;
    }
    for (const [field, maximum] of [
      ["liabilityAccount", 80],
      ["expenseAccount", 80],
      ["department", 80],
      ["taxCategory", 80]
    ] as const) {
      if (candidate[field] !== undefined && !isSafeLabel(candidate[field], maximum)) return undefined;
    }
    if (
      candidate.accountReference !== undefined &&
      (typeof candidate.accountReference !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,21}$/u.test(candidate.accountReference))
    ) {
      return undefined;
    }
    if (candidate.bankId !== undefined && (typeof candidate.bankId !== "string" || !/^\d{1,12}$/u.test(candidate.bankId))) {
      return undefined;
    }
    if (candidate.encoding !== undefined && !["utf8_bom", "shift_jis"].includes(String(candidate.encoding))) {
      return undefined;
    }
    return {
      kind: "prepare-export",
      accountId: candidate.accountId as string,
      format: candidate.format as Extract<DesktopRequest, { kind: "prepare-export" }>["format"],
      accountName: (candidate.accountName as string).trim(),
      ...(candidate.accountReference === undefined ? {} : { accountReference: candidate.accountReference }),
      ...(candidate.bankId === undefined ? {} : { bankId: candidate.bankId }),
      ...(candidate.liabilityAccount === undefined ? {} : { liabilityAccount: (candidate.liabilityAccount as string).trim() }),
      ...(candidate.expenseAccount === undefined ? {} : { expenseAccount: (candidate.expenseAccount as string).trim() }),
      ...(candidate.department === undefined ? {} : { department: (candidate.department as string).trim() }),
      ...(candidate.taxCategory === undefined ? {} : { taxCategory: (candidate.taxCategory as string).trim() }),
      ...(candidate.encoding === undefined ? {} : { encoding: candidate.encoding as "utf8_bom" | "shift_jis" })
    };
  }
  if (candidate.kind === "set-tunnel-running") {
    if (typeof candidate.running !== "boolean") return undefined;
    return { kind: "set-tunnel-running", running: candidate.running };
  }
  if (candidate.kind === "set-screenshot-protection") {
    if (typeof candidate.enabled !== "boolean") return undefined;
    return { kind: "set-screenshot-protection", enabled: candidate.enabled };
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

function isSafeCredentialText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function isSafePlaidRedirectUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 2048 ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

async function resolveOptionalSecret(
  resolver: SecretReferenceResolver,
  reference: string
): Promise<Uint8Array | undefined> {
  try {
    return await resolver.resolve(reference);
  } catch (error) {
    if (error instanceof SecretReferenceError && error.code === "SECRET_NOT_FOUND") return undefined;
    throw error;
  }
}

async function restoreOptionalSecret(
  store: SecretReferenceStore,
  reference: string,
  previous: Uint8Array | undefined,
  changed: boolean
): Promise<void> {
  if (!changed) return;
  if (previous === undefined) {
    await store.delete(reference);
    return;
  }
  await store.write(reference, previous);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPlainMoney(value: unknown): value is string {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 40;
}
