import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDemoSnapshot,
  EncryptedSqlFinancialStore,
  openEncryptedCore,
  type AuditEvent,
  ValidationError,
} from "../../src/core";
import type { KeyProtector } from "../../src/storage";
import { EncryptedSqlJsDatabase } from "../../src/storage";
import { makeAccount, makeAlert, makePortfolio, makeStatement, makeTransaction, NOW } from "./fixtures";

const createdDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of createdDirectories.splice(0)) {
    const resolvedDirectory = resolve(directory);
    const resolvedTemp = resolve(tmpdir());
    if (!resolvedDirectory.startsWith(`${resolvedTemp}\\`) && !resolvedDirectory.startsWith(`${resolvedTemp}/`)) {
      throw new Error(`Refusing to remove non-temporary test directory: ${resolvedDirectory}`);
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("EncryptedSqlFinancialStore", () => {
  it("migrates version-one stores to bounded global-order indexes", async () => {
    const database = {
      query: vi.fn(() => [{ user_version: 1 }]),
      exec: vi.fn(),
      save: vi.fn(async () => undefined),
    } as unknown as EncryptedSqlJsDatabase;
    const store = new EncryptedSqlFinancialStore(database);

    await store.initialize();

    expect(database.exec).toHaveBeenCalledWith(expect.stringContaining("idx_transactions_date_id_account"));
    expect(database.save).toHaveBeenCalledTimes(1);
  });

  it("round-trips the typed financial model and durable audit log in encrypted storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-financial-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "finance.db.enc");
    const protector = new TestKeyProtector();
    const runtime = await openEncryptedCore(
      { filePath, keyProtector: protector },
      { now: () => new Date(NOW) },
    );
    const snapshot = createDemoSnapshot(NOW);
    await runtime.store.replaceSnapshot(snapshot);

    const accounts = await runtime.service.listAccounts({ portfolioId: "demo-portfolio-all" });
    expect(accounts).toHaveLength(4);
    const report = await runtime.service.getPortfolioReport({ portfolioId: "demo-portfolio-all" });
    expect(report.totals.map((total) => total.currency).sort()).toEqual(["JPY", "USD"]);
    expect((await runtime.store.listAuditEvents()).map((event) => event.action).sort()).toEqual([
      "get_portfolio_report",
      "list_accounts",
    ]);
    await runtime.store.close();

    const diskBytes = await readFile(filePath);
    expect(diskBytes.includes(Buffer.from("Demo US Personal Card"))).toBe(false);
    expect(diskBytes.includes(Buffer.from("SQLite format 3"))).toBe(false);

    const reopened = await openEncryptedCore({ filePath, keyProtector: protector }, { now: () => new Date(NOW) });
    expect((await reopened.store.loadSnapshot()).accounts).toHaveLength(4);
    expect(await reopened.store.listAuditEvents()).toHaveLength(2);
    await reopened.store.close();
  });

  it("enforces bounded SQL keyset reads in canonical order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-keyset-store-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const account = makeAccount();
    const transactions = [
      makeTransaction(account, { id: "txn-b", postedAt: "2026-01-03", importFingerprint: "fingerprint-txn-b-000000" }),
      makeTransaction(account, { id: "txn-c", postedAt: "2026-01-02", importFingerprint: "fingerprint-txn-c-000000" }),
      makeTransaction(account, { id: "txn-a", postedAt: "2026-01-03", importFingerprint: "fingerprint-txn-a-000000" }),
    ];
    await runtime.store.replaceSnapshot({
      accounts: [account],
      portfolios: [makePortfolio([account])],
      transactions,
      statements: [],
      fraudAlerts: [],
    });

    const first = await runtime.store.listTransactions({ accountIds: [account.id], limit: 2 });
    const second = await runtime.store.listTransactions({
      accountIds: [account.id],
      after: { postedAt: first[1]!.postedAt, id: first[1]!.id },
      limit: 2,
    });

    expect(first.map((transaction) => transaction.id)).toEqual(["txn-a", "txn-b"]);
    expect(second.map((transaction) => transaction.id)).toEqual(["txn-c"]);
    await expect(runtime.store.listTransactions({ accountIds: [account.id], limit: 5_001 })).rejects.toThrow(
      /Read limit/u,
    );
    await runtime.store.close();
  });

  it("commits a snapshot and its audit event with one encrypted save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-atomic-financial-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "finance.db.enc");
    const protector = new TestKeyProtector();
    const runtime = await openEncryptedCore({ filePath, keyProtector: protector });
    const snapshot = createDemoSnapshot(NOW);
    const event = mutationAuditEvent("atomic-mutation-1");
    const save = vi.spyOn(runtime.database, "save");

    await runtime.store.replaceSnapshotWithAudit(snapshot, event);

    expect(save).toHaveBeenCalledTimes(1);
    expect((await runtime.store.loadSnapshot()).accounts).toHaveLength(snapshot.accounts.length);
    expect(await runtime.store.listAuditEvents()).toEqual([event]);
    await runtime.store.close({ save: false });

    const reopened = await openEncryptedCore({ filePath, keyProtector: protector });
    expect((await reopened.store.loadSnapshot()).accounts).toHaveLength(snapshot.accounts.length);
    expect(await reopened.store.listAuditEvents()).toEqual([event]);
    await reopened.store.close();
  });

  it("rejects secret-shaped audit metadata before mutating or saving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-secret-audit-store-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const event: AuditEvent = {
      ...mutationAuditEvent("secret-audit"),
      metadata: { accessToken: "must-not-persist" },
    };
    const save = vi.spyOn(runtime.database, "save");

    await expect(runtime.store.replaceSnapshotWithAudit(createDemoSnapshot(NOW), event)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(save).not.toHaveBeenCalled();
    expect(await runtime.store.loadSnapshot()).toMatchObject({ accounts: [], portfolios: [] });
    expect(await runtime.store.listAuditEvents()).toEqual([]);
    await runtime.store.close({ save: false });
  });

  it("rolls back the domain replacement when the audit insert fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-audit-rollback-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "finance.db.enc");
    const protector = new TestKeyProtector();
    const runtime = await openEncryptedCore({ filePath, keyProtector: protector });
    const original = createDemoSnapshot(NOW);
    const duplicateEvent = mutationAuditEvent("duplicate-audit-id");
    await runtime.store.replaceSnapshotWithAudit(original, duplicateEvent);
    const encryptedBeforeFailure = await readFile(filePath);
    const changed = {
      ...original,
      portfolios: original.portfolios.map((portfolio) => ({ ...portfolio, name: `${portfolio.name} changed` })),
    };
    const save = vi.spyOn(runtime.database, "save");

    await expect(runtime.store.replaceSnapshotWithAudit(changed, duplicateEvent)).rejects.toThrowError(/unique/iu);

    expect(save).not.toHaveBeenCalled();
    expect((await runtime.store.loadSnapshot()).portfolios.map((portfolio) => portfolio.name)).toEqual(
      original.portfolios.map((portfolio) => portfolio.name),
    );
    expect(await runtime.store.listAuditEvents()).toEqual([duplicateEvent]);
    expect(await readFile(filePath)).toEqual(encryptedBeforeFailure);
    await runtime.store.close({ save: false });

    const reopened = await openEncryptedCore({ filePath, keyProtector: protector });
    expect((await reopened.store.loadSnapshot()).portfolios.map((portfolio) => portfolio.name)).toEqual(
      original.portfolios.map((portfolio) => portfolio.name),
    );
    expect(await reopened.store.listAuditEvents()).toEqual([duplicateEvent]);
    await reopened.store.close();
  });

  it("rolls back partial domain SQL when a statement fails before the audit insert", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-sql-rollback-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "finance.db.enc");
    const protector = new TestKeyProtector();
    const runtime = await openEncryptedCore({ filePath, keyProtector: protector });
    const original = createDemoSnapshot(NOW);
    const originalEvent = mutationAuditEvent("original-audit-id");
    await runtime.store.replaceSnapshotWithAudit(original, originalEvent);
    const encryptedBeforeFailure = await readFile(filePath);
    const changed = {
      ...original,
      portfolios: original.portfolios.map((portfolio) => ({ ...portfolio, name: `${portfolio.name} changed` })),
    };
    const originalRun = runtime.database.run.bind(runtime.database);
    const run = vi.spyOn(runtime.database, "run").mockImplementation((sql, params) => {
      if (sql.startsWith("INSERT INTO portfolios")) throw new Error("injected portfolio insert failure");
      return originalRun(sql, params);
    });
    const save = vi.spyOn(runtime.database, "save");

    await expect(
      runtime.store.replaceSnapshotWithAudit(changed, mutationAuditEvent("uncommitted-audit-id")),
    ).rejects.toThrowError("injected portfolio insert failure");
    run.mockRestore();

    expect(save).not.toHaveBeenCalled();
    expect((await runtime.store.loadSnapshot()).portfolios.map((portfolio) => portfolio.name)).toEqual(
      original.portfolios.map((portfolio) => portfolio.name),
    );
    expect(await runtime.store.listAuditEvents()).toEqual([originalEvent]);
    expect(await readFile(filePath)).toEqual(encryptedBeforeFailure);
    await runtime.store.close({ save: false });

    const reopened = await openEncryptedCore({ filePath, keyProtector: protector });
    expect((await reopened.store.loadSnapshot()).portfolios.map((portfolio) => portfolio.name)).toEqual(
      original.portfolios.map((portfolio) => portfolio.name),
    );
    expect(await reopened.store.listAuditEvents()).toEqual([originalEvent]);
    await reopened.store.close();
  });

  it("does not seed demo data when opening an empty production database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-empty-store-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    expect(await runtime.store.loadSnapshot()).toEqual({
      accounts: [],
      portfolios: [],
      transactions: [],
      statements: [],
      fraudAlerts: [],
    });
    await runtime.store.close();
  });

  it("rejects financial snapshots containing credential-like fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-invalid-store-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const snapshot = createDemoSnapshot(NOW);
    const tainted = { ...snapshot, accidentalAccessToken: "must-not-persist" };
    await expect(runtime.store.replaceSnapshot(tainted)).rejects.toBeInstanceOf(ValidationError);
    await runtime.store.close();
  });

  it("closes a decrypted database without saving when encrypted core initialization fails", async () => {
    const close = vi.fn(async () => undefined);
    const fakeDatabase = {
      query: vi.fn(() => [{ user_version: 999 }]),
      close,
    } as unknown as EncryptedSqlJsDatabase;
    vi.spyOn(EncryptedSqlJsDatabase, "openOrCreate").mockResolvedValue(fakeDatabase);

    await expect(
      openEncryptedCore({ filePath: "unused-by-injected-opener", keyProtector: new TestKeyProtector() }),
    ).rejects.toThrowError(/schema version is unsupported/iu);
    expect(close).toHaveBeenCalledExactlyOnceWith({ save: false });
  });

  it("rejects a statement that points from account A to account B's transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-cross-statement-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const accountA = makeAccount({ id: "account-a" });
    const accountB = makeAccount({ id: "account-b", legalEntityId: "entity-b" });
    const transactionB = makeTransaction(accountB, { id: "transaction-b" });
    const statementA = makeStatement(accountA, transactionB);

    await expect(
      runtime.store.replaceSnapshot({
        accounts: [accountA, accountB],
        portfolios: [makePortfolio([accountA, accountB])],
        transactions: [transactionB],
        statements: [statementA],
        fraudAlerts: [],
      }),
    ).rejects.toThrowError(/another account/iu);
    await runtime.store.close();
  });

  it("rejects a transaction whose optional statementId does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-missing-reverse-statement-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const account = makeAccount({ id: "account-a" });
    const transaction = makeTransaction(account, { id: "transaction-a", statementId: "missing-statement" });

    await expect(
      runtime.store.replaceSnapshot({
        accounts: [account],
        portfolios: [makePortfolio([account])],
        transactions: [transaction],
        statements: [],
        fraudAlerts: [],
      }),
    ).rejects.toThrowError(/unknown statement/iu);
    await runtime.store.close();
  });

  it("rejects a transaction on account A whose statementId points to account B", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-cross-reverse-statement-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const accountA = makeAccount({ id: "account-a" });
    const accountB = makeAccount({ id: "account-b", legalEntityId: "entity-b" });
    const statementB = {
      ...makeStatement(accountB, makeTransaction(accountB, { id: "unused-b" })),
      id: "statement-b",
      transactionIds: [],
    };
    const transactionA = makeTransaction(accountA, { id: "transaction-a", statementId: statementB.id });

    await expect(
      runtime.store.replaceSnapshot({
        accounts: [accountA, accountB],
        portfolios: [makePortfolio([accountA, accountB])],
        transactions: [transactionA],
        statements: [statementB],
        fraudAlerts: [],
      }),
    ).rejects.toThrowError(/statement owned by another account/iu);
    await runtime.store.close();
  });

  it("rejects cross-account fraud alert transactionIds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-cross-alert-id-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const accountA = makeAccount({ id: "account-a" });
    const accountB = makeAccount({ id: "account-b", legalEntityId: "entity-b" });
    const transactionB = makeTransaction(accountB, { id: "transaction-b" });
    const crossAccountAlert = makeAlert(accountA, transactionB);

    await expect(
      runtime.store.replaceSnapshot({
        accounts: [accountA, accountB],
        portfolios: [makePortfolio([accountA, accountB])],
        transactions: [transactionB],
        statements: [],
        fraudAlerts: [crossAccountAlert],
      }),
    ).rejects.toThrowError(/another account/iu);
    await runtime.store.close();
  });

  it("rejects cross-account transaction evidence even when transactionIds are account-local", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-cross-alert-evidence-"));
    createdDirectories.push(directory);
    const runtime = await openEncryptedCore({
      filePath: join(directory, "finance.db.enc"),
      keyProtector: new TestKeyProtector(),
    });
    const accountA = makeAccount({ id: "account-a" });
    const accountB = makeAccount({ id: "account-b", legalEntityId: "entity-b" });
    const transactionA = makeTransaction(accountA, { id: "transaction-a" });
    const transactionB = makeTransaction(accountB, { id: "transaction-b" });
    const alert = {
      ...makeAlert(accountA, transactionA),
      transactionIds: [transactionA.id],
      evidence: [`transaction:${transactionB.id}`],
    };

    await expect(
      runtime.store.replaceSnapshot({
        accounts: [accountA, accountB],
        portfolios: [makePortfolio([accountA, accountB])],
        transactions: [transactionA, transactionB],
        statements: [],
        fraudAlerts: [alert],
      }),
    ).rejects.toThrowError(/another account/iu);
    await runtime.store.close();
  });
});

class TestKeyProtector implements KeyProtector {
  public readonly id = "test.financial.keyprotector.v1";
  readonly #master = Buffer.alloc(32, 0x44);

  public assertAvailable(): void {}

  public protectKey(key: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#master, iv);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  public unprotectKey(protectedKey: Uint8Array): Uint8Array {
    const bytes = Buffer.from(protectedKey);
    const decipher = createDecipheriv("aes-256-gcm", this.#master, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}

function mutationAuditEvent(id: string): AuditEvent {
  return {
    id,
    occurredAt: NOW,
    action: "financial_snapshot_replaced",
    outcome: "success",
    accountIds: [],
    portfolioId: "demo-portfolio-all",
    metadata: { source: "test" },
  };
}
