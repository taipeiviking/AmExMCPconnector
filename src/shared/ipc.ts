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
  | "run-safe-test-drive"
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
  | { kind: "disconnect-account"; accountId: string };

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
  baseCurrency: string;
  storage: {
    state: "locked" | "unlocked" | "unavailable";
    protection: string;
    dataDirectory: string;
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
    state: "disabled" | "manual" | "not-configured";
    tunnelIdHint?: string;
  };
  accounts: AccountSummaryView[];
  alerts: AlertSummaryView[];
  audit: AuditSummaryView[];
  notices: string[];
}

export interface DesktopActionResult {
  ok: boolean;
  message: string;
  selectedFile?: {
    name: string;
    size: number;
    extension: string;
  };
  testDrive?: LocalTestDriveResult;
}

export interface DesktopBridge {
  getSnapshot(): Promise<DesktopSnapshot>;
  performAction(request: DesktopRequest): Promise<DesktopActionResult>;
}
