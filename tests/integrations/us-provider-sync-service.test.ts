import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../../src/core/audit";
import type { AmexAccount, CoreSnapshot } from "../../src/core/domain";
import type {
  ProviderAccountSelection,
  ProviderReadResult,
  ReadOnlyFinancialProvider,
} from "../../src/integrations/provider-types";
import {
  UsProviderSyncService,
  type AtomicFinancialSyncStore,
  type ProviderAccountBindingLookup,
} from "../../src/integrations/us-provider-sync-service";

const now = "2026-09-07T12:00:00.000Z";
const localAccount: AmexAccount = {
  id: "local-us-account",
  displayName: "Owner nickname",
  legalEntityId: "owner-entity",
  legalEntityName: "Local Owner",
  country: "US",
  currency: "USD",
  accountClass: "personal",
  businessPurpose: "Travel",
  collectionMethod: "provider",
  authorization: { state: "authorized", checkedAt: now },
  active: true,
  createdAt: now,
  updatedAt: now,
};

describe("U.S. provider sync", () => {
  it("selects exactly one bound account, reconciles pages, and atomically commits data with audit", async () => {
    const store = new CapturingStore(emptySnapshot());
    const financial = new TestProvider();
    const service = createService(store, financial);

    await expect(service.sync(localAccount.id)).resolves.toEqual({
      importedTransactions: 2,
      importedStatements: 1,
      duplicatesSkipped: 0,
    });
    expect(financial.selections).toEqual([
      { localAccountId: localAccount.id, providerAccountId: "provider-account-1" },
      { localAccountId: localAccount.id, providerAccountId: "provider-account-1" },
      { localAccountId: localAccount.id, providerAccountId: "provider-account-1" },
      { localAccountId: localAccount.id, providerAccountId: "provider-account-1" },
    ]);
    expect(financial.transactionFilters).toEqual([
      { from: "2026-08-08", pageSize: 100 },
      { from: "2026-08-08", pageSize: 100, cursor: "page-2" },
    ]);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      action: "provider_account_synced",
      outcome: "success",
      accountIds: [localAccount.id],
      portfolioId: "owner-portfolio",
      metadata: {
        provider: "approved-provider-generic",
        responseProfile: "normalized_v1",
        transactionPages: 2,
        importedTransactions: 2,
        importedStatements: 1,
      },
    });
    expect(store.snapshot.transactions).toHaveLength(2);
    expect(store.snapshot.statements).toHaveLength(1);
    expect(store.snapshot.fraudAlerts.every((alert) => alert.reviewOnly)).toBe(true);
    expect(store.snapshot.accounts[0]?.authorization.state).toBe("authorized");

    await expect(service.sync(localAccount.id)).resolves.toEqual({
      importedTransactions: 0,
      importedStatements: 0,
      duplicatesSkipped: 2,
    });
    expect(store.snapshot.transactions).toHaveLength(2);
    expect(store.snapshot.statements).toHaveLength(1);
    expect(store.events).toHaveLength(2);
  });

  it("fails closed on cross-account payloads without publishing a partial snapshot", async () => {
    const store = new CapturingStore(emptySnapshot());
    const financial = new TestProvider();
    financial.transactionAccountId = "different-provider-account";

    await expect(createService(store, financial).sync(localAccount.id)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
    expect(store.events).toHaveLength(0);
    expect(store.snapshot.transactions).toHaveLength(0);
  });

  it("rejects an unreconciled provider statement without publishing it", async () => {
    const store = new CapturingStore(emptySnapshot());
    const financial = new TestProvider();
    financial.statementClosingBalance = "999.00";

    await expect(createService(store, financial).sync(localAccount.id)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
    expect(store.events).toHaveLength(0);
    expect(store.snapshot.statements).toHaveLength(0);
  });

  it("requires reciprocal statement links and in-period transaction dates", async () => {
    const missingReciprocalStore = new CapturingStore(emptySnapshot());
    const missingReciprocal = new TestProvider();
    missingReciprocal.statementTransactionIds = ["transaction-2"];
    await expect(createService(missingReciprocalStore, missingReciprocal).sync(localAccount.id))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(missingReciprocalStore.events).toHaveLength(0);

    const outsidePeriodStore = new CapturingStore(emptySnapshot());
    const outsidePeriod = new TestProvider();
    outsidePeriod.statementPeriodStart = "2026-09-02";
    await expect(createService(outsidePeriodStore, outsidePeriod).sync(localAccount.id))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(outsidePeriodStore.events).toHaveLength(0);
  });

  it("rejects same-ID statement rewrites and oversized pages", async () => {
    const immutableStore = new CapturingStore(emptySnapshot());
    const rewritten = new TestProvider();
    const service = createService(immutableStore, rewritten);
    await service.sync(localAccount.id);
    rewritten.statementPeriodEnd = "2026-10-01";
    await expect(service.sync(localAccount.id)).rejects.toMatchObject({
      code: "INVALID_PROVIDER_RESPONSE",
    });
    expect(immutableStore.events).toHaveLength(1);

    const oversizedStore = new CapturingStore(emptySnapshot());
    const oversized = new TestProvider();
    oversized.addOverflowTransaction = true;
    await expect(createService(oversizedStore, oversized, 1).sync(localAccount.id))
      .rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    expect(oversizedStore.events).toHaveLength(0);
  });

  it("extends the transaction window to the start of an in-scope statement", async () => {
    const store = new CapturingStore(emptySnapshot());
    const financial = new TestProvider();
    financial.statementPeriodStart = "2026-07-31";
    await createService(store, financial).sync(localAccount.id);
    expect(financial.transactionFilters[0]).toMatchObject({ from: "2026-07-31" });
  });
});

