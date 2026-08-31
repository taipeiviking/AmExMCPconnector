import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { FinancialTransaction } from "../domain";
import { DuplicateExportError, ExportApprovalError, ValidationError } from "../errors";
import { canonicalCurrencyAmount } from "../money";
import { assertIsoDate } from "../validation";
import { detectExportDuplicates } from "./duplicates";
import type { ExportHistoryRecord, ExportMapping, ExportPlan } from "./types";

export function planExport(input: {
  readonly mapping: ExportMapping;
  readonly transactions: readonly FinancialTransaction[];
  readonly history?: readonly ExportHistoryRecord[];
  readonly createdAt: string;
}): ExportPlan {
  if (input.transactions.length === 0) throw new ValidationError("At least one transaction is required for export");
  validateMapping(input.mapping);
  for (const transaction of input.transactions) {
    assertIsoDate(transaction.postedAt, "transaction.postedAt");
    if (transaction.source.accountId !== input.mapping.accountId) {
      throw new ValidationError("Export cannot mix source accounts", { transactionId: transaction.id });
    }
    if (transaction.source.legalEntityId !== input.mapping.legalEntityId) {
      throw new ValidationError("Export cannot mix legal entities", { transactionId: transaction.id });
    }
    if (transaction.currency !== input.mapping.currency) {
      throw new ValidationError("Export cannot mix currencies", { transactionId: transaction.id });
    }
  }
  const detection = detectExportDuplicates(
    input.transactions,
    input.history ?? [],
    input.mapping.format,
    input.mapping.accountId,
  );
  if (detection.eligible.length === 0) {
    throw new DuplicateExportError("Every selected transaction was detected as a duplicate", {
      duplicateCount: detection.duplicates.length,
    });
  }
  const requestDigest = computeExportRequestDigest({
    mapping: input.mapping,
    eligibleTransactions: detection.eligible,
    duplicates: detection.duplicates,
  });
  return {
    id: randomUUID(),
    requestDigest,
    createdAt: input.createdAt,
    mapping: structuredClone(input.mapping),
    eligibleTransactions: structuredClone(detection.eligible),
    duplicates: structuredClone(detection.duplicates),
  };
}

/** Canonical digest of every plan field that can affect generated package bytes or its duplicate report. */
export function computeExportRequestDigest(
  plan: Pick<ExportPlan, "mapping" | "eligibleTransactions" | "duplicates">,
): string {
  return createHash("sha256")
    .update(
      stableJson({
        mapping: plan.mapping,
        eligibleTransactions: plan.eligibleTransactions,
        duplicates: plan.duplicates,
      }),
    )
    .digest("hex");
}

/** Revalidates a plan immediately before bytes are rendered. */
export function assertExportPlanIntegrity(plan: ExportPlan): void {
  const actual = Buffer.from(computeExportRequestDigest(plan), "hex");
  const recorded = Buffer.from(plan.requestDigest, "hex");
  if (actual.length !== recorded.length || !timingSafeEqual(actual, recorded)) {
    throw new ExportApprovalError("Export plan contents changed after planning and require fresh human approval", {
      planId: plan.id,
    });
  }
}

function validateMapping(mapping: ExportMapping): void {
  if (mapping.accountId.trim().length === 0 || mapping.legalEntityId.trim().length === 0) {
    throw new ValidationError("Export account and legal entity mappings are required");
  }
  if (mapping.format.startsWith("quickbooks_") && mapping.quickBooks === undefined) {
    throw new ValidationError("QuickBooks export mapping is required for this format");
  }
  if (mapping.quickBooks !== undefined) {
    if (mapping.quickBooks.accountName.trim().length === 0) {
      throw new ValidationError("QuickBooks account name is required");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,21}$/u.test(mapping.quickBooks.accountReference)) {
      throw new ValidationError("QuickBooks OFX accountReference must be a reviewed 1-22 character ASCII identifier");
    }
    if (mapping.quickBooks.bankId !== undefined && !/^\d{1,12}$/u.test(mapping.quickBooks.bankId)) {
      throw new ValidationError("QuickBooks bankId must be a reviewed numeric Intuit BID");
    }
    if (mapping.format === "quickbooks_qbo" && mapping.quickBooks.bankId === undefined) {
      throw new ValidationError("QuickBooks QBO export requires a reviewed bankId/Intuit BID");
    }
    if (mapping.quickBooks.ledgerBalance !== undefined) {
      canonicalCurrencyAmount(mapping.quickBooks.ledgerBalance, mapping.currency, "QuickBooks ledger balance");
    }
  }
  if (mapping.format.startsWith("money_forward_") && mapping.moneyForward === undefined) {
    throw new ValidationError("Money Forward export mapping is required for this format");
  }
  if (mapping.format.startsWith("money_forward_") && mapping.currency !== "JPY") {
    throw new ValidationError("Money Forward export packages require an explicit JPY account mapping");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}
