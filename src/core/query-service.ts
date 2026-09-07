import { createHash, randomUUID } from "node:crypto";

import type { AuditSink } from "./audit";
import { NullAuditSink } from "./audit";
import {
  assertAccountReadable,
  authorizationAction,
  type AuthorizationChecker,
  StoredAuthorizationChecker,
} from "./authorization";
import type {
  AccountClass,
  AccountStatusResult,
  AlertExplanation,
  AmexAccount,
  CountryCode,
  DataTarget,
  FinancialTransaction,
  FraudAlert,
  PortfolioReport,
  Statement,
  TransactionPage,
} from "./domain";
import { NotFoundError, ValidationError } from "./errors";
import { PortfolioReportBuilder } from "./portfolio";
import {
  MAX_STORE_READ_PAGE_SIZE,
  type FinancialReadStore,
  type TransactionReadPosition,
} from "./repository";

const DEFAULT_PORTFOLIO_REPORT_PAGE_SIZE = 1_000;
const DEFAULT_MAXIMUM_PORTFOLIO_REPORT_TRANSACTIONS = 250_000;

export interface FinanceQueryServiceOptions {
  readonly authorizationChecker?: AuthorizationChecker;
  readonly auditSink?: AuditSink;
  readonly now?: () => Date;
  /** Internal read batch size; it does not change the report result. */
  readonly portfolioReportPageSize?: number;
  /** Explicit work ceiling. Reports above it fail rather than returning partial totals. */
  readonly maximumPortfolioReportTransactions?: number;
}

export interface ListAccountsInput {
  /** Global account enumeration is intentionally unavailable to MCP callers. */
  readonly portfolioId: string;
  readonly country?: CountryCode;
  readonly accountClass?: AccountClass;
}

