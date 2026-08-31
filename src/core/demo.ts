import { InMemoryAuditSink } from "./audit";
import type { AmexAccount, CoreSnapshot, FinancialTransaction, FraudAlert, Portfolio, Statement } from "./domain";
import { detectReviewOnlyAlerts } from "./fraud";
import { FinanceQueryService } from "./query-service";
import { InMemoryFinancialStore } from "./repository";

export const EMPTY_SNAPSHOT: CoreSnapshot = Object.freeze({
  accounts: Object.freeze([]),
  portfolios: Object.freeze([]),
  transactions: Object.freeze([]),
  statements: Object.freeze([]),
  fraudAlerts: Object.freeze([]),
});

export interface CoreRuntime {
  readonly store: InMemoryFinancialStore;
  readonly service: FinanceQueryService;
  readonly audit: InMemoryAuditSink;
}

/** Production-safe empty runtime. It never falls back to demo records. */
export function createEmptyCore(options: { readonly now?: () => Date } = {}): CoreRuntime {
  return createRuntime(EMPTY_SNAPSHOT, options.now);
}

/**
 * Explicit demo-only seed. All names and identifiers are synthetic and contain no credentials.
 */
export function createDemoCore(options: { readonly now?: () => Date } = {}): CoreRuntime {
  const now = options.now ?? (() => new Date("2026-01-15T12:00:00.000Z"));
  return createRuntime(createDemoSnapshot(now().toISOString()), now);
}

export function createDemoSnapshot(now: string): CoreSnapshot {
  const accounts: AmexAccount[] = [
    account({
      id: "demo-us-personal",
      displayName: "Demo US Personal Card",
      legalEntityId: "demo-person",
      legalEntityName: "Demo Cardmember",
      country: "US",
      currency: "USD",
      accountClass: "personal",
      businessPurpose: null,
      collectionMethod: "provider",
      authorizationState: "authorized",
      now,
    }),
    account({
      id: "demo-us-company",
      displayName: "Demo US Company Card",
      legalEntityId: "demo-company-us",
      legalEntityName: "Example US Company",
      country: "US",
      currency: "USD",
      accountClass: "company",
      businessPurpose: "Operating expenses",
      collectionMethod: "provider",
      authorizationState: "authorized",
      now,
    }),
    account({
      id: "demo-jp-personal",
      displayName: "デモ日本個人カード",
      legalEntityId: "demo-person",
      legalEntityName: "デモ会員",
      country: "JP",
      currency: "JPY",
      accountClass: "personal",
      businessPurpose: null,
      collectionMethod: "statement_import",
      authorizationState: "import_only",
      now,
    }),
    account({
      id: "demo-jp-company",
      displayName: "デモ日本法人カード",
      legalEntityId: "demo-company-jp",
      legalEntityName: "デモ株式会社",
      country: "JP",
      currency: "JPY",
      accountClass: "company",
      businessPurpose: "出張費",
      collectionMethod: "statement_import",
      authorizationState: "import_only",
      now,
    }),
  ];
  const portfolios: Portfolio[] = [
    {
      id: "demo-portfolio-all",
      name: "Demo owner-selected portfolio",
      accountIds: accounts.map((item) => item.id),
      ownerControlled: true,
      storageScope: "this_device_only",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const transactions: FinancialTransaction[] = [
    transaction(accounts[0]!, "demo-txn-us-1", "2026-01-03", "Neighborhood Market", "-42.18", "fp-demo-us-0000000001", now),
    transaction(accounts[1]!, "demo-txn-us-2", "2026-01-05", "Cloud Hosting Example", "-320.00", "fp-demo-us-0000000002", now),
    transaction(accounts[2]!, "demo-txn-jp-1", "2026-01-06", "サンプル書店", "-2800", "fp-demo-jp-0000000001", now),
    transaction(accounts[3]!, "demo-txn-jp-2", "2026-01-07", "デモ鉄道", "-14500", "fp-demo-jp-0000000002", now),
  ];
  const statements: Statement[] = [
    {
      id: "demo-statement-us-personal-2026-01",
      accountId: accounts[0]!.id,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      openingBalance: { amount: "100.00", currency: "USD" },
      closingBalance: { amount: "57.82", currency: "USD" },
      transactionIds: [transactions[0]!.id],
      importedAt: now,
      sourceFileFingerprint: "demo-statement-fingerprint-not-a-real-file",
    },
  ];
  const fraudAlerts: FraudAlert[] = [...detectReviewOnlyAlerts(transactions, {
    largeAmountThresholds: { USD: "250.00", JPY: "10000" },
    detectedAt: now,
  })];
  return { accounts, portfolios, transactions, statements, fraudAlerts };
}

function createRuntime(snapshot: CoreSnapshot, now: (() => Date) | undefined): CoreRuntime {
  const store = new InMemoryFinancialStore(snapshot);
  const audit = new InMemoryAuditSink();
  const service = new FinanceQueryService(store, {
    auditSink: audit,
    ...(now === undefined ? {} : { now }),
  });
  return { store, service, audit };
}

function account(input: {
  readonly id: string;
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly legalEntityName: string;
  readonly country: AmexAccount["country"];
  readonly currency: AmexAccount["currency"];
  readonly accountClass: AmexAccount["accountClass"];
  readonly businessPurpose: string | null;
  readonly collectionMethod: AmexAccount["collectionMethod"];
  readonly authorizationState: AmexAccount["authorization"]["state"];
  readonly now: string;
}): AmexAccount {
  return {
    id: input.id,
    displayName: input.displayName,
    legalEntityId: input.legalEntityId,
    legalEntityName: input.legalEntityName,
    country: input.country,
    currency: input.currency,
    accountClass: input.accountClass,
    businessPurpose: input.businessPurpose,
    collectionMethod: input.collectionMethod,
    authorization: { state: input.authorizationState, checkedAt: input.now },
    active: true,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function transaction(
  sourceAccount: AmexAccount,
  id: string,
  postedAt: string,
  description: string,
  amount: string,
  importFingerprint: string,
  importedAt: string,
): FinancialTransaction {
  return {
    id,
    source: {
      accountId: sourceAccount.id,
      legalEntityId: sourceAccount.legalEntityId,
      legalEntityName: sourceAccount.legalEntityName,
      country: sourceAccount.country,
      accountClass: sourceAccount.accountClass,
      accountCurrency: sourceAccount.currency,
      businessPurpose: sourceAccount.businessPurpose,
    },
    postedAt,
    description,
    amount,
    currency: sourceAccount.currency,
    categoryId: null,
    memo: null,
    importFingerprint,
    importedAt,
  };
}
