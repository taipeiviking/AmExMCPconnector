import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../core/audit";
import type { AmexAccount, CoreSnapshot, FinancialTransaction, Statement } from "../core/domain";
import { detectReviewOnlyAlerts } from "../core/fraud";
import { reconcileStatement } from "../core/reconciliation";
import type { ReadOnlyFinancialProvider } from "./provider-types";
import { ProviderIntegrationError } from "./provider-types";
import type { EncryptedProviderBinding } from "./encrypted-provider-binding-store";
import {
  parseNormalizedV1AccountStatus,
  parseNormalizedV1Statements,
  parseNormalizedV1TransactionPage,
  localProviderStatementId,
  localProviderTransactionId,
  toLocalProviderStatement,
  toLocalProviderTransaction,
  type NormalizedV1ProviderStatement,
  type NormalizedV1ProviderTransaction,
} from "./normalized-v1-provider-response";

const MAX_TRANSACTION_PAGES = 100;
const MAX_AGGREGATE_TRANSACTIONS = 10_000;
const MAX_AGGREGATE_STATEMENT_LINKS = 50_000;

export interface AtomicFinancialSyncStore {
  loadSnapshot(): Promise<CoreSnapshot>;
  replaceSnapshotWithAudit(snapshot: CoreSnapshot, event: AuditEvent): Promise<void>;
}

export interface ProviderAccountBindingLookup {
  get(providerId: string, localAccountId: string): Promise<EncryptedProviderBinding | undefined>;
}

export interface UsProviderSyncOptions {
  readonly providerId: string;
  readonly portfolioId: string;
  readonly lookbackDays: number;
  readonly pageSize: number;
  readonly alertsEnabled: boolean;
  readonly highValueUsd: string;
  readonly now?: () => Date;
}

export interface UsProviderSyncResult {
  readonly importedTransactions: number;
  readonly importedStatements: number;
  readonly duplicatesSkipped: number;
}

/** Fetches one explicitly bound account and publishes data plus audit in one local transaction. */
export class UsProviderSyncService {
  private readonly now: () => Date;

