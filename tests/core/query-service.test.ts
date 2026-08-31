import { describe, expect, it } from "vitest";

import {
  AuthorizationRequiredError,
  FinanceQueryService,
  InMemoryAuditSink,
  InMemoryFinancialStore,
  NotFoundError,
  ValidationError,
} from "../../src/core";
import { makeAccount, makeAlert, makePortfolio, makeSnapshot, makeStatement, makeTransaction, NOW } from "./fixtures";

describe("FinanceQueryService", () => {
  it("lists only accounts explicitly selected by a portfolio", async () => {
    const selected = makeAccount();
    const hidden = makeAccount({ id: "hidden-account", displayName: "Must not enumerate" });
    const snapshot = makeSnapshot({
      accounts: [selected, hidden],
      portfolios: [makePortfolio([selected])],
      transactions: [],
    });
    const service = new FinanceQueryService(new InMemoryFinancialStore(snapshot));

    await expect(service.listAccounts({ portfolioId: "portfolio-1" })).resolves.toMatchObject([{ id: selected.id }]);
    await expect(service.listAccounts({ portfolioId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("filters a selected portfolio by country and account class", async () => {
    const us = makeAccount();
    const jp = makeAccount({
      id: "jp-company",
      country: "JP",
      currency: "JPY",
      accountClass: "company",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const service = new FinanceQueryService(
      new InMemoryFinancialStore(makeSnapshot({ accounts: [us, jp], portfolios: [makePortfolio([us, jp])], transactions: [] })),
    );

    const result = await service.listAccounts({ portfolioId: "portfolio-1", country: "JP", accountClass: "company" });
    expect(result.map((account) => account.id)).toEqual([jp.id]);
  });

  it("reports expired consent as reauthorization required without reading data", async () => {
    const account = makeAccount({
      authorization: { state: "authorized", checkedAt: NOW, expiresAt: "2025-01-01T00:00:00.000Z" },
    });
    const transaction = makeTransaction(account);
    const audit = new InMemoryAuditSink();
    const service = new FinanceQueryService(new InMemoryFinancialStore(makeSnapshot({ accounts: [account], transactions: [transaction] })), {
      now: () => new Date(NOW),
      auditSink: audit,
    });

    await expect(service.getAccountStatus({ accountId: account.id })).resolves.toMatchObject({
      availableForQueries: false,
      recommendedAction: "reauthorize",
      authorization: { state: "reauthorization_required" },
    });
    await expect(
      service.listTransactions({ target: { kind: "account", accountId: account.id } }),
    ).rejects.toBeInstanceOf(AuthorizationRequiredError);
    expect(audit.list().some((event) => event.action === "authorization_check" && event.outcome === "denied")).toBe(true);
  });

  it("allows import-only accounts without asking for OAuth reauthorization", async () => {
    const account = makeAccount({
      id: "jp-import",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const transaction = makeTransaction(account, { amount: "-1200" });
    const service = new FinanceQueryService(
      new InMemoryFinancialStore(makeSnapshot({ accounts: [account], transactions: [transaction] })),
    );

    const page = await service.listTransactions({ target: { kind: "account", accountId: account.id } });
    expect(page.transactions).toHaveLength(1);
  });

  it("uses scoped pagination cursors that cannot be replayed against another target", async () => {
    const first = makeAccount();
    const second = makeAccount({ id: "second" });
    const transactions = [
      makeTransaction(first, { id: "txn-a", postedAt: "2026-01-03" }),
      makeTransaction(first, { id: "txn-b", postedAt: "2026-01-02" }),
      makeTransaction(second, { id: "txn-c", postedAt: "2026-01-01" }),
    ];
    const store = new InMemoryFinancialStore(
      makeSnapshot({ accounts: [first, second], transactions, portfolios: [makePortfolio([first, second])] }),
    );
    const service = new FinanceQueryService(store);
    const page = await service.listTransactions({ target: { kind: "account", accountId: first.id }, limit: 1 });
    expect(page.transactions[0]?.id).toBe("txn-a");
    expect(page.nextCursor).not.toBeNull();

    await expect(
      service.listTransactions({
        target: { kind: "account", accountId: second.id },
        cursor: page.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("scopes statements and fraud alert explanations to the selected account", async () => {
    const account = makeAccount();
    const other = makeAccount({ id: "other" });
    const transaction = makeTransaction(account);
    const statement = makeStatement(account, transaction);
    const alert = makeAlert(account, transaction);
    const service = new FinanceQueryService(
      new InMemoryFinancialStore(
        makeSnapshot({
          accounts: [account, other],
          portfolios: [makePortfolio([account, other])],
          transactions: [transaction],
          statements: [statement],
          fraudAlerts: [alert],
        }),
      ),
    );

    await expect(service.getStatement({ accountId: account.id, statementId: statement.id })).resolves.toMatchObject({
      id: statement.id,
    });
    await expect(service.getStatement({ accountId: other.id, statementId: statement.id })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.explainAlert({ target: { kind: "account", accountId: other.id }, alertId: alert.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.explainAlert({ target: { kind: "account", accountId: account.id }, alertId: alert.id }),
    ).resolves.toMatchObject({ nextStep: "review_transaction" });
  });

  it("fails the whole portfolio read if any selected account is unauthorized", async () => {
    const readable = makeAccount();
    const blocked = makeAccount({
      id: "blocked",
      authorization: { state: "revoked", checkedAt: NOW, reason: "provider_revoked" },
    });
    const service = new FinanceQueryService(
      new InMemoryFinancialStore(
        makeSnapshot({ accounts: [readable, blocked], portfolios: [makePortfolio([readable, blocked])], transactions: [] }),
      ),
    );

    await expect(service.getPortfolioReport({ portfolioId: "portfolio-1" })).rejects.toBeInstanceOf(
      AuthorizationRequiredError,
    );
  });
});
