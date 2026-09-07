import Decimal from "decimal.js";

import type { CurrencyCode, FinancialTransaction } from "../domain";
import { ValidationError } from "../errors";
import { canonicalCurrencyAmount, parseCurrencyAmount } from "../money";
import { assertIsoDate, validateTransaction } from "../validation";
import type { ImportIssue, ParsedTransactionImport } from "./types";

export type ImportDuplicateClassification =
  | "within_file"
  | "already_imported"
  | "external_id_conflict"
  | "source_file_already_imported";

export interface ImportDuplicateFinding {
  readonly classification: ImportDuplicateClassification;
  readonly transactionId?: string;
  readonly matchesTransactionId?: string;
  readonly externalId?: string;
  readonly message: string;
}

export interface StatementBalanceInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalance: string;
  readonly closingBalance: string;
  readonly currency: CurrencyCode;
}

export interface ImportReconciliationPreview {
  readonly status: "not_requested" | "reconciled" | "mismatch";
  readonly transactionActivity?: string;
  readonly expectedClosingBalance?: string;
  readonly reportedClosingBalance?: string;
  readonly difference?: string;
  readonly outsidePeriodTransactionIds: readonly string[];
}

export interface ImportPreviewOptions {
  readonly existingTransactions?: readonly FinancialTransaction[];
  readonly existingSourceFingerprints?: readonly string[];
  readonly statementBalance?: StatementBalanceInput;
}

export interface ImportPreview {
  readonly sourceFingerprint: string;
  readonly candidateTransactions: readonly FinancialTransaction[];
  readonly acceptedTransactions: readonly FinancialTransaction[];
  readonly duplicateFindings: readonly ImportDuplicateFinding[];
  readonly issues: readonly ImportIssue[];
  readonly reconciliation: ImportReconciliationPreview;
  /** True only when there are valid new rows and no issue needing human review. */
  readonly readyForHumanApproval: boolean;
}

export function buildImportPreview(
  parsed: ParsedTransactionImport,
  options: ImportPreviewOptions = {},
): ImportPreview {
  const existing = options.existingTransactions ?? [];
  const duplicates: ImportDuplicateFinding[] = [];
  const rejectedTransactions = new Set<FinancialTransaction>();
  const priorFingerprint = new Map(existing.map((transaction) => [transaction.importFingerprint, transaction]));
  const priorExternalId = new Map(
    existing.flatMap((transaction) => transaction.externalId === undefined
      ? []
      : [[externalKey(transaction), transaction] as const]),
  );
  const withinFingerprint = new Map<string, FinancialTransaction>();
  const withinExternalId = new Map<string, FinancialTransaction>();

  const sourceAlreadyImported = new Set(options.existingSourceFingerprints ?? []).has(parsed.sourceFingerprint);
  if (sourceAlreadyImported) {
    duplicates.push({
      classification: "source_file_already_imported",
      message: "This exact statement file fingerprint has already been imported",
    });
    for (const transaction of parsed.transactions) rejectedTransactions.add(transaction);
  }

  for (const transaction of parsed.transactions) {
    const sameFile = withinFingerprint.get(transaction.importFingerprint);
    if (sameFile !== undefined) {
      duplicates.push({
        classification: "within_file",
        transactionId: transaction.id,
        matchesTransactionId: sameFile.id,
        ...(transaction.externalId === undefined ? {} : { externalId: transaction.externalId }),
        message: "The statement repeats a transaction with the same normalized fingerprint",
      });
      rejectedTransactions.add(transaction);
    } else {
      withinFingerprint.set(transaction.importFingerprint, transaction);
    }

    const imported = priorFingerprint.get(transaction.importFingerprint);
    if (imported !== undefined) {
      duplicates.push({
        classification: "already_imported",
        transactionId: transaction.id,
        matchesTransactionId: imported.id,
        ...(transaction.externalId === undefined ? {} : { externalId: transaction.externalId }),
        message: "An existing transaction has the same normalized import fingerprint",
      });
      rejectedTransactions.add(transaction);
    }

    if (transaction.externalId !== undefined) {
      const key = externalKey(transaction);
      const other = priorExternalId.get(key) ?? withinExternalId.get(key);
      if (other !== undefined && other.importFingerprint !== transaction.importFingerprint) {
        duplicates.push({
          classification: "external_id_conflict",
          transactionId: transaction.id,
          matchesTransactionId: other.id,
          externalId: transaction.externalId,
          message: "The same account/reference id has different normalized transaction details",
        });
        rejectedTransactions.add(transaction);
      } else if (!withinExternalId.has(key)) {
        withinExternalId.set(key, transaction);
      }
    }
  }

  const validationIssues: ImportIssue[] = parsed.transactions.flatMap((transaction) =>
    validateTransaction(transaction).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
    })),
  );
  const issues = [...parsed.issues, ...validationIssues];
  const acceptedTransactions = parsed.transactions.filter((transaction) => !rejectedTransactions.has(transaction));
  const reconciliation = reconcileImport(parsed.transactions, options.statementBalance);
  return {
    sourceFingerprint: parsed.sourceFingerprint,
    candidateTransactions: parsed.transactions,
    acceptedTransactions,
    duplicateFindings: duplicates,
    issues,
    reconciliation,
    readyForHumanApproval:
      acceptedTransactions.length > 0 &&
      duplicates.length === 0 &&
      !issues.some((issue) => issue.severity === "error") &&
      reconciliation.status !== "mismatch",
  };
}

function reconcileImport(
  transactions: readonly FinancialTransaction[],
  balance: StatementBalanceInput | undefined,
): ImportReconciliationPreview {
  if (balance === undefined) return { status: "not_requested", outsidePeriodTransactionIds: [] };
  assertIsoDate(balance.periodStart, "statement period start");
  assertIsoDate(balance.periodEnd, "statement period end");
  if (balance.periodStart > balance.periodEnd) throw new ValidationError("Statement period start is after its end");
  const opening = parseCurrencyAmount(balance.openingBalance, balance.currency, "opening balance");
  const closing = parseCurrencyAmount(balance.closingBalance, balance.currency, "closing balance");
  let activity = new Decimal(0);
  const outsidePeriod: string[] = [];
  for (const transaction of transactions) {
    if (transaction.currency !== balance.currency) {
      throw new ValidationError("Statement balance currency differs from a parsed transaction", {
        transactionId: transaction.id,
      });
    }
    activity = activity.plus(parseCurrencyAmount(transaction.amount, transaction.currency, "transaction amount"));
    if (transaction.postedAt < balance.periodStart || transaction.postedAt > balance.periodEnd) {
      outsidePeriod.push(transaction.id);
    }
  }
  const expected = opening.plus(activity);
  const difference = closing.minus(expected);
  return {
    status: difference.isZero() && outsidePeriod.length === 0 ? "reconciled" : "mismatch",
    transactionActivity: canonicalCurrencyAmount(activity, balance.currency, "statement activity"),
    expectedClosingBalance: canonicalCurrencyAmount(expected, balance.currency, "expected closing balance"),
    reportedClosingBalance: canonicalCurrencyAmount(closing, balance.currency, "reported closing balance"),
    difference: canonicalCurrencyAmount(difference, balance.currency, "reconciliation difference"),
    outsidePeriodTransactionIds: outsidePeriod,
  };
}

function externalKey(transaction: FinancialTransaction): string {
  return `${transaction.source.accountId}\u0000${transaction.externalId ?? ""}`;
}
