import type {
  AmexAccount,
  CoreSnapshot,
  FinancialTransaction,
  FraudAlert,
  Portfolio,
  Statement,
} from "./domain";

export interface TransactionReadFilter {
  readonly accountIds: readonly string[];
  readonly from?: string;
  readonly to?: string;
  /** Exclusive keyset position in the canonical postedAt DESC, id ASC order. */
  readonly after?: TransactionReadPosition;
  /** Omit only for trusted local snapshot-management operations. */
  readonly limit?: number;
}

export interface TransactionReadPosition {
  readonly postedAt: string;
  readonly id: string;
}

export interface FraudAlertReadFilter {
  readonly accountIds: readonly string[];
  readonly status?: FraudAlert["status"];
  /** Omit only for trusted local snapshot-management operations. */
  readonly limit?: number;
}

export const MAX_STORE_READ_PAGE_SIZE = 5_000;

/** Read-only port used by MCP-facing services. It intentionally exposes no mutation methods. */
export interface FinancialReadStore {
  listAccounts(): Promise<readonly AmexAccount[]>;
  getAccount(accountId: string): Promise<AmexAccount | undefined>;
  getPortfolio(portfolioId: string): Promise<Portfolio | undefined>;
  listTransactions(filter: TransactionReadFilter): Promise<readonly FinancialTransaction[]>;
  getStatement(accountId: string, statementId: string): Promise<Statement | undefined>;
  listFraudAlerts(filter: FraudAlertReadFilter): Promise<readonly FraudAlert[]>;
  getFraudAlert(alertId: string): Promise<FraudAlert | undefined>;
}

/**
 * Useful for tests and explicit demo mode. It is not a production persistence fallback.
 */
export class InMemoryFinancialStore implements FinancialReadStore {
  readonly #snapshot: CoreSnapshot;

  public constructor(snapshot: CoreSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  public async listAccounts(): Promise<readonly AmexAccount[]> {
    return structuredClone(this.#snapshot.accounts);
  }

  public async getAccount(accountId: string): Promise<AmexAccount | undefined> {
    const found = this.#snapshot.accounts.find((account) => account.id === accountId);
    return found === undefined ? undefined : structuredClone(found);
  }

  public async getPortfolio(portfolioId: string): Promise<Portfolio | undefined> {
    const found = this.#snapshot.portfolios.find((portfolio) => portfolio.id === portfolioId);
    return found === undefined ? undefined : structuredClone(found);
  }

  public async listTransactions(filter: TransactionReadFilter): Promise<readonly FinancialTransaction[]> {
    validateOptionalReadLimit(filter.limit);
    const accountIds = new Set(filter.accountIds);
    const transactions = this.#snapshot.transactions
      .filter(
        (transaction) =>
          accountIds.has(transaction.source.accountId) &&
          (filter.from === undefined || transaction.postedAt >= filter.from) &&
          (filter.to === undefined || transaction.postedAt <= filter.to) &&
          (filter.after === undefined || transactionIsAfterPosition(transaction, filter.after)),
      )
      .sort(compareTransactions);
    return structuredClone(filter.limit === undefined ? transactions : transactions.slice(0, filter.limit));
  }

  public async getStatement(accountId: string, statementId: string): Promise<Statement | undefined> {
    const found = this.#snapshot.statements.find(
      (statement) => statement.accountId === accountId && statement.id === statementId,
    );
    return found === undefined ? undefined : structuredClone(found);
  }

  public async listFraudAlerts(filter: FraudAlertReadFilter): Promise<readonly FraudAlert[]> {
    validateOptionalReadLimit(filter.limit);
    const accountIds = new Set(filter.accountIds);
    const alerts = this.#snapshot.fraudAlerts
      .filter(
        (alert) => accountIds.has(alert.accountId) && (filter.status === undefined || alert.status === filter.status),
      )
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt) || left.id.localeCompare(right.id));
    return structuredClone(filter.limit === undefined ? alerts : alerts.slice(0, filter.limit));
  }

  public async getFraudAlert(alertId: string): Promise<FraudAlert | undefined> {
    const found = this.#snapshot.fraudAlerts.find((alert) => alert.id === alertId);
    return found === undefined ? undefined : structuredClone(found);
  }
}

function compareTransactions(left: FinancialTransaction, right: FinancialTransaction): number {
  return right.postedAt.localeCompare(left.postedAt) || left.id.localeCompare(right.id);
}

function transactionIsAfterPosition(
  transaction: FinancialTransaction,
  position: TransactionReadPosition,
): boolean {
  return transaction.postedAt < position.postedAt ||
    (transaction.postedAt === position.postedAt && transaction.id > position.id);
}

function validateOptionalReadLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STORE_READ_PAGE_SIZE) {
    throw new RangeError(`Read limit must be an integer from 1 to ${MAX_STORE_READ_PAGE_SIZE}.`);
  }
}
