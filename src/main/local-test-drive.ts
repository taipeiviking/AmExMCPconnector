import {
  buildImportPreview,
  detectReviewOnlyAlerts,
  parseStatementCsv,
  previewExport,
  type AmexAccount,
  type ExportFormat,
  type ExportMapping
} from "../core";
import type { LocalTestDriveResult } from "../shared/ipc";

export interface LocalRuntimeHealth {
  storageState: "locked" | "unlocked" | "unavailable";
  mcpMode: "disabled" | "local" | "tunnel";
  mcpState: string;
  mcpExposure: string;
  toolCount: number;
}

/** Runs a synthetic parser dry-run entirely in memory. No account, statement,
 * transaction, token, or file is written to the encrypted store. */
export function runLocalTestDrive(health: LocalRuntimeHealth): LocalTestDriveResult {
  const importedAt = "2026-08-31T00:00:00.000Z";
  const account: AmexAccount = {
    id: "synthetic-test-account",
    displayName: "Synthetic Japan company card",
    legalEntityId: "synthetic-company",
    legalEntityName: "Example Company (synthetic)",
    country: "JP",
    currency: "JPY",
    accountClass: "company",
    businessPurpose: "Local onboarding test",
    collectionMethod: "statement_import",
    authorization: { state: "import_only", checkedAt: importedAt },
    active: true,
    createdAt: importedAt,
    updatedAt: importedAt
  };
  const bytes = Buffer.from("date,description,amount,country\n2026-08-30,Synthetic test purchase,1200,GB\n", "utf8");
  const parsed = parseStatementCsv(bytes, { account, importedAt }, { encoding: "utf8" });
  bytes.fill(0);
  const transaction = parsed.transactions[0];
  const importPreview = buildImportPreview(parsed, {
    statementBalance: {
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      openingBalance: "0",
      closingBalance: "-1200",
      currency: "JPY"
    }
  });
  const alerts = transaction === undefined
    ? []
    : detectReviewOnlyAlerts([transaction], {
        detectedAt: importedAt,
        largeAmountThresholds: { JPY: "1000" }
      });
  const exportFormats: readonly ExportFormat[] = [
    "quickbooks_csv",
    "quickbooks_qbo",
    "quickbooks_qfx",
    "money_forward_statement_csv",
    "money_forward_journal_csv",
    "money_forward_ledger_csv"
  ];
  const exportPreviews = transaction === undefined
    ? []
    : exportFormats.map((format) =>
        previewExport({
          mapping: syntheticExportMapping(account, format),
          transactions: [transaction],
          createdAt: importedAt
        })
      );
  const mcpBoundaryReady = health.mcpMode === "disabled"
    ? health.mcpState === "stopped"
    : health.mcpState === "running" && health.mcpExposure === "loopback-only";

  const checks = [
    {
      id: "storage",
      label: "Encrypted local store",
      passed: health.storageState === "unlocked",
      detail: health.storageState === "unlocked" ? "Unlocked for this Windows user." : `State: ${health.storageState}.`
    },
    {
      id: "loopback",
      label: "Private local MCP posture",
      passed: mcpBoundaryReady,
      detail: health.mcpMode === "disabled"
        ? health.mcpState === "stopped"
          ? "Safely disabled by the packaged local-only default; no listener is open."
          : `Disabled mode unexpectedly reports state: ${health.mcpState}.`
        : mcpBoundaryReady
          ? "Running on this PC only; no public listener."
          : `Configured mode: ${health.mcpMode}; state: ${health.mcpState}; exposure: ${health.mcpExposure}.`
    },
    {
      id: "tools",
      label: "Read-only ChatGPT boundary",
      passed: health.toolCount === 7,
      detail: `${health.toolCount} approved read-only tools are registered.`
    },
    {
      id: "import",
      label: "Synthetic Japan statement dry-run",
      passed:
        parsed.issues.every((issue) => issue.severity !== "error") &&
        parsed.transactions.length === 1 &&
        transaction?.amount === "-1200" &&
        transaction.merchantCountry === "GB",
      detail: "Parsed one synthetic JPY company-card row in memory and discarded it; no financial data was saved."
    },
    {
      id: "reconciliation",
      label: "Validation, duplicate, and balance checks",
      passed:
        importPreview.readyForHumanApproval &&
        importPreview.duplicateFindings.length === 0 &&
        importPreview.reconciliation.status === "reconciled",
      detail: "Validated the synthetic row, checked duplicates, and reconciled its signed statement balance in memory."
    },
    {
      id: "alerts",
      label: "Review-only alert detection",
      passed:
        alerts.length === 2 &&
        alerts.every((alert) => alert.reviewOnly && alert.status === "open"),
      detail: "Detected synthetic high-value and cross-border review signals without taking a card or dispute action."
    },
    {
      id: "exports",
      label: "Human-reviewed accounting exports",
      passed:
        exportPreviews.length === exportFormats.length &&
        exportPreviews.every(
          (preview) =>
            preview.automaticPosting === false &&
            preview.files.length === 1 &&
            preview.files[0]!.byteLength > 0 &&
            /^[a-f0-9]{64}$/u.test(preview.files[0]!.sha256)
        ),
      detail: "Rendered previews for QuickBooks CSV/QBO/QFX and three Money Forward formats in memory; no file was posted or saved."
    }
  ];

  return { passed: checks.every((check) => check.passed), checks };
}

function syntheticExportMapping(account: AmexAccount, format: ExportFormat): ExportMapping {
  const base = {
    accountId: account.id,
    legalEntityId: account.legalEntityId,
    currency: account.currency,
    format
  } as const;
  if (format.startsWith("quickbooks_")) {
    return {
      ...base,
      quickBooks: {
        accountReference: "SYNTHETIC-JP",
        accountName: "Synthetic Japan card",
        ...(format === "quickbooks_qbo" ? { bankId: "1234" } : {})
      }
    };
  }
  return {
    ...base,
    moneyForward: {
      liabilityAccount: "Synthetic card payable",
      expenseAccount: "Synthetic test expense",
      encoding: "utf8_bom"
    }
  };
}