export interface ListTransactionsInput {
  readonly target: DataTarget;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export class FinanceQueryService {
  readonly #store: FinancialReadStore;
  readonly #authorizationChecker: AuthorizationChecker;
  readonly #audit: AuditSink;
  readonly #now: () => Date;
  readonly #portfolioReportPageSize: number;
  readonly #maximumPortfolioReportTransactions: number;

  public constructor(store: FinancialReadStore, options: FinanceQueryServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#authorizationChecker = options.authorizationChecker ?? new StoredAuthorizationChecker(this.#now);
    this.#audit = options.auditSink ?? new NullAuditSink();
    this.#portfolioReportPageSize = options.portfolioReportPageSize ?? DEFAULT_PORTFOLIO_REPORT_PAGE_SIZE;
    this.#maximumPortfolioReportTransactions =
      options.maximumPortfolioReportTransactions ?? DEFAULT_MAXIMUM_PORTFOLIO_REPORT_TRANSACTIONS;
    if (
      !Number.isSafeInteger(this.#portfolioReportPageSize) ||
      this.#portfolioReportPageSize < 1 ||
      this.#portfolioReportPageSize > MAX_STORE_READ_PAGE_SIZE
    ) {
      throw new RangeError(`portfolioReportPageSize must be an integer from 1 to ${MAX_STORE_READ_PAGE_SIZE}`);
    }
    if (
      !Number.isSafeInteger(this.#maximumPortfolioReportTransactions) ||
      this.#maximumPortfolioReportTransactions < 1
    ) {
      throw new RangeError("maximumPortfolioReportTransactions must be a positive integer");
    }
  }

  public async listAccounts(input: ListAccountsInput): Promise<readonly AmexAccount[]> {
    const portfolio = await this.#getPortfolio(input.portfolioId);
    const accounts = await this.#accountsForPortfolio(portfolio.accountIds);
    const checked = await Promise.all(
      accounts.map(async (account) => ({ ...account, authorization: await this.#authorizationChecker.check(account) })),
    );
    const result = checked.filter(
      (account) =>
        (input.country === undefined || account.country === input.country) &&
        (input.accountClass === undefined || account.accountClass === input.accountClass),
    );
    await this.#auditSuccess("list_accounts", accounts.map((account) => account.id), input.portfolioId, {
      returnedCount: result.length,
    });
    return result;
  }

  public async getAccountStatus(input: { readonly accountId: string }): Promise<AccountStatusResult> {
    const account = await this.#getAccount(input.accountId);
    const authorization = await this.#authorizationChecker.check(account);
    const recommendedAction = authorizationAction(authorization);
    await this.#auditSuccess("get_account_status", [account.id], undefined, {
      authorizationState: authorization.state,
    });
    return {
      accountId: account.id,
      authorization,
      availableForQueries: account.active && recommendedAction === "none",
      recommendedAction,
    };
  }

  public async listTransactions(input: ListTransactionsInput): Promise<TransactionPage> {
    validatePeriod(input.from, input.to);
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ValidationError("limit must be an integer from 1 to 500", { limit });
    }
    const accounts = await this.#resolveReadableTarget(input.target);
    const scope = cursorScope(input.target, input.from, input.to);
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor, scope);
    const accountIds = accounts.map((account) => account.id);
    const transactions = await this.#store.listTransactions({
      accountIds,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(after === undefined ? {} : { after }),
      limit: limit + 1,
    });
    assertBoundedOrderedTransactionPage(transactions, {
      accountIds,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(after === undefined ? {} : { after }),
      maximumRows: limit + 1,
    });
    const page = transactions.slice(0, limit);
    const nextCursor = transactions.length > limit
      ? encodeCursor(transactionPosition(page[page.length - 1]!), scope)
      : null;
    await this.#auditSuccess(
      "list_transactions",
      accounts.map((account) => account.id),
      input.target.kind === "portfolio" ? input.target.portfolioId : undefined,
      { returnedCount: page.length },
    );
    return {
      transactions: page,
      nextCursor,
    };
  }

  public async getStatement(input: { readonly accountId: string; readonly statementId: string }): Promise<Statement> {
    const account = await this.#getReadableAccount(input.accountId);
    const statement = await this.#store.getStatement(account.id, input.statementId);
    if (statement === undefined) throw new NotFoundError("statement", input.statementId);
    await this.#auditSuccess("get_statement", [account.id], undefined, { statementId: statement.id });
    return statement;
  }

  public async getPortfolioReport(input: {
    readonly portfolioId: string;
    readonly from?: string;
    readonly to?: string;
  }): Promise<PortfolioReport> {
    validatePeriod(input.from, input.to);
    const portfolio = await this.#getPortfolio(input.portfolioId);
    const accounts = await this.#accountsForPortfolio(portfolio.accountIds);
    await Promise.all(accounts.map((account) => this.#assertReadable(account)));
    const accountIds = accounts.map((account) => account.id);
    const builder = new PortfolioReportBuilder({
      portfolio,
      accounts,
      generatedAt: this.#now().toISOString(),
      ...(input.from === undefined ? {} : { periodStart: input.from }),
      ...(input.to === undefined ? {} : { periodEnd: input.to }),
    });
    let after: TransactionReadPosition | undefined;
    while (true) {
      const remaining = this.#maximumPortfolioReportTransactions - builder.transactionCount;
      const pageLimit = Math.min(this.#portfolioReportPageSize, remaining + 1);
      const transactions = await this.#store.listTransactions({
        accountIds,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(after === undefined ? {} : { after }),
        limit: pageLimit,
      });
      assertBoundedOrderedTransactionPage(transactions, {
        accountIds,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(after === undefined ? {} : { after }),
        maximumRows: pageLimit,
      });
      if (transactions.length > remaining) {
        throw new ValidationError(
          "Portfolio report exceeds the local processing limit; narrow the from/to date range",
          { maximumTransactions: this.#maximumPortfolioReportTransactions },
        );
      }
      builder.addTransactions(transactions);
      if (transactions.length < pageLimit) break;
      after = transactionPosition(transactions[transactions.length - 1]!);
    }
    const result = builder.build();
    await this.#auditSuccess("get_portfolio_report", accounts.map((account) => account.id), portfolio.id, {
      transactionCount: builder.transactionCount,
    });
    return result;
  }

  public async listFraudAlerts(input: {
    readonly target: DataTarget;
    readonly status?: FraudAlert["status"];
    readonly limit?: number;
  }): Promise<readonly FraudAlert[]> {
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ValidationError("limit must be an integer from 1 to 500", { limit });
    }
    const accounts = await this.#resolveReadableTarget(input.target);
    const accountIds = accounts.map((account) => account.id);
    const alerts = await this.#store.listFraudAlerts({
      accountIds,
      ...(input.status === undefined ? {} : { status: input.status }),
      limit,
    });
    assertBoundedOrderedFraudAlertPage(alerts, accountIds, input.status, limit);
    const result = [...alerts];
    await this.#auditSuccess(
      "list_fraud_alerts",
      accounts.map((account) => account.id),
      input.target.kind === "portfolio" ? input.target.portfolioId : undefined,
      { returnedCount: result.length },
    );
    return result;
  }

  public async explainAlert(input: { readonly target: DataTarget; readonly alertId: string }): Promise<AlertExplanation> {
    const accounts = await this.#resolveReadableTarget(input.target);
    const allowedAccountIds = new Set(accounts.map((account) => account.id));
    const alert = await this.#store.getFraudAlert(input.alertId);
    if (alert === undefined || !allowedAccountIds.has(alert.accountId)) {
      throw new NotFoundError("fraud alert", input.alertId);
    }
    await this.#auditSuccess(
      "explain_alert",
      [alert.accountId],
      input.target.kind === "portfolio" ? input.target.portfolioId : undefined,
      { alertId: alert.id },
    );
    return {
      alertId: alert.id,
      title: alert.title,
      summary: alert.explanation,
      evidence: [...alert.evidence],
      limitations: [
        "This is a deterministic review aid, not a finding that fraud occurred.",
        "The connector cannot block a card, submit a dispute, or change the account.",
      ],
      nextStep: "review_transaction",
    };
  }

  async #resolveReadableTarget(target: DataTarget): Promise<readonly AmexAccount[]> {
    if (target.kind === "account") return [await this.#getReadableAccount(target.accountId)];
    const portfolio = await this.#getPortfolio(target.portfolioId);
    const accounts = await this.#accountsForPortfolio(portfolio.accountIds);
    await Promise.all(accounts.map((account) => this.#assertReadable(account)));
    return accounts;
  }

  async #getReadableAccount(accountId: string): Promise<AmexAccount> {
    const account = await this.#getAccount(accountId);
    await this.#assertReadable(account);
    return account;
  }

  async #assertReadable(account: AmexAccount): Promise<void> {
    const snapshot = await this.#authorizationChecker.check(account);
    try {
      assertAccountReadable(account, snapshot);
    } catch (caught) {
      await this.#audit.append({
        id: randomUUID(),
        occurredAt: this.#now().toISOString(),
        action: "authorization_check",
        outcome: "denied",
        accountIds: [account.id],
        metadata: { authorizationState: snapshot.state },
      });
      throw caught;
    }
  }

  async #getAccount(accountId: string): Promise<AmexAccount> {
    const account = await this.#store.getAccount(accountId);
    if (account === undefined) throw new NotFoundError("account", accountId);
    return account;
  }

  async #getPortfolio(portfolioId: string) {
    const portfolio = await this.#store.getPortfolio(portfolioId);
    if (portfolio === undefined) throw new NotFoundError("portfolio", portfolioId);
    return portfolio;
  }

  async #accountsForPortfolio(accountIds: readonly string[]): Promise<readonly AmexAccount[]> {
    return Promise.all(accountIds.map((accountId) => this.#getAccount(accountId)));
  }

  async #auditSuccess(
    action: string,
    accountIds: readonly string[],
    portfolioId: string | undefined,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
  ): Promise<void> {
    await this.#audit.append({
      id: randomUUID(),
      occurredAt: this.#now().toISOString(),
      action,
      outcome: "success",
      accountIds: [...accountIds],
      ...(portfolioId === undefined ? {} : { portfolioId }),
      metadata,
    });
  }
}

