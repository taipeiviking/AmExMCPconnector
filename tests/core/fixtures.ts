import type {
  AmexAccount,
  CoreSnapshot,
  FinancialTransaction,
  FraudAlert,
  Portfolio,
  Statement,
} from "../../src/core";

export const NOW = "2026-01-31T12:00:00.000Z";

export function makeAccount(overrides: Partial<AmexAccount> = {}): AmexAccount {
  return {
    id: "account-us-personal",
    displayName: "Test Personal",
    legalEntityId: "entity-owner",
    legalEntityName: "Test Owner",
    country: "US",
    currency: "USD",
    accountClass: "personal",
    businessPurpose: null,
    collectionMethod: "provider",
    authorization: { state: "authorized", checkedAt: NOW, expiresAt: "2027-01-01T00:00:00.000Z" },
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeTransaction(
  account: AmexAccount = makeAccount(),
  overrides: Partial<FinancialTransaction> = {},
): FinancialTransaction {
  return {
    id: "txn-1",
    source: {
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      legalEntityName: account.legalEntityName,
      country: account.country,
      accountClass: account.accountClass,
      accountCurrency: account.currency,
      businessPurpose: account.businessPurpose,
    },
    postedAt: "2026-01-10",
    description: "Test Merchant",
    amount: "-10.00",
    currency: account.currency,
    categoryId: null,
    memo: null,
    importFingerprint: `fingerprint-${account.id}-0000000000`,
    importedAt: NOW,
    ...overrides,
  };
}

export function makePortfolio(accounts: readonly AmexAccount[], overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    id: "portfolio-1",
    name: "Selected accounts",
    accountIds: accounts.map((account) => account.id),
    ownerControlled: true,
    storageScope: "this_device_only",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeStatement(account: AmexAccount, transaction: FinancialTransaction): Statement {
  return {
    id: "statement-1",
    accountId: account.id,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    openingBalance: { amount: "100.00", currency: account.currency },
    closingBalance: { amount: "90.00", currency: account.currency },
    transactionIds: [transaction.id],
    importedAt: NOW,
    sourceFileFingerprint: "statement-fingerprint-000000",
  };
}

export function makeAlert(account: AmexAccount, transaction: FinancialTransaction): FraudAlert {
  return {
    id: "alert-1",
    accountId: account.id,
    transactionIds: [transaction.id],
    kind: "large_amount",
    severity: "medium",
    status: "open",
    title: "Review amount",
    explanation: "Configured threshold was reached.",
    evidence: [`transaction:${transaction.id}`],
    reviewOnly: true,
    detectedAt: NOW,
  };
}

export function makeSnapshot(options: {
  readonly accounts?: readonly AmexAccount[];
  readonly transactions?: readonly FinancialTransaction[];
  readonly portfolios?: readonly Portfolio[];
  readonly statements?: readonly Statement[];
  readonly fraudAlerts?: readonly FraudAlert[];
} = {}): CoreSnapshot {
  const accounts = options.accounts ?? [makeAccount()];
  const transactions = options.transactions ?? [makeTransaction(accounts[0])];
  return {
    accounts,
    transactions,
    portfolios: options.portfolios ?? [makePortfolio(accounts)],
    statements: options.statements ?? [],
    fraudAlerts: options.fraudAlerts ?? [],
  };
}
