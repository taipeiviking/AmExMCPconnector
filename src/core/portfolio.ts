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
  const builder = new PortfolioReportBuilder(input);
  builder.addTransactions(input.transactions);
  return builder.build();
}

export interface PortfolioReportBuilderInput {
  readonly portfolio: Portfolio;
  readonly accounts: readonly AmexAccount[];
  readonly generatedAt: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

/** Exact, constant-memory portfolio aggregation for bounded store pages. */
export class PortfolioReportBuilder {
  readonly #portfolio: Portfolio;
  readonly #selected: ReadonlySet<string>;
  readonly #generatedAt: string;
  readonly #periodStart?: string;
  readonly #periodEnd?: string;
  readonly #accumulators = new Map<CurrencyCode, {
    inflows: Decimal;
    outflows: Decimal;
    net: Decimal;
    count: number;
  }>();
  #transactionCount = 0;

  public constructor(input: PortfolioReportBuilderInput) {
    this.#portfolio = input.portfolio;
    this.#selected = new Set(input.portfolio.accountIds);
    this.#generatedAt = input.generatedAt;
    this.#periodStart = input.periodStart;
    this.#periodEnd = input.periodEnd;

    const known = new Set(input.accounts.map((account) => account.id));
    for (const accountId of this.#selected) {
      if (!known.has(accountId)) {
        throw new ValidationError("Portfolio contains an unknown account", {
          portfolioId: input.portfolio.id,
          accountId,
        });
      }
    }
  }

  public get transactionCount(): number {
    return this.#transactionCount;
  }

  public addTransactions(transactions: readonly FinancialTransaction[]): void {
    for (const transaction of transactions) {
      if (!this.#selected.has(transaction.source.accountId)) continue;
      if (this.#periodStart !== undefined && transaction.postedAt < this.#periodStart) continue;
      if (this.#periodEnd !== undefined && transaction.postedAt > this.#periodEnd) continue;
      const amount = parseCurrencyAmount(transaction.amount, transaction.currency);
      const current = this.#accumulators.get(transaction.currency) ?? {
        inflows: new Decimal(0),
        outflows: new Decimal(0),
        net: new Decimal(0),
        count: 0,
      };
      current.net = current.net.plus(amount);
      if (amount.isNegative()) current.outflows = current.outflows.plus(amount.abs());
      else current.inflows = current.inflows.plus(amount);
      current.count += 1;
      this.#transactionCount += 1;
      this.#accumulators.set(transaction.currency, current);
    }
  }

  public build(): PortfolioReport {
    const totals: CurrencyTotal[] = [...this.#accumulators.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, total]) => ({
        currency,
        inflows: canonicalCurrencyAmount(total.inflows, currency, "portfolio inflows"),
        outflows: canonicalCurrencyAmount(total.outflows, currency, "portfolio outflows"),
        net: canonicalCurrencyAmount(total.net, currency, "portfolio net"),
        transactionCount: total.count,
      }));

    return {
      portfolioId: this.#portfolio.id,
      portfolioName: this.#portfolio.name,
      accountIds: [...this.#portfolio.accountIds],
      ...(this.#periodStart === undefined ? {} : { periodStart: this.#periodStart }),
      ...(this.#periodEnd === undefined ? {} : { periodEnd: this.#periodEnd }),
      totals,
      generatedAt: this.#generatedAt,
    };
  }
}
