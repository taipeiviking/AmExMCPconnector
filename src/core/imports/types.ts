import type {
  AmexAccount,
  CurrencyCode,
  FinancialTransaction,
  TransactionSource,
} from "../domain";
import type { IsoCountryCode } from "../country-codes";

export type ImportEncoding = "utf8" | "shift_jis" | "cp932";
export type ImportEncodingPreference = ImportEncoding | "auto";
export type StatementImportFormat = "csv" | "qif" | "xlsx" | "pdf";
export type AmountConvention = "amex_charges_positive" | "signed_ledger";

export interface ImportContext {
  readonly account: AmexAccount;
  readonly importedAt: string;
  readonly sourceFileName?: string;
}

export interface ImportIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly row?: number;
}

/**
 * Format-independent, persistence-free representation produced before a
 * transaction is assigned its deterministic local id. Amounts use signed
 * ledger semantics: charges are negative and credits/payments are positive.
 */
export interface NormalizedImportTransaction {
  readonly sourceRow: number;
  readonly externalId?: string;
  readonly source: TransactionSource;
  readonly postedAt: string;
  readonly description: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly categoryId: string | null;
  readonly memo: string | null;
  readonly merchantCountry?: IsoCountryCode;
}

export interface ImportMetadata {
  readonly format: StatementImportFormat;
  readonly encoding?: ImportEncoding;
  readonly sourceFileName?: string;
  readonly worksheetName?: string;
  readonly pdfTextStreamCount?: number;
  readonly inputBytes: number;
  readonly parsedRows: number;
}

export interface ParsedTransactionImport {
  readonly sourceFingerprint: string;
  readonly normalizedTransactions: readonly NormalizedImportTransaction[];
  readonly transactions: readonly FinancialTransaction[];
  readonly issues: readonly ImportIssue[];
  readonly metadata: ImportMetadata;
}

export interface CsvColumnMap {
  readonly date?: string;
  readonly description?: string;
  readonly amount?: string;
  readonly debit?: string;
  readonly credit?: string;
  readonly reference?: string;
  readonly category?: string;
  readonly memo?: string;
  readonly merchantCountry?: string;
  readonly businessPurpose?: string;
}
