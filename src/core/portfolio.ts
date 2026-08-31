import Decimal from "decimal.js";

import type {
  AmexAccount,
  CurrencyCode,
  CurrencyTotal,
  FinancialTransaction,
  Portfolio,
  PortfolioReport,
} from "./domain";
import { ValidationError } from "./errors";
import { canonicalCurrencyAmount, parseCurrencyAmount } from "./money";

export function buildPortfolioReport(input: {
  readonly portfolio: Portfolio;
  readonly accounts: readonly AmexAccount[];
  readonly transactions: readonly FinancialTransaction[];
  readonly generatedAt: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
}): PortfolioReport {
  const selected = new Set(input.portfolio.accountIds);
  const known = new Set(input.accounts.map((account) => account.id));
  for (const accountId of selected) {
    if (!known.has(accountId)) {
      throw new ValidationError("Portfolio contains an unknown account", { portfolioId: input.portfolio.id, accountId });
    }
  }

  const accumulators = new Map<CurrencyCode, { inflows: Decimal; outflows: Decimal; net: Decimal; count: number }>();
  for (const transaction of input.transactions) {
    if (!selected.has(transaction.source.accountId)) continue;
    if (input.periodStart !== undefined && transaction.postedAt < input.periodStart) continue;
    if (input.periodEnd !== undefined && transaction.postedAt > input.periodEnd) continue;
    const amount = parseCurrencyAmount(transaction.amount, transaction.currency);
    const current = accumulators.get(transaction.currency) ?? {
      inflows: new Decimal(0),
      outflows: new Decimal(0),
      net: new Decimal(0),
      count: 0,
    };
    current.net = current.net.plus(amount);
    if (amount.isNegative()) current.outflows = current.outflows.plus(amount.abs());
    else current.inflows = current.inflows.plus(amount);
    current.count += 1;
    accumulators.set(transaction.currency, current);
  }

  const totals: CurrencyTotal[] = [...accumulators.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({
      currency,
      inflows: canonicalCurrencyAmount(total.inflows, currency, "portfolio inflows"),
      outflows: canonicalCurrencyAmount(total.outflows, currency, "portfolio outflows"),
      net: canonicalCurrencyAmount(total.net, currency, "portfolio net"),
      transactionCount: total.count,
    }));

  return {
    portfolioId: input.portfolio.id,
    portfolioName: input.portfolio.name,
    accountIds: [...input.portfolio.accountIds],
    ...(input.periodStart === undefined ? {} : { periodStart: input.periodStart }),
    ...(input.periodEnd === undefined ? {} : { periodEnd: input.periodEnd }),
    totals,
    generatedAt: input.generatedAt,
  };
}
