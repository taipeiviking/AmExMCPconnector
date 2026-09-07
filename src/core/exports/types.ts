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

/** Human-readable duplicate totals shown before an export can be approved. */
export interface ExportDuplicateReport {
  readonly selectedTransactionCount: number;
  readonly eligibleTransactionCount: number;
  readonly excludedTransactionCount: number;
  readonly alreadyExportedCount: number;
  readonly duplicateInSelectionCount: number;
  readonly candidates: readonly DuplicateExportCandidate[];
}

/** A byte-level description of the file that an approved plan will create. */
export interface ExportPreviewFile {
  readonly fileName: string;
  readonly mediaType: string;
  readonly encoding: "binary" | TextExportEncoding;
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * Review surface for a single export. It intentionally contains no file bytes;
 * callers must obtain a one-time HumanExportApproval before materialization.
 */
export interface ExportPreview {
  readonly schemaVersion: 1;
  readonly previewFingerprint: string;
  readonly createdAt: string;
  readonly plan: ExportPlan;
  readonly duplicateReport: ExportDuplicateReport;
  readonly files: readonly ExportPreviewFile[];
  readonly warnings: readonly string[];
  readonly automaticPosting: false;
}

/** Mutable-store snapshot supplied immediately before materialization. */
export interface CurrentExportState {
  readonly mapping: ExportMapping;
  readonly transactions: readonly FinancialTransaction[];
}

export interface HumanExportApproval {
  readonly approved: true;
  readonly planId: string;
  readonly requestDigest: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly token: string;
}

/** Approval object used by the durable workflow; valid for one exact preview and one attempt. */
export interface ApprovedExportPreview extends HumanExportApproval {
  readonly previewFingerprint: string;
  readonly singleUse: true;
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

export interface ExportManifestFile {
  readonly fileName: string;
  readonly mediaType: string;
  readonly encoding: "binary" | TextExportEncoding;
  readonly byteLength: number;
  readonly sha256: string;
}

/** Immutable receipt written beside every approved accounting import file. */
export interface ExportManifest {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly previewFingerprint: string;
  readonly requestDigest: string;
  readonly format: ExportFormat;
  readonly accountId: string;
  readonly legalEntityId: string;
  readonly generatedAt: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly files: readonly ExportManifestFile[];
  readonly packageSha256: string;
  readonly duplicateReport: ExportDuplicateReport;
  readonly historyRecords: readonly ExportHistoryRecord[];
  readonly warnings: readonly string[];
  /** Export materialization only writes files; it never calls an accounting API. */
  readonly automaticPosting: false;
}

export interface MaterializedExportPackage {
  readonly destinationDirectory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: ExportManifest;
}

/**
 * Result of the complete durable workflow. Publication and journal completion
 * are deliberately separate: once files have been atomically published, a
 * later journal-write failure must never be reported as though no files exist.
 */
export interface DurableExportMaterializationResult extends MaterializedExportPackage {
  readonly publicationStatus: "published";
  readonly journalStatus: "completed" | "completion_unconfirmed";
  /** Absolute paths committed by the atomic directory publication. */
  readonly committedPaths: readonly string[];
  /** Stable, non-sensitive diagnostic when journal completion is unconfirmed. */
  readonly journalFailureCode?: string;
}