  public constructor(
    private readonly store: AtomicFinancialSyncStore,
    private readonly financial: ReadOnlyFinancialProvider,
    private readonly bindings: ProviderAccountBindingLookup,
    private readonly options: UsProviderSyncOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(options.lookbackDays) || options.lookbackDays < 1 || options.lookbackDays > 3650) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider sync lookback is invalid.");
    }
    if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 1000) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider sync page size is invalid.");
    }
  }

  public async sync(localAccountId: string): Promise<UsProviderSyncResult> {
    const baseline = await this.store.loadSnapshot();
    const account = selectedUsAccount(baseline, this.options.portfolioId, localAccountId);
    const binding = await this.bindings.get(this.options.providerId, localAccountId);
    if (!binding) {
      throw new ProviderIntegrationError(
        "AUTHORIZATION_REQUIRED",
        "This local account is not bound to an authorized provider account.",
      );
    }
    const selection = { localAccountId, providerAccountId: binding.providerAccountId };
    const statusResult = await this.financial.getAccountStatus(selection);
    const providerStatus = parseNormalizedV1AccountStatus(statusResult.data, binding.providerAccountId);
    assertCompatibleProviderAccount(account, providerStatus);
    if (providerStatus.status === "reauthorization_required") {
      throw new ProviderIntegrationError(
        "AUTHORIZATION_REQUIRED",
        "The provider requires this account to be authorized again.",
      );
    }
    if (providerStatus.status === "unavailable") {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The approved data provider is temporarily unavailable.",
      );
    }

    const configuredFrom = isoDateDaysAgo(this.now(), this.options.lookbackDays);
    const statementResult = await this.financial.listStatements(selection);
    const allRawStatements = parseNormalizedV1Statements(statementResult.data, binding.providerAccountId);
    if (
      allRawStatements.reduce((total, statement) => total + statement.transaction_ids.length, 0) >
      MAX_AGGREGATE_STATEMENT_LINKS
    ) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider statement result exceeded the aggregate link safety limit.",
      );
    }
    const rawStatements = selectStatementsForSync(allRawStatements, baseline, account, configuredFrom);
    const from = rawStatements.reduce(
      (earliest, statement) => statement.period_start < earliest ? statement.period_start : earliest,
      configuredFrom,
    );
    const rawTransactions: NormalizedV1ProviderTransaction[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > MAX_TRANSACTION_PAGES) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The provider transaction result exceeded the page safety limit.",
        );
      }
      const result = await this.financial.listTransactions(selection, {
        from,
        pageSize: this.options.pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = parseNormalizedV1TransactionPage(result.data, binding.providerAccountId);
      if (page.transactions.length > this.options.pageSize) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The provider returned more transactions than the requested page size.",
        );
      }
      if (rawTransactions.length + page.transactions.length > MAX_AGGREGATE_TRANSACTIONS) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The provider transaction result exceeded the aggregate record safety limit.",
        );
      }
      rawTransactions.push(...page.transactions);
      if (page.nextCursor === null) {
        cursor = undefined;
      } else {
        if (cursors.has(page.nextCursor)) {
          throw new ProviderIntegrationError(
            "INVALID_PROVIDER_RESPONSE",
            "The provider repeated a transaction cursor.",
          );
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } while (cursor !== undefined);
    assertUniqueProviderIds(rawTransactions, "transactions");

    validateStatementTransactionLinks(rawTransactions, rawStatements, baseline, account);

    const syncedAt = this.now().toISOString();
    const fetchedTransactions = rawTransactions.map((transaction) =>
      toLocalProviderTransaction(account, transaction, syncedAt)
    );
    const fetchedStatements = rawStatements.map((statement) =>
      toLocalProviderStatement(account, statement, syncedAt)
    );
    const merge = mergeProviderRecords(baseline, account, fetchedTransactions, fetchedStatements);
    for (const statement of fetchedStatements) {
      if (reconcileStatement(statement, merge.transactions).status !== "reconciled") {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider statement did not reconcile to its signed balances and transactions.",
        );
      }
    }
    const newAlerts = this.options.alertsEnabled
      ? detectReviewOnlyAlerts(merge.newTransactions, {
          detectedAt: syncedAt,
          largeAmountThresholds: { USD: this.options.highValueUsd, JPY: "150000" },
        })
      : [];
    const existingAlertIds = new Set(baseline.fraudAlerts.map((alert) => alert.id));
    const nextSnapshot: CoreSnapshot = {
      ...baseline,
      accounts: baseline.accounts.map((candidate) =>
        candidate.id === account.id
          ? {
              ...candidate,
              authorization: {
                state: "authorized" as const,
                checkedAt: syncedAt,
                ...(providerStatus.authorization_expires_at === undefined
                  ? {}
                  : { expiresAt: providerStatus.authorization_expires_at }),
              },
              updatedAt: syncedAt,
            }
          : candidate
      ),
      transactions: merge.transactions,
      statements: merge.statements,
      fraudAlerts: [
        ...baseline.fraudAlerts,
        ...newAlerts.filter((alert) => !existingAlertIds.has(alert.id)),
      ],
    };
    await this.store.replaceSnapshotWithAudit(nextSnapshot, {
      id: randomUUID(),
      occurredAt: syncedAt,
      action: "provider_account_synced",
      outcome: "success",
      accountIds: [account.id],
      portfolioId: this.options.portfolioId,
      metadata: {
        provider: this.options.providerId,
        responseProfile: "normalized_v1",
        transactionPages: pageCount,
        ignoredHistoricalStatements: allRawStatements.length - rawStatements.length,
        importedTransactions: merge.newTransactions.length,
        importedStatements: merge.newStatementCount,
        duplicatesSkipped: merge.duplicatesSkipped,
      },
    });
    return {
      importedTransactions: merge.newTransactions.length,
      importedStatements: merge.newStatementCount,
      duplicatesSkipped: merge.duplicatesSkipped,
    };
  }
}

function selectedUsAccount(snapshot: CoreSnapshot, portfolioId: string, accountId: string): AmexAccount {
  if (!snapshot.portfolios.some((candidate) => candidate.id === portfolioId)) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The local provider sync portfolio is unavailable.",
    );
  }
  const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
  if (
    !account ||
    !account.active ||
    account.country !== "US" ||
    account.currency !== "USD" ||
    account.collectionMethod !== "provider"
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "Select an active U.S. consent account in the current local portfolio.",
    );
  }
  return account;
}

export function assertCompatibleProviderAccount(
  localAccount: AmexAccount,
  providerAccount: {
    readonly country: "US";
    readonly currency: "USD";
    readonly account_class: "personal" | "company";
  },
): void {
  if (
    localAccount.country !== providerAccount.country ||
    localAccount.currency !== providerAccount.currency ||
    localAccount.accountClass !== providerAccount.account_class
  ) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "The provider account does not match the selected local country, currency, and account class.",
    );
  }
}

