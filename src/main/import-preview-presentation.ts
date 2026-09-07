import Decimal from "decimal.js";

import {
  canonicalCurrencyAmount,
  type CurrencyCode,
  type ImportPreview,
  type ParsedTransactionImport,
} from "../core";
import type { DesktopActionResult } from "../shared/ipc";

export const MAX_REVIEWABLE_IMPORT_ROWS = 1_000;

export interface ImportPreviewPresentationInput {
  readonly previewId: string;
  readonly accountId: string;
  readonly fileName: string;
  readonly parsed: ParsedTransactionImport;
  readonly preview: ImportPreview;
  readonly expiresAt: string;
  readonly mappingMatchedCount: number;
  readonly mappingFingerprint?: string;
}

export function presentImportPreview(
  input: ImportPreviewPresentationInput,
): NonNullable<DesktopActionResult["importPreview"]> {
  if (input.preview.candidateTransactions.length > MAX_REVIEWABLE_IMPORT_ROWS) {
    throw new Error(
      `This first-release review screen supports at most ${MAX_REVIEWABLE_IMPORT_ROWS.toLocaleString("en-US")} transaction rows per import. Split the official export into smaller reviewed periods.`,
    );
  }
  if (input.preview.candidateTransactions.length !== input.parsed.normalizedTransactions.length) {
    throw new Error("The normalized import rows no longer match the review candidate.");
  }

  const totals = new Map<CurrencyCode, { total: Decimal; count: number }>();
  const rows = input.preview.candidateTransactions.map((transaction, index) => {
    const current = totals.get(transaction.currency) ?? { total: new Decimal(0), count: 0 };
    current.total = current.total.plus(transaction.amount);
    current.count += 1;
    totals.set(transaction.currency, current);
    const normalized = input.parsed.normalizedTransactions[index];
    if (normalized === undefined) throw new Error("The import preview row is unavailable.");
    return {
      postedAt: transaction.postedAt,
      description: transaction.description,
      amount: transaction.amount,
      currency: transaction.currency,
      categoryId: transaction.categoryId,
      businessPurpose: transaction.source.businessPurpose,
      sourceRow: normalized.sourceRow,
    };
  });

  const warnings = input.preview.issues
    .filter((issue) => issue.severity === "warning")
    .map((issue) => `${issue.row === undefined ? "File" : `Row ${issue.row}`}: ${issue.message}`);

  return {
    previewId: input.previewId,
    accountId: input.accountId,
    fileName: input.fileName,
    format: input.parsed.metadata.format,
    ...(input.parsed.metadata.encoding === undefined ? {} : { encoding: input.parsed.metadata.encoding }),
    sourceFingerprint: input.preview.sourceFingerprint,
    expiresAt: input.expiresAt,
    rows,
    totals: [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
      currency,
      signedTotal: canonicalCurrencyAmount(value.total, currency, "import preview signed total"),
      transactionCount: value.count,
    })),
    duplicateCount: input.preview.duplicateFindings.length,
    warningCount: warnings.length,
    warnings,
    reconciliationStatus: input.preview.reconciliation.status,
    ...(input.preview.reconciliation.difference === undefined
      ? {}
      : { reconciliationDifference: input.preview.reconciliation.difference }),
    mappingMatchedCount: input.mappingMatchedCount,
    ...(input.mappingFingerprint === undefined ? {} : { mappingFingerprint: input.mappingFingerprint }),
  };
}
