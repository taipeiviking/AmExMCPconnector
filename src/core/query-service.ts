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
import { buildPortfolioReport } from "./portfolio";
import type { FinancialReadStore } from "./repository";

export interface FinanceQueryServiceOptions {
  readonly authorizationChecker?: AuthorizationChecker;
  readonly auditSink?: AuditSink;
  readonly now?: () => Date;
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

  public constructor(store: FinancialReadStore, options: FinanceQueryServiceOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#authorizationChecker = options.authorizationChecker ?? new StoredAuthorizationChecker(this.#now);
    this.#audit = options.auditSink ?? new NullAuditSink();
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
    const offset = input.cursor === undefined ? 0 : decodeCursor(input.cursor, scope);
    const transactions = [...(await this.#store.listTransactions({
      accountIds: accounts.map((account) => account.id),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    }))].sort((left, right) => right.postedAt.localeCompare(left.postedAt) || left.id.localeCompare(right.id));
    const page = transactions.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    await this.#auditSuccess(
      "list_transactions",
      accounts.map((account) => account.id),
      input.target.kind === "portfolio" ? input.target.portfolioId : undefined,
      { returnedCount: page.length },
    );
    return {
      transactions: page,
      nextCursor: nextOffset < transactions.length ? encodeCursor(nextOffset, scope) : null,
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
    const transactions = await this.#store.listTransactions({
      accountIds: accounts.map((account) => account.id),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    const result = buildPortfolioReport({
      portfolio,
      accounts,
      transactions,
      generatedAt: this.#now().toISOString(),
      ...(input.from === undefined ? {} : { periodStart: input.from }),
      ...(input.to === undefined ? {} : { periodEnd: input.to }),
    });
    await this.#auditSuccess("get_portfolio_report", accounts.map((account) => account.id), portfolio.id, {
      transactionCount: transactions.length,
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
    const alerts = await this.#store.listFraudAlerts({
      accountIds: accounts.map((account) => account.id),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    const result = [...alerts]
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt) || left.id.localeCompare(right.id))
      .slice(0, limit);
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

function encodeCursor(offset: number, scope: string): string {
  return Buffer.from(JSON.stringify({ version: 1, offset, scope }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, expectedScope: string): number {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("offset" in parsed) ||
      !Number.isInteger(parsed.offset) ||
      (parsed.offset as number) < 0 ||
      !("scope" in parsed) ||
      parsed.scope !== expectedScope
    ) {
      throw new Error("invalid cursor");
    }
    return parsed.offset as number;
  } catch {
    throw new ValidationError("cursor is invalid or belongs to a different query");
  }
}
