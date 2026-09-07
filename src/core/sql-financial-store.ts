import type { AuditEvent, AuditSink } from "./audit";
import type {
  AmexAccount,
  CoreSnapshot,
  FinancialTransaction,
  FraudAlert,
  Portfolio,
  Statement,
} from "./domain";
import { ValidationError } from "./errors";
import { FinanceQueryService, type FinanceQueryServiceOptions } from "./query-service";
import {
  MAX_STORE_READ_PAGE_SIZE,
  type FinancialReadStore,
  type FraudAlertReadFilter,
  type TransactionReadFilter,
} from "./repository";
import {
  assertSnapshotContainsNoSecrets,
  validateAccount,
  validatePortfolio,
  validateStatement,
  validateTransaction,
} from "./validation";
import {
  EncryptedSqlJsDatabase,
  SqlJsSecretVault,
  isStorageError,
  type CreateEncryptedSqlJsDatabaseOptions,
  type SqlRow,
} from "../storage";

export const FINANCIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  country TEXT NOT NULL,
  account_class TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  posted_at TEXT NOT NULL,
  import_fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transactions_account_date
  ON transactions(account_id, posted_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_transactions_date_id_account
  ON transactions(posted_at DESC, id ASC, account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_account_import_fingerprint
  ON transactions(account_id, import_fingerprint);
CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period_end TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_statements_account_period
  ON statements(account_id, period_end DESC);
CREATE TABLE IF NOT EXISTS fraud_alerts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_account_status_date
  ON fraud_alerts(account_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_date_id_account
  ON fraud_alerts(detected_at DESC, id ASC, account_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status_date_id_account
  ON fraud_alerts(status, detected_at DESC, id ASC, account_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_events_date ON audit_events(occurred_at DESC);
PRAGMA user_version = 2;
`;

const FINANCIAL_SCHEMA_V2_MIGRATION_SQL = `
CREATE INDEX IF NOT EXISTS idx_transactions_date_id_account
  ON transactions(posted_at DESC, id ASC, account_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_date_id_account
  ON fraud_alerts(detected_at DESC, id ASC, account_id);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status_date_id_account
  ON fraud_alerts(status, detected_at DESC, id ASC, account_id);
PRAGMA user_version = 2;
`;

interface JsonRow extends SqlRow {
  payload_json: string;
}

/** Typed repository and durable audit sink over the encrypted sql.js database. */
export class EncryptedSqlFinancialStore implements FinancialReadStore, AuditSink {
  public constructor(public readonly database: EncryptedSqlJsDatabase) {}

  public async initialize(): Promise<void> {
    const row = this.database.query<SqlRow & { user_version: number }>("SELECT user_version FROM pragma_user_version")[0];
    const version = row?.user_version;
    if (version === 2) return;
    if (version === 1) {
      this.database.exec(FINANCIAL_SCHEMA_V2_MIGRATION_SQL);
      await this.database.save();
      return;
    }
    if (version !== 0) {
      throw new ValidationError("Encrypted financial database schema version is unsupported", { version });
    }
    this.database.exec(FINANCIAL_SCHEMA_SQL);
    await this.database.save();
  }

  public async listAccounts(): Promise<readonly AmexAccount[]> {
    return this.#jsonRows<AmexAccount>(
      "SELECT payload_json FROM accounts ORDER BY country, account_class, id",
      "account",
    );
  }

  public async getAccount(accountId: string): Promise<AmexAccount | undefined> {
    return this.#singleJson<AmexAccount>(
      "SELECT payload_json FROM accounts WHERE id = ?",
      [accountId],
      "account",
    );
  }

  public async getPortfolio(portfolioId: string): Promise<Portfolio | undefined> {
    return this.#singleJson<Portfolio>(
      "SELECT payload_json FROM portfolios WHERE id = ?",
      [portfolioId],
      "portfolio",
    );
  }

  public async listTransactions(filter: TransactionReadFilter): Promise<readonly FinancialTransaction[]> {
    validateOptionalReadLimit(filter.limit);
    if (filter.accountIds.length === 0) return [];
    const placeholders = filter.accountIds.map(() => "?").join(",");
    const where = [`account_id IN (${placeholders})`];
    const params: Array<string | number> = [...filter.accountIds];
    if (filter.from !== undefined) {
      where.push("posted_at >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("posted_at <= ?");
      params.push(filter.to);
    }
    if (filter.after !== undefined) {
      where.push("(posted_at < ? OR (posted_at = ? AND id > ?))");
      params.push(filter.after.postedAt, filter.after.postedAt, filter.after.id);
    }
    const limitSql = filter.limit === undefined ? "" : " LIMIT ?";
    if (filter.limit !== undefined) params.push(filter.limit);
    return this.#jsonRows<FinancialTransaction>(
      `SELECT payload_json FROM transactions WHERE ${where.join(" AND ")} ORDER BY posted_at DESC, id ASC${limitSql}`,
      "transaction",
      params,
    );
  }

  public async getStatement(accountId: string, statementId: string): Promise<Statement | undefined> {
    return this.#singleJson<Statement>(
      "SELECT payload_json FROM statements WHERE account_id = ? AND id = ?",
      [accountId, statementId],
      "statement",
    );
  }

  public async listFraudAlerts(filter: FraudAlertReadFilter): Promise<readonly FraudAlert[]> {
    validateOptionalReadLimit(filter.limit);
    if (filter.accountIds.length === 0) return [];
    const placeholders = filter.accountIds.map(() => "?").join(",");
    const where = [`account_id IN (${placeholders})`];
    const params: Array<string | number> = [...filter.accountIds];
    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const limitSql = filter.limit === undefined ? "" : " LIMIT ?";
    if (filter.limit !== undefined) params.push(filter.limit);
    return this.#jsonRows<FraudAlert>(
      `SELECT payload_json FROM fraud_alerts WHERE ${where.join(" AND ")} ORDER BY detected_at DESC, id ASC${limitSql}`,
      "fraud alert",
      params,
    );
  }

  public async getFraudAlert(alertId: string): Promise<FraudAlert | undefined> {
    return this.#singleJson<FraudAlert>(
      "SELECT payload_json FROM fraud_alerts WHERE id = ?",
      [alertId],
      "fraud alert",
    );
  }

  /** Replaces domain records in one SQLite transaction, then publishes one encrypted snapshot. */
  public async replaceSnapshot(snapshot: CoreSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await this.#commitAndSave(() => this.#replaceSnapshotRows(snapshot));
  }

  /**
   * Replaces all domain records and appends the describing audit event in the
   * same SQLite transaction, then publishes exactly one encrypted snapshot.
   */
  public async replaceSnapshotWithAudit(snapshot: CoreSnapshot, event: AuditEvent): Promise<void> {
    validateSnapshot(snapshot);
    assertSnapshotContainsNoSecrets(event);
    await this.#commitAndSave(() => {
      this.#replaceSnapshotRows(snapshot);
      this.#putAuditEvent(event);
    });
  }

  #replaceSnapshotRows(snapshot: CoreSnapshot): void {
    this.database.exec("DELETE FROM fraud_alerts; DELETE FROM statements; DELETE FROM transactions; DELETE FROM portfolios; DELETE FROM accounts;");
    for (const account of snapshot.accounts) this.#putAccount(account);
    for (const portfolio of snapshot.portfolios) this.#putPortfolio(portfolio);
    for (const transaction of snapshot.transactions) this.#putTransaction(transaction);
    for (const statement of snapshot.statements) this.#putStatement(statement);
    for (const alert of snapshot.fraudAlerts) this.#putFraudAlert(alert);
  }

  async #commitAndSave(mutation: () => void): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      mutation();
      this.database.exec("COMMIT");
    } catch (caught) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original error. The caller must discard this in-memory instance if rollback itself fails.
      }
      throw caught;
    }
    await this.database.save();
  }

  public async loadSnapshot(): Promise<CoreSnapshot> {
    const accounts = await this.listAccounts();
    const accountIds = accounts.map((account) => account.id);
    return {
      accounts,
      portfolios: this.#jsonRows<Portfolio>("SELECT payload_json FROM portfolios ORDER BY id", "portfolio"),
      transactions: await this.listTransactions({ accountIds }),
      statements: this.#jsonRows<Statement>("SELECT payload_json FROM statements ORDER BY period_end DESC, id", "statement"),
      fraudAlerts: await this.listFraudAlerts({ accountIds }),
    };
  }

  public async append(event: AuditEvent): Promise<void> {
    assertSnapshotContainsNoSecrets(event);
    await this.#commitAndSave(() => this.#putAuditEvent(event));
  }

  #putAuditEvent(event: AuditEvent): void {
    this.database.run(
      `INSERT INTO audit_events(id, occurred_at, action, outcome, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      [event.id, event.occurredAt, event.action, event.outcome, JSON.stringify(event)],
    );
  }

  public async listAuditEvents(limit = 200): Promise<readonly AuditEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new ValidationError("Audit event limit must be an integer from 1 to 5000", { limit });
    }
    return this.#jsonRows<AuditEvent>(
      "SELECT payload_json FROM audit_events ORDER BY occurred_at DESC, id LIMIT ?",
      "audit event",
      [limit],
    );
  }

  public async close(options: { readonly save?: boolean } = {}): Promise<void> {
    await this.database.close(options);
  }

  #putAccount(account: AmexAccount): void {
    this.database.run(
      "INSERT INTO accounts(id, country, account_class, payload_json) VALUES (?, ?, ?, ?)",
      [account.id, account.country, account.accountClass, JSON.stringify(account)],
    );
  }

  #putPortfolio(portfolio: Portfolio): void {
    this.database.run("INSERT INTO portfolios(id, payload_json) VALUES (?, ?)", [portfolio.id, JSON.stringify(portfolio)]);
  }

  #putTransaction(transaction: FinancialTransaction): void {
    this.database.run(
      `INSERT INTO transactions(id, account_id, posted_at, import_fingerprint, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        transaction.id,
        transaction.source.accountId,
        transaction.postedAt,
        transaction.importFingerprint,
        JSON.stringify(transaction),
      ],
    );
  }

  #putStatement(statement: Statement): void {
    this.database.run(
      "INSERT INTO statements(id, account_id, period_end, payload_json) VALUES (?, ?, ?, ?)",
      [statement.id, statement.accountId, statement.periodEnd, JSON.stringify(statement)],
    );
  }

  #putFraudAlert(alert: FraudAlert): void {
    this.database.run(
      "INSERT INTO fraud_alerts(id, account_id, status, detected_at, payload_json) VALUES (?, ?, ?, ?, ?)",
      [alert.id, alert.accountId, alert.status, alert.detectedAt, JSON.stringify(alert)],
    );
  }

  #singleJson<T>(sql: string, params: readonly (string | number)[], label: string): T | undefined {
    const rows = this.#jsonRows<T>(sql, label, [...params]);
    return rows[0];
  }

  #jsonRows<T>(sql: string, label: string, params?: readonly (string | number)[]): T[] {
    const rows = this.database.query<JsonRow>(sql, params === undefined ? undefined : [...params]);
    return rows.map((row) => parseJsonRecord<T>(row.payload_json, label));
  }
}

export interface EncryptedCoreRuntime {
  readonly database: EncryptedSqlJsDatabase;
  readonly store: EncryptedSqlFinancialStore;
  readonly service: FinanceQueryService;
  readonly audit: EncryptedSqlFinancialStore;
  readonly secrets: SqlJsSecretVault;
}

/** Opens or explicitly first-run creates an empty encrypted production repository. No demo seed is inserted. */
export async function openEncryptedCore(
  storageOptions: CreateEncryptedSqlJsDatabaseOptions,
  serviceOptions: Omit<FinanceQueryServiceOptions, "auditSink"> = {},
): Promise<EncryptedCoreRuntime> {
  const database = await EncryptedSqlJsDatabase.openOrCreate({
    ...storageOptions,
    initialSql: storageOptions.initialSql === undefined
      ? FINANCIAL_SCHEMA_SQL
      : [FINANCIAL_SCHEMA_SQL, ...(typeof storageOptions.initialSql === "string" ? [storageOptions.initialSql] : storageOptions.initialSql)],
  });
  try {
    const store = new EncryptedSqlFinancialStore(database);
    await store.initialize();
    let secrets: SqlJsSecretVault;
    try {
      secrets = SqlJsSecretVault.open(database);
    } catch (caught) {
      if (!isStorageError(caught) || caught.code !== "INVALID_CONFIGURATION") throw caught;
      secrets = SqlJsSecretVault.initialize(database);
      await database.save();
    }
    const service = new FinanceQueryService(store, { ...serviceOptions, auditSink: store });
    return { database, store, service, audit: store, secrets };
  } catch (caught) {
    try {
      await database.close({ save: false });
    } catch (cleanupError) {
      throw new AggregateError(
        [caught, cleanupError],
        "Encrypted core initialization failed and its decrypted database could not be closed cleanly",
      );
    }
    throw caught;
  }
}

function validateSnapshot(snapshot: CoreSnapshot): void {
  assertSnapshotContainsNoSecrets(snapshot);
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
  const transactions = new Map<string, FinancialTransaction>();
  for (const transaction of snapshot.transactions) {
    if (transactions.has(transaction.id)) {
      throw new ValidationError("Financial snapshot contains a duplicate transaction id", {
        transactionId: transaction.id,
      });
    }
    transactions.set(transaction.id, transaction);
  }
  const statements = new Map<string, Statement>();
  for (const statement of snapshot.statements) {
    if (statements.has(statement.id)) {
      throw new ValidationError("Financial snapshot contains a duplicate statement id", {
        statementId: statement.id,
      });
    }
    statements.set(statement.id, statement);
  }
  const issues = [
    ...snapshot.accounts.flatMap(validateAccount),
    ...snapshot.portfolios.flatMap((portfolio) => validatePortfolio(portfolio, new Set(accounts.keys()))),
    ...snapshot.transactions.flatMap((transaction) => validateTransaction(transaction, accounts.get(transaction.source.accountId))),
    ...snapshot.statements.flatMap(validateStatement),
  ];
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) throw new ValidationError("Financial snapshot failed validation", { errors });
  for (const transaction of snapshot.transactions) {
    if (!accounts.has(transaction.source.accountId)) {
      throw new ValidationError("Transaction references an unknown source account", { transactionId: transaction.id });
    }
    if (transaction.statementId !== undefined) {
      const statement = statements.get(transaction.statementId);
      if (statement === undefined) {
        throw new ValidationError("Transaction references an unknown statement", {
          transactionId: transaction.id,
          statementId: transaction.statementId,
        });
      }
      if (statement.accountId !== transaction.source.accountId) {
        throw new ValidationError("Transaction cannot reference a statement owned by another account", {
          transactionId: transaction.id,
          transactionAccountId: transaction.source.accountId,
          statementId: statement.id,
          statementAccountId: statement.accountId,
        });
      }
      if (!statement.transactionIds.includes(transaction.id)) {
        throw new ValidationError("Transaction statementId is not reciprocated by the statement transaction list", {
          transactionId: transaction.id,
          statementId: statement.id,
        });
      }
    }
  }
  for (const statement of snapshot.statements) {
    const statementAccount = accounts.get(statement.accountId);
    if (statementAccount === undefined) {
      throw new ValidationError("Statement references an unknown account", { statementId: statement.id });
    }
    if (
      statement.openingBalance.currency !== statementAccount.currency ||
      statement.closingBalance.currency !== statementAccount.currency
    ) {
      throw new ValidationError("Statement balances must use the owning account currency", {
        statementId: statement.id,
        accountId: statement.accountId,
        accountCurrency: statementAccount.currency,
      });
    }
    for (const transactionId of statement.transactionIds) {
      const transaction = transactions.get(transactionId);
      if (transaction === undefined) {
        throw new ValidationError("Statement references an unknown transaction", {
          statementId: statement.id,
          transactionId,
        });
      }
      if (transaction.source.accountId !== statement.accountId) {
        throw new ValidationError("Statement cannot reference a transaction owned by another account", {
          statementId: statement.id,
          statementAccountId: statement.accountId,
          transactionId,
          transactionAccountId: transaction.source.accountId,
        });
      }
    }
  }
  for (const alert of snapshot.fraudAlerts) {
    if (!accounts.has(alert.accountId) || alert.reviewOnly !== true) {
      throw new ValidationError("Fraud alert is not a valid review-only account alert", { alertId: alert.id });
    }
    const declaredTransactionIds = new Set(alert.transactionIds);
    for (const transactionId of alert.transactionIds) {
      assertAlertTransactionBelongsToAccount(alert, transactionId, transactions, "transactionIds");
    }
    for (const evidence of alert.evidence) {
      if (!evidence.startsWith("transaction:")) continue;
      const transactionId = evidence.slice("transaction:".length);
      if (transactionId.length === 0) {
        throw new ValidationError("Fraud alert has an empty transaction evidence reference", { alertId: alert.id });
      }
      assertAlertTransactionBelongsToAccount(alert, transactionId, transactions, "evidence");
      if (!declaredTransactionIds.has(transactionId)) {
        throw new ValidationError("Fraud alert evidence references a transaction absent from transactionIds", {
          alertId: alert.id,
          transactionId,
        });
      }
    }
  }
}

function assertAlertTransactionBelongsToAccount(
  alert: FraudAlert,
  transactionId: string,
  transactions: ReadonlyMap<string, FinancialTransaction>,
  referenceField: "transactionIds" | "evidence",
): void {
  const transaction = transactions.get(transactionId);
  if (transaction === undefined) {
    throw new ValidationError("Fraud alert references an unknown transaction", {
      alertId: alert.id,
      transactionId,
      referenceField,
    });
  }
  if (transaction.source.accountId !== alert.accountId) {
    throw new ValidationError("Fraud alert cannot reference a transaction owned by another account", {
      alertId: alert.id,
      alertAccountId: alert.accountId,
      transactionId,
      transactionAccountId: transaction.source.accountId,
      referenceField,
    });
  }
}

function parseJsonRecord<T>(json: string, label: string): T {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return value as T;
  } catch (caught) {
    throw new ValidationError(`Stored ${label} record is invalid`, {
      cause: caught instanceof Error ? caught.message : "invalid JSON",
    });
  }
}

function validateOptionalReadLimit(limit: number | undefined): void {
  if (limit === undefined) return;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STORE_READ_PAGE_SIZE) {
    throw new ValidationError(`Read limit must be an integer from 1 to ${MAX_STORE_READ_PAGE_SIZE}`, { limit });
  }
}
