import type { CurrencyCode, FinancialTransaction } from "../domain";

export type ExportFormat =
  | "quickbooks_csv"
  | "quickbooks_qbo"
  | "quickbooks_qfx"
  | "money_forward_statement_csv"
  | "money_forward_journal_csv"
  | "money_forward_ledger_csv";

export type TextExportEncoding = "utf8_bom" | "shift_jis";

export interface QuickBooksMapping {
  readonly accountReference: string;
  readonly accountName: string;
  /** Reviewed numeric Intuit financial-institution identifier; required for QBO. */
  readonly bankId?: string;
  /** Optional reconciled balance. It is omitted rather than fabricated when unavailable. */
  readonly ledgerBalance?: string;
}

export interface MoneyForwardMapping {
  readonly liabilityAccount: string;
  readonly expenseAccount: string;
  readonly department?: string;
  readonly taxCategory?: string;
  /** Statement imports generally use UTF-8 BOM; Japanese journal templates often require Shift-JIS. */
  readonly encoding?: TextExportEncoding;
}

export interface ExportMapping {
  readonly accountId: string;
  readonly legalEntityId: string;
  readonly format: ExportFormat;
  readonly currency: CurrencyCode;
  readonly quickBooks?: QuickBooksMapping;
  readonly moneyForward?: MoneyForwardMapping;
}

export interface ExportHistoryRecord {
  readonly format: ExportFormat;
  readonly accountId: string;
  readonly transactionId: string;
  readonly transactionFingerprint: string;
  readonly exportedAt: string;
}

export interface DuplicateExportCandidate {
  readonly transactionId: string;
  readonly fingerprint: string;
  readonly reason: "already_exported" | "duplicate_in_selection";
  readonly matchingTransactionId?: string;
}

export interface ExportPlan {
  readonly id: string;
  readonly requestDigest: string;
  readonly createdAt: string;
  readonly mapping: ExportMapping;
  readonly eligibleTransactions: readonly FinancialTransaction[];
  readonly duplicates: readonly DuplicateExportCandidate[];
}

export interface HumanExportApproval {
  readonly approved: true;
  readonly planId: string;
  readonly requestDigest: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly token: string;
}

export interface ExportFile {
  readonly fileName: string;
  readonly mediaType: string;
  readonly encoding: "binary" | TextExportEncoding;
  readonly bytes: Uint8Array;
}

export interface ExportPackage {
  readonly planId: string;
  readonly format: ExportFormat;
  readonly accountId: string;
  readonly legalEntityId: string;
  readonly createdAt: string;
  readonly files: readonly ExportFile[];
  readonly duplicateReport: readonly DuplicateExportCandidate[];
  readonly historyRecords: readonly ExportHistoryRecord[];
  readonly warnings: readonly string[];
  /** This package is for a human-controlled file import; no posting endpoint exists here. */
  readonly automaticPosting: false;
}