function validatePeriod(from: string | undefined, to: string | undefined): void {
  if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(from)) {
    throw new ValidationError("from must be an ISO date", { from });
  }
  if (to !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(to)) {
    throw new ValidationError("to must be an ISO date", { to });
  }
  if (from !== undefined && to !== undefined && from > to) {
    throw new ValidationError("from must not be after to", { from, to });
  }
}

function cursorScope(target: DataTarget, from: string | undefined, to: string | undefined): string {
  return createHash("sha256").update(JSON.stringify({ target, from: from ?? null, to: to ?? null })).digest("hex");
}

function encodeCursor(after: TransactionReadPosition, scope: string): string {
  return Buffer.from(JSON.stringify({ version: 2, after, scope }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedScope: string): TransactionReadPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 2 ||
      !("after" in parsed) ||
      typeof parsed.after !== "object" ||
      parsed.after === null ||
      !("postedAt" in parsed.after) ||
      typeof parsed.after.postedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.after.postedAt) ||
      !("id" in parsed.after) ||
      typeof parsed.after.id !== "string" ||
      parsed.after.id.length < 1 ||
      parsed.after.id.length > 256 ||
      !("scope" in parsed) ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return { postedAt: parsed.after.postedAt, id: parsed.after.id };
  } catch {
    throw new ValidationError("cursor is invalid or belongs to a different query");
  }
}

