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
}

export interface FraudAlertReadFilter {
  readonly accountIds: readonly string[];
  readonly status?: FraudAlert["status"];
}

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
    const accountIds = new Set(filter.accountIds);
    return structuredClone(
      this.#snapshot.transactions.filter(
        (transaction) =>
          accountIds.has(transaction.source.accountId) &&
          (filter.from === undefined || transaction.postedAt >= filter.from) &&
          (filter.to === undefined || transaction.postedAt <= filter.to),
      ),
    );
  }

  public async getStatement(accountId: string, statementId: string): Promise<Statement | undefined> {
    const found = this.#snapshot.statements.find(
      (statement) => statement.accountId === accountId && statement.id === statementId,
    );
    return found === undefined ? undefined : structuredClone(found);
  }

  public async listFraudAlerts(filter: FraudAlertReadFilter): Promise<readonly FraudAlert[]> {
    const accountIds = new Set(filter.accountIds);
    return structuredClone(
      this.#snapshot.fraudAlerts.filter(
        (alert) => accountIds.has(alert.accountId) && (filter.status === undefined || alert.status === filter.status),
      ),
    );
  }

  public async getFraudAlert(alertId: string): Promise<FraudAlert | undefined> {
    const found = this.#snapshot.fraudAlerts.find((alert) => alert.id === alertId);
    return found === undefined ? undefined : structuredClone(found);
  }
}
