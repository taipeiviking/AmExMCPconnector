import Decimal from "decimal.js";

import type { FinancialTransaction, Statement } from "./domain";
import { canonicalCurrencyAmount, parseCurrencyAmount } from "./money";

export interface ReconciliationIssue {
  readonly code:
    | "MISSING_TRANSACTION"
    | "UNEXPECTED_TRANSACTION"
    | "OUTSIDE_PERIOD"
    | "CURRENCY_MISMATCH"
    | "BALANCE_MISMATCH";
  readonly transactionId?: string;
  readonly message: string;
}

export interface ReconciliationResult {
  readonly status: "reconciled" | "mismatch";
  readonly expectedClosingBalance: string;
  readonly reportedClosingBalance: string;
  readonly difference: string;
  readonly matchedTransactionCount: number;
  readonly issues: readonly ReconciliationIssue[];
}

export function reconcileStatement(
  statement: Statement,
  transactions: readonly FinancialTransaction[],
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const byId = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const expectedIds = new Set(statement.transactionIds);
  let activity = new Decimal(0);
  let matched = 0;

  for (const transactionId of statement.transactionIds) {
    const transaction = byId.get(transactionId);
    if (transaction === undefined) {
      issues.push({ code: "MISSING_TRANSACTION", transactionId, message: "Statement transaction is not in the ledger" });
      continue;
    }
    matched += 1;
    if (transaction.postedAt < statement.periodStart || transaction.postedAt > statement.periodEnd) {
      issues.push({ code: "OUTSIDE_PERIOD", transactionId, message: "Transaction date is outside the statement period" });
    }
    if (transaction.currency !== statement.closingBalance.currency) {
      issues.push({ code: "CURRENCY_MISMATCH", transactionId, message: "Transaction currency differs from statement currency" });
      continue;
    }
    activity = activity.plus(parseCurrencyAmount(transaction.amount, transaction.currency));
  }

  for (const transaction of transactions) {
    if (
      transaction.source.accountId === statement.accountId &&
      transaction.postedAt >= statement.periodStart &&
      transaction.postedAt <= statement.periodEnd &&
      !expectedIds.has(transaction.id)
    ) {
      issues.push({
        code: "UNEXPECTED_TRANSACTION",
        transactionId: transaction.id,
        message: "Ledger transaction in the period is absent from the statement",
      });
    }
  }

  const currency = statement.closingBalance.currency;
  const expected = parseCurrencyAmount(statement.openingBalance.amount, currency, "opening balance").plus(activity);
  const reported = parseCurrencyAmount(statement.closingBalance.amount, currency, "closing balance");
  const difference = reported.minus(expected);
  if (!difference.isZero()) {
    issues.push({ code: "BALANCE_MISMATCH", message: "Opening balance plus activity does not equal closing balance" });
  }

  return {
    status: issues.length === 0 ? "reconciled" : "mismatch",
    expectedClosingBalance: canonicalCurrencyAmount(expected, currency, "expected closing balance"),
    reportedClosingBalance: canonicalCurrencyAmount(reported, currency, "reported closing balance"),
    difference: canonicalCurrencyAmount(difference, currency, "reconciliation difference"),
    matchedTransactionCount: matched,
    issues,
  };
}