class CapturingStore implements AtomicFinancialSyncStore {
  public readonly events: AuditEvent[] = [];

  public constructor(public snapshot: CoreSnapshot) {}

  public async loadSnapshot(): Promise<CoreSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async replaceSnapshotWithAudit(snapshot: CoreSnapshot, event: AuditEvent): Promise<void> {
    this.snapshot = structuredClone(snapshot);
    this.events.push(structuredClone(event));
  }
}

class TestProvider implements ReadOnlyFinancialProvider {
  public transactionAccountId = "provider-account-1";
  public statementClosingBalance = "120.00";
  public statementPeriodStart = "2026-09-01";
  public statementPeriodEnd = "2026-09-30";
  public statementTransactionIds = ["transaction-1", "transaction-2"];
  public addOverflowTransaction = false;
  public readonly selections: ProviderAccountSelection[] = [];
  public readonly transactionFilters: Array<Record<string, unknown>> = [];

  public abortPending(): void {}

  public async listAccounts(_localAccountId: string): Promise<ProviderReadResult> {
    throw new Error("Account discovery is outside sync.");
  }

  public async getAccountStatus(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    this.selections.push({ ...selection });
    return {
      data: {
        profile: "normalized_v1",
        account: {
          id: "provider-account-1",
          country: "US",
          currency: "USD",
          account_class: "personal",
          status: "active",
          last_four: "4242",
        },
      },
    };
  }

  public async listTransactions(
    selection: ProviderAccountSelection,
    filter: { readonly from?: string; readonly to?: string; readonly cursor?: string; readonly pageSize?: number } = {},
  ): Promise<ProviderReadResult> {
    this.selections.push({ ...selection });
    this.transactionFilters.push({ ...filter });
    const secondPage = filter.cursor === "page-2";
    const transaction = secondPage
      ? {
          id: "transaction-2",
          posted_at: "2026-09-02",
          authorized_at: "2026-09-02T01:02:03.000Z",
          description: "Provider credit",
          amount: "20.00",
          currency: "USD",
          statement_id: "statement-1",
        }
      : {
          id: "transaction-1",
          posted_at: "2026-09-01",
          authorized_at: "2026-09-01T01:02:03.000Z",
          description: "Provider charge",
          merchant_country: "GB",
          amount: "-100.00",
          currency: "USD",
          statement_id: "statement-1",
        };
    return {
      data: {
        profile: "normalized_v1",
        account_id: this.transactionAccountId,
        transactions: !secondPage && this.addOverflowTransaction
          ? [transaction, { ...transaction, id: "overflow-transaction" }]
          : [transaction],
        next_cursor: secondPage ? null : "page-2",
      },
    };
  }

  public async listStatements(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    this.selections.push({ ...selection });
    return {
      data: {
        profile: "normalized_v1",
        account_id: "provider-account-1",
        statements: [{
          id: "statement-1",
          period_start: this.statementPeriodStart,
          period_end: this.statementPeriodEnd,
          opening_balance: "200.00",
          closing_balance: this.statementClosingBalance,
          currency: "USD",
          transaction_ids: this.statementTransactionIds,
        }],
      },
    };
  }

  public async getStatement(
    _selection: ProviderAccountSelection,
    _providerStatementId: string,
  ): Promise<ProviderReadResult> {
    throw new Error("Individual statement fetch is outside bulk sync.");
  }
}

function createService(
  store: CapturingStore,
  financial: ReadOnlyFinancialProvider,
  pageSize = 100,
): UsProviderSyncService {
  const bindings: ProviderAccountBindingLookup = {
    get: vi.fn(async (providerId, localAccountId) => {
      expect(providerId).toBe("approved-provider-generic");
      expect(localAccountId).toBe(localAccount.id);
      return { providerAccountId: "provider-account-1", lastFour: "4242" };
    }),
  };
  return new UsProviderSyncService(store, financial, bindings, {
    providerId: "approved-provider-generic",
    portfolioId: "owner-portfolio",
    lookbackDays: 30,
    pageSize,
    alertsEnabled: true,
    highValueUsd: "50.00",
    now: () => new Date(now),
  });
}

function emptySnapshot(): CoreSnapshot {
  return {
    accounts: [structuredClone(localAccount)],
    portfolios: [{
      id: "owner-portfolio",
      name: "Owner portfolio",
      accountIds: [localAccount.id],
      ownerControlled: true,
      storageScope: "this_device_only",
      createdAt: now,
      updatedAt: now,
    }],
    transactions: [],
    statements: [],
    fraudAlerts: [],
  };
}