function validateStatementTransactionLinks(
  transactions: readonly NormalizedV1ProviderTransaction[],
  statements: readonly NormalizedV1ProviderStatement[],
  snapshot: CoreSnapshot,
  account: AmexAccount,
): void {
  const rawTransactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const existingTransactionByExternalId = new Map(
    snapshot.transactions
      .filter((transaction) => transaction.source.accountId === account.id && transaction.externalId !== undefined)
      .map((transaction) => [transaction.externalId!, transaction]),
  );
  const statementById = new Map(statements.map((statement) => [statement.id, statement]));
  const existingStatementById = new Map(
    snapshot.statements
      .filter((statement) => statement.accountId === account.id)
      .map((statement) => [statement.id, statement]),
  );
  const transactionStatement = new Map<string, string>();
  for (const transaction of transactions) {
    if (!transaction.statement_id) continue;
    transactionStatement.set(transaction.id, transaction.statement_id);
    const fetchedStatement = statementById.get(transaction.statement_id);
    if (fetchedStatement) {
      if (!fetchedStatement.transaction_ids.includes(transaction.id)) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider transaction statement link was not reciprocated by the statement.",
        );
      }
      assertTransactionWithinStatement(transaction.posted_at, fetchedStatement);
      continue;
    }
    const existingStatement = existingStatementById.get(
      localProviderStatementId(account.id, transaction.statement_id),
    );
    if (
      !existingStatement ||
      !existingStatement.transactionIds.includes(localProviderTransactionId(account.id, transaction.id))
    ) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "A provider transaction referenced a statement that is not available for this account.",
      );
    }
    if (transaction.posted_at < existingStatement.periodStart || transaction.posted_at > existingStatement.periodEnd) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "A provider transaction date was outside its statement period.",
      );
    }
  }
  for (const statement of statements) {
    for (const transactionId of statement.transaction_ids) {
      const existing = transactionStatement.get(transactionId);
      if (existing !== undefined && existing !== statement.id) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The provider returned conflicting transaction-to-statement links.",
        );
      }
      transactionStatement.set(transactionId, statement.id);
      const rawTransaction = rawTransactionById.get(transactionId);
      if (rawTransaction) {
        assertTransactionWithinStatement(rawTransaction.posted_at, statement);
      } else {
        const existingTransaction = existingTransactionByExternalId.get(transactionId);
        if (existingTransaction) assertTransactionWithinStatement(existingTransaction.postedAt, statement);
      }
    }
  }
  const fetchedTransactionIds = new Set(transactions.map((transaction) => transaction.id));
  const existingProviderTransactionIds = new Set(
    snapshot.transactions
      .filter((transaction) => transaction.source.accountId === account.id)
      .map((transaction) => transaction.externalId)
      .filter((value): value is string => value !== undefined),
  );
  for (const statement of statements) {
    for (const transactionId of statement.transaction_ids) {
      if (!fetchedTransactionIds.has(transactionId) && !existingProviderTransactionIds.has(transactionId)) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider statement referenced a transaction that is not available for this account.",
        );
      }
    }
  }
  const statementIds = new Set(statements.map((statement) => statement.id));
  const existingProviderStatementIds = new Set(
    snapshot.statements
      .filter((statement) => statement.accountId === account.id && statement.id.startsWith("stmt_provider_"))
      .map((statement) => statement.id),
  );
  for (const [transactionId, statementId] of transactionStatement) {
    if (!statementIds.has(statementId)) {
      const localStatementId = localProviderStatementId(account.id, statementId);
      if (!existingProviderStatementIds.has(localStatementId)) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider transaction referenced a statement that is not available for this account.",
        );
      }
    }
    const raw = rawTransactionById.get(transactionId);
    if (raw && raw.statement_id !== undefined && raw.statement_id !== statementId) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned conflicting transaction-to-statement links.",
      );
    }
  }
}

function assertTransactionWithinStatement(
  postedAt: string,
  statement: Pick<NormalizedV1ProviderStatement, "period_start" | "period_end">,
): void {
  if (postedAt < statement.period_start || postedAt > statement.period_end) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "A provider transaction date was outside its statement period.",
    );
  }
}

function selectStatementsForSync(
  statements: readonly NormalizedV1ProviderStatement[],
  snapshot: CoreSnapshot,
  account: AmexAccount,
  configuredFrom: string,
): readonly NormalizedV1ProviderStatement[] {
  const selected: NormalizedV1ProviderStatement[] = [];
  const existingById = new Map(
    snapshot.statements
      .filter((statement) => statement.accountId === account.id)
      .map((statement) => [statement.id, statement]),
  );
  for (const statement of statements) {
    if (statement.period_end >= configuredFrom) {
      selected.push(statement);
      continue;
    }
    const existing = existingById.get(localProviderStatementId(account.id, statement.id));
    if (existing) {
      assertStatementImmutable(
        existing,
        toLocalProviderStatement(account, statement, existing.importedAt),
      );
    }
  }
  return selected;
}

