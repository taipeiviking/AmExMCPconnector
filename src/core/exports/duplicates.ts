import { createHash } from "node:crypto";

import type { FinancialTransaction } from "../domain";
import { canonicalCurrencyAmount } from "../money";
import type { DuplicateExportCandidate, ExportFormat, ExportHistoryRecord } from "./types";

export interface DuplicateDetectionResult {
  readonly eligible: readonly FinancialTransaction[];
  readonly duplicates: readonly DuplicateExportCandidate[];
}

export function exportTransactionFingerprint(transaction: FinancialTransaction): string {
  return createHash("sha256")
    .update(
      [
        transaction.source.accountId,
        transaction.source.legalEntityId,
        transaction.postedAt,
        canonicalCurrencyAmount(transaction.amount, transaction.currency),
        transaction.currency,
        normalize(transaction.description),
        transaction.externalId ?? "",
      ].join("\u0000"),
    )
    .digest("hex");
}

export function detectExportDuplicates(
  transactions: readonly FinancialTransaction[],
  history: readonly ExportHistoryRecord[],
  format: ExportFormat,
  accountId: string,
): DuplicateDetectionResult {
  const historyFingerprints = new Map(
    history
      .filter((record) => destinationFamily(record.format) === destinationFamily(format) && record.accountId === accountId)
      .map((record) => [record.transactionFingerprint, record.transactionId]),
  );
  const selectedFingerprints = new Map<string, string>();
  const eligible: FinancialTransaction[] = [];
  const duplicates: DuplicateExportCandidate[] = [];
  for (const transaction of transactions) {
    const fingerprint = exportTransactionFingerprint(transaction);
    const exportedMatch = historyFingerprints.get(fingerprint);
    if (exportedMatch !== undefined) {
      duplicates.push({
        transactionId: transaction.id,
        fingerprint,
        reason: "already_exported",
        matchingTransactionId: exportedMatch,
      });
      continue;
    }
    const selectedMatch = selectedFingerprints.get(fingerprint);
    if (selectedMatch !== undefined) {
      duplicates.push({
        transactionId: transaction.id,
        fingerprint,
        reason: "duplicate_in_selection",
        matchingTransactionId: selectedMatch,
      });
      continue;
    }
    selectedFingerprints.set(fingerprint, transaction.id);
    eligible.push(transaction);
  }
  return { eligible, duplicates };
}

function destinationFamily(format: ExportFormat): "quickbooks" | "money_forward" {
  return format.startsWith("quickbooks_") ? "quickbooks" : "money_forward";
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}