function transactionPosition(transaction: FinancialTransaction): TransactionReadPosition {
  return { postedAt: transaction.postedAt, id: transaction.id };
}

function transactionIsAfterPosition(
  transaction: FinancialTransaction,
  position: TransactionReadPosition,
): boolean {
  return transaction.postedAt < position.postedAt ||
    (transaction.postedAt === position.postedAt && transaction.id > position.id);
}

function assertBoundedOrderedTransactionPage(
  transactions: readonly FinancialTransaction[],
  expected: {
    readonly accountIds: readonly string[];
    readonly from?: string;
    readonly to?: string;
    readonly after?: TransactionReadPosition;
    readonly maximumRows: number;
  },
): void {
  if (transactions.length > expected.maximumRows) {
    throw new ValidationError("Financial store returned more rows than the requested read limit");
  }
  const allowedAccountIds = new Set(expected.accountIds);
  let previous = expected.after;
  for (const transaction of transactions) {
    if (
      !allowedAccountIds.has(transaction.source.accountId) ||
      (expected.from !== undefined && transaction.postedAt < expected.from) ||
      (expected.to !== undefined && transaction.postedAt > expected.to)
    ) {
      throw new ValidationError("Financial store returned a transaction outside the requested scope");
    }
    if (previous !== undefined && !transactionIsAfterPosition(transaction, previous)) {
      throw new ValidationError("Financial store returned transactions outside canonical keyset order");
    }
    previous = transactionPosition(transaction);
  }
}

function assertBoundedOrderedFraudAlertPage(
  alerts: readonly FraudAlert[],
  accountIds: readonly string[],
  status: FraudAlert["status"] | undefined,
  maximumRows: number,
): void {
  if (alerts.length > maximumRows) {
    throw new ValidationError("Financial store returned more alerts than the requested read limit");
  }
  const allowedAccountIds = new Set(accountIds);
  let previous: FraudAlert | undefined;
  for (const alert of alerts) {
    if (!allowedAccountIds.has(alert.accountId) || (status !== undefined && alert.status !== status)) {
      throw new ValidationError("Financial store returned a fraud alert outside the requested scope");
    }
    if (
      previous !== undefined &&
      !(alert.detectedAt < previous.detectedAt || (alert.detectedAt === previous.detectedAt && alert.id > previous.id))
    ) {
      throw new ValidationError("Financial store returned fraud alerts outside canonical order");
    }
    previous = alert;
  }
}