function mergeProviderRecords(
  snapshot: CoreSnapshot,
  account: AmexAccount,
  fetchedTransactions: readonly FinancialTransaction[],
  fetchedStatements: readonly Statement[],
): {
  readonly transactions: readonly FinancialTransaction[];
  readonly statements: readonly Statement[];
  readonly newTransactions: readonly FinancialTransaction[];
  readonly newStatementCount: number;
  readonly duplicatesSkipped: number;
} {
  const existingForAccountById = new Map(
    snapshot.transactions
      .filter((transaction) => transaction.source.accountId === account.id)
      .map((transaction) => [transaction.id, transaction]),
  );
  const existingByFingerprint = new Map(
    snapshot.transactions.map((transaction) => [
      `${transaction.source.accountId}\0${transaction.importFingerprint}`,
      transaction,
    ]),
  );
  const additions: FinancialTransaction[] = [];
  const updatedTransactions = new Map<string, FinancialTransaction>();
  let duplicatesSkipped = 0;
  for (const transaction of fetchedTransactions) {
    const sameId = existingForAccountById.get(transaction.id);
    if (sameId) {
      if (sameId.importFingerprint !== transaction.importFingerprint) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider transaction changed immutable financial fields after an earlier sync.",
        );
      }
      duplicatesSkipped += 1;
      if (sameId.statementId === undefined && transaction.statementId !== undefined) {
        updatedTransactions.set(sameId.id, { ...sameId, statementId: transaction.statementId });
      } else if (sameId.statementId !== transaction.statementId && transaction.statementId !== undefined) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "A provider transaction changed its statement association after an earlier sync.",
        );
      }
      continue;
    }
    if (existingByFingerprint.has(`${account.id}\0${transaction.importFingerprint}`)) {
      duplicatesSkipped += 1;
      continue;
    }
    additions.push(transaction);
    existingByFingerprint.set(`${account.id}\0${transaction.importFingerprint}`, transaction);
  }

  const allTransactions = [
    ...snapshot.transactions.map((transaction) => updatedTransactions.get(transaction.id) ?? transaction),
    ...additions,
  ];
  const statementByTransactionId = new Map<string, string>();
  for (const statement of fetchedStatements) {
    for (const transactionId of statement.transactionIds) {
      const existingStatementId = statementByTransactionId.get(transactionId);
      if (existingStatementId !== undefined && existingStatementId !== statement.id) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The provider linked one transaction to multiple statements.",
        );
      }
      statementByTransactionId.set(transactionId, statement.id);
    }
  }
  const linkedTransactions = allTransactions.map((transaction) => {
    const statementId = statementByTransactionId.get(transaction.id);
    if (statementId === undefined) return transaction;
    if (transaction.statementId !== undefined && transaction.statementId !== statementId) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "A provider transaction changed its statement association after an earlier sync.",
      );
    }
    return transaction.statementId === statementId ? transaction : { ...transaction, statementId };
  });
  const availableTransactionIds = new Set(linkedTransactions.map((transaction) => transaction.id));
  const fetchedStatementById = new Map(fetchedStatements.map((statement) => [statement.id, statement]));
  for (const statement of fetchedStatements) {
    if (statement.transactionIds.some((id) => !availableTransactionIds.has(id))) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "A provider statement referenced an unavailable local transaction.",
      );
    }
  }
  let newStatementCount = 0;
  const replacedStatementIds = new Set<string>();
  const statements = snapshot.statements.map((statement) => {
    if (statement.accountId !== account.id) return statement;
    const replacement = fetchedStatementById.get(statement.id);
    if (!replacement) return statement;
    replacedStatementIds.add(statement.id);
    assertStatementImmutable(statement, replacement);
    return statement;
  });
  for (const statement of fetchedStatements) {
    if (!replacedStatementIds.has(statement.id)) {
      statements.push(statement);
      newStatementCount += 1;
    }
  }
  return {
    transactions: linkedTransactions,
    statements,
    newTransactions: additions,
    newStatementCount,
    duplicatesSkipped,
  };
}

function assertStatementImmutable(existing: Statement, fetched: Statement): void {
  const same =
    existing.accountId === fetched.accountId &&
    existing.periodStart === fetched.periodStart &&
    existing.periodEnd === fetched.periodEnd &&
    existing.openingBalance.amount === fetched.openingBalance.amount &&
    existing.openingBalance.currency === fetched.openingBalance.currency &&
    existing.closingBalance.amount === fetched.closingBalance.amount &&
    existing.closingBalance.currency === fetched.closingBalance.currency &&
    [...existing.transactionIds].sort().join("\0") === [...fetched.transactionIds].sort().join("\0");
  if (!same) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "A provider statement changed immutable financial fields after an earlier sync.",
    );
  }
}

function assertUniqueProviderIds(values: readonly { readonly id: string }[], label: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      `The provider returned duplicate ${label} across pages.`,
    );
  }
}

function isoDateDaysAgo(now: Date, days: number): string {
  const value = new Date(now.getTime());
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
