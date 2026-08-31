import type { AmexAccount, FinancialTransaction } from "../domain";

export type ImportEncoding = "utf8" | "shift_jis";
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

export interface ParsedTransactionImport {
  readonly sourceFingerprint: string;
  readonly transactions: readonly FinancialTransaction[];
  readonly issues: readonly ImportIssue[];
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
