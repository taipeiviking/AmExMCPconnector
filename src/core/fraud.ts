import { createHash } from "node:crypto";

import type { CurrencyCode, FinancialTransaction, FraudAlert } from "./domain";
import { canonicalCurrencyAmount, parseCurrencyAmount } from "./money";

export interface AnomalyDetectionOptions {
  readonly largeAmountThresholds: Readonly<Partial<Record<CurrencyCode, string>>>;
  readonly detectedAt: string;
}

/**
 * Deterministic, review-only heuristics. Results are not a conclusion that fraud occurred.
 */
export function detectReviewOnlyAlerts(
  transactions: readonly FinancialTransaction[],
  options: AnomalyDetectionOptions,
): readonly FraudAlert[] {
  const alerts: FraudAlert[] = [];
  const byDuplicateKey = new Map<string, FinancialTransaction[]>();

  for (const transaction of transactions) {
    const threshold = options.largeAmountThresholds[transaction.currency];
    const amount = parseCurrencyAmount(transaction.amount, transaction.currency);
    if (threshold !== undefined && amount.abs().greaterThanOrEqualTo(parseCurrencyAmount(threshold, transaction.currency, "alert threshold"))) {
      alerts.push(
        alert({
          kind: "large_amount",
          accountId: transaction.source.accountId,
          transactionIds: [transaction.id],
          severity: "medium",
          title: "Large transaction needs review",
          explanation: `The absolute amount meets the configured ${transaction.currency} review threshold.`,
          evidence: [`transaction:${transaction.id}`, `threshold:${threshold} ${transaction.currency}`],
          detectedAt: options.detectedAt,
        }),
      );
    }

    if (transaction.merchantCountry !== undefined && transaction.merchantCountry !== transaction.source.country) {
      alerts.push(
        alert({
          kind: "unusual_country",
          accountId: transaction.source.accountId,
          transactionIds: [transaction.id],
          severity: "low",
          title: "Cross-border transaction needs review",
          explanation: "The merchant country differs from the account country.",
          evidence: [
            `transaction:${transaction.id}`,
            `account-country:${transaction.source.country}`,
            `merchant-country:${transaction.merchantCountry}`,
          ],
          detectedAt: options.detectedAt,
        }),
      );
    }

    const duplicateKey = [
      transaction.source.accountId,
      transaction.postedAt,
      canonicalCurrencyAmount(transaction.amount, transaction.currency),
      transaction.currency,
      normalize(transaction.merchantName ?? transaction.description),
    ].join("|");
    const group = byDuplicateKey.get(duplicateKey) ?? [];
    group.push(transaction);
    byDuplicateKey.set(duplicateKey, group);
  }

  for (const group of byDuplicateKey.values()) {
    if (group.length < 2) continue;
    const transactionIds = group.map((transaction) => transaction.id).sort();
    const first = group[0];
    if (first === undefined) continue;
    alerts.push(
      alert({
        kind: "possible_duplicate",
        accountId: first.source.accountId,
        transactionIds,
        severity: "high",
        title: "Possible duplicate transactions need review",
        explanation: "Multiple transactions share the same account, date, amount, currency, and merchant text.",
        evidence: transactionIds.map((id) => `transaction:${id}`),
        detectedAt: options.detectedAt,
      }),
    );
  }

  return alerts.sort((left, right) => left.id.localeCompare(right.id));
}

function alert(input: {
  readonly kind: FraudAlert["kind"];
  readonly accountId: string;
  readonly transactionIds: readonly string[];
  readonly severity: FraudAlert["severity"];
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly detectedAt: string;
}): FraudAlert {
  const digest = createHash("sha256")
    .update([input.kind, input.accountId, ...input.transactionIds].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return {
    id: `alert_${digest}`,
    accountId: input.accountId,
    transactionIds: [...input.transactionIds],
    kind: input.kind,
    severity: input.severity,
    status: "open",
    title: input.title,
    explanation: input.explanation,
    evidence: [...input.evidence],
    reviewOnly: true,
    detectedAt: input.detectedAt,
  };
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}
