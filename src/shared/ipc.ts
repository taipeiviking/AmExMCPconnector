export const IPC = {
  getSnapshot: "app:get-snapshot",
  performAction: "app:perform-action"
} as const;

export type DesktopAction =
  | "refresh"
  | "authorize-us-account"
  | "import-jp-statement"
  | "prepare-export"
  | "open-data-folder"
  | "open-export-folder"
  | "open-log-folder"
  | "open-tunnel-docs"
  | "open-plaid-dashboard"
  | "preflight-us-provider"
  | "run-safe-test-drive"
  | "save-synthetic-sample-statement"
  | "delete-all-local-data"
  | "lock";

export type DesktopRequest =
  | DesktopAction
  | {
      kind: "add-account";
      country: "US" | "JP";
      accountClass: "personal" | "company";
      label: string;
      legalEntityName: string;
    }
  | { kind: "rename-account"; accountId: string; label: string }
  | { kind: "disconnect-account"; accountId: string }
  | { kind: "update-portfolio"; name: string; accountIds: string[] }
  | {
      kind: "set-alert-status";
      alertId: string;
      status: "reviewed" | "dismissed" | "confirmed_suspicious";
    }
  | {
      kind: "import-jp-statement";
      accountId: string;
      periodStart?: string;
      periodEnd?: string;
      openingBalance?: string;
      closingBalance?: string;
    }
  | { kind: "approve-jp-import"; previewId: string }
  | { kind: "cancel-jp-import"; previewId: string }
  | { kind: "authorize-us-account"; accountId: string }
  | {
      kind: "configure-plaid";
      environment: "sandbox" | "production";
      clientId: string;
      clientSecret: string;
      redirectUri?: string;
      confirmedReadOnly: true;
    }
  | { kind: "remove-plaid-credentials" }
  | { kind: "set-screenshot-protection"; enabled: boolean }
  | {
      kind: "prepare-export";
      accountId: string;
      format:
        | "quickbooks_csv"
        | "quickbooks_qbo"
        | "quickbooks_qfx"
        | "money_forward_statement_csv"
        | "money_forward_journal_csv"
        | "money_forward_ledger_csv";
      accountName: string;
      accountReference?: string;
      bankId?: string;
      liabilityAccount?: string;
      expenseAccount?: string;
      department?: string;
      taxCategory?: string;
      encoding?: "utf8_bom" | "shift_jis";
    }
  | { kind: "sync-us-account"; accountId: string }
  | { kind: "set-tunnel-running"; running: boolean };

export interface LocalTestDriveCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface LocalTestDriveResult {
  passed: boolean;
  checks: LocalTestDriveCheck[];
}

export interface UsProviderReadinessStep {
  id:
    | "provider-access"
    | "provider-settings"
    | "windows-credentials"
    | "restart-app"
    | "choose-japan-import";
  status: "complete" | "action-required" | "available";
  label: string;
  guidance: string;
}

export interface UsProviderReadiness {
  state:
    | "ready"
    | "disabled"
    | "storage-unavailable"
    | "configuration-error"
    | "credentials-missing"
    | "credential-store-unavailable";
  canStartConsent: boolean;
  checkedAt: string;
  headline: string;
  explanation: string;
  steps: UsProviderReadinessStep[];
  safeguards: {
    readOnly: true;
    amexPasswordAccepted: false;
    secretsExposed: false;
  };
}

export interface AccountSummaryView {
  id: string;
  name: string;
  legalEntity: string;
  country: "US" | "JP";
  currency: string;
  accountClass: "personal" | "company";
  authorizationState: string;
  syncState: string;
  localIdentifier: string;
  connectionType: "read_only_consent" | "official_statement_import";
  active: boolean;
  queryReady: boolean;
  inPortfolio: boolean;
}

export interface AlertSummaryView {
  id: string;
  accountId: string;
  title: string;
  severity: string;
  status: string;
  detectedAt: string;
  explanation: string;
}

export interface AuditSummaryView {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  target: string;
}

export interface DesktopSnapshot {
  generatedAt: string;
  version: string;
  environment: string;
  demoMode: boolean;
  portfolioId: string;
  portfolio: {
    id: string;
    name: string;
    accountIds: string[];
    editable: boolean;
  };
  baseCurrency: string;
  storage: {
    state: "locked" | "unlocked" | "unavailable";
    protection: string;
    dataDirectory: string;
  };
  privacy: {
    screenshotProtectionEnabled: boolean;
    screenshotControlAvailable: boolean;
    settingScope: "session";
  };
  mcp: {
    state: string;
    endpoint?: string;
    toolCount: 7;
    exposure: "loopback-only";
  };
  tunnel: {
    enabled: boolean;
    autoStart: boolean;
    configured: boolean;
    state: "disabled" | "stopped" | "starting" | "running" | "stopping" | "error" | "not-configured";
    tunnelIdHint?: string;
    lastError?: string;
  };
  provider: {
    configured: boolean;
    adapter: string;
    environment: "sandbox" | "production";
    setupSupported: boolean;
  };
  accounts: AccountSummaryView[];
  alerts: AlertSummaryView[];
  audit: AuditSummaryView[];
  notices: string[];
}

export interface DesktopActionResult {
  ok: boolean;
  message: string;
  providerReadiness?: UsProviderReadiness;
  selectedFile?: {
    name: string;
    size: number;
    extension: string;
  };
  testDrive?: LocalTestDriveResult;
  importPreview?: {
    previewId: string;
    accountId: string;
    fileName: string;
    format: string;
    encoding?: string;
    sourceFingerprint: string;
    expiresAt: string;
    rows: Array<{
      postedAt: string;
      description: string;
      amount: string;
      currency: string;
      categoryId: string | null;
      businessPurpose: string | null;
      sourceRow: number;
    }>;
    totals: Array<{ currency: string; signedTotal: string; transactionCount: number }>;
    duplicateCount: number;
    warningCount: number;
    warnings: string[];
    reconciliationStatus: string;
    reconciliationDifference?: string;
    mappingMatchedCount: number;
    mappingFingerprint?: string;
  };
  importSummary?: {
    accountId: string;
    fileName: string;
    parsed: number;
    imported: number;
    duplicatesSkipped: number;
    warnings: number;
    periodStart?: string;
    periodEnd?: string;
  };
  exportSummary?: {
    accountId: string;
    format: string;
    exported: number;
    duplicatesSkipped: number;
    files: string[];
    destinationDirectory: string;
    committedPaths: string[];
    publicationStatus: "published";
    journalStatus: "completed" | "completion_unconfirmed";
    auditStatus: "recorded" | "unconfirmed";
    warning?: string;
  };
}

export interface DesktopBridge {
  getSnapshot(): Promise<DesktopSnapshot>;
  performAction(request: DesktopRequest): Promise<DesktopActionResult>;
}
