import { describe, expect, it } from "vitest";
import type { AmexAccount } from "../../src/core/domain";
import {
  localProviderStatementId,
  localProviderTransactionId,
  normalizedV1ReadOnlyScopes,
  parseNormalizedV1Statements,
  parseNormalizedV1TransactionPage,
  toLocalProviderStatement,
  toLocalProviderTransaction,
} from "../../src/integrations/normalized-v1-provider-response";

const account: AmexAccount = {
  id: "local-us-personal",
  displayName: "Owner nickname",
  legalEntityId: "owner-entity",
  legalEntityName: "Local Owner",
  country: "US",
  currency: "USD",
  accountClass: "personal",
  businessPurpose: null,
  collectionMethod: "provider",
  authorization: { state: "authorized", checkedAt: "2026-09-07T00:00:00.000Z" },
  active: true,
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

describe("normalized_v1 provider response mapping", () => {
  it("uses one exact reviewed read-only scope profile", () => {
    expect(normalizedV1ReadOnlyScopes(["statements", "accounts", "transactions"]))
      .toEqual(["accounts", "transactions", "statements"]);
    expect(() => normalizedV1ReadOnlyScopes(["accounts", "transactions.rw", "statements"]))
      .toThrow(/requires exactly/iu);
    expect(() => normalizedV1ReadOnlyScopes(["accounts", "transactions", "statements", "profile"]))
      .toThrow(/requires exactly/iu);
  });

  it("validates and maps signed financial data with immutable local source metadata", () => {
    const page = parseNormalizedV1TransactionPage({
      profile: "normalized_v1",
      account_id: "provider-account-1",
      transactions: [{
        id: "provider-transaction-1",
        posted_at: "2026-09-01",
        authorized_at: "2026-08-31T23:58:00.000Z",
        description: "  Example merchant  ",
        merchant_name: "Example merchant",
        merchant_country: "GB",
        amount: "-42.1",
        currency: "USD",
        category_id: "travel",
        memo: null,
        statement_id: "provider-statement-1",
      }],
      next_cursor: null,
    }, "provider-account-1");
    const transaction = toLocalProviderTransaction(
      account,
      page.transactions[0]!,
      "2026-09-07T01:00:00.000Z",
    );

    expect(transaction).toMatchObject({
      id: localProviderTransactionId(account.id, "provider-transaction-1"),
      externalId: "provider-transaction-1",
      postedAt: "2026-09-01",
      authorizedAt: "2026-08-31T23:58:00.000Z",
      description: "Example merchant",
      merchantCountry: "GB",
      amount: "-42.10",
      currency: "USD",
      statementId: localProviderStatementId(account.id, "provider-statement-1"),
      source: {
        accountId: account.id,
        legalEntityId: account.legalEntityId,
        country: "US",
        accountClass: "personal",
        accountCurrency: "USD",
      },
    });

    const statements = parseNormalizedV1Statements({
      profile: "normalized_v1",
      account_id: "provider-account-1",
      statements: [{
        id: "provider-statement-1",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        opening_balance: "100.00",
        closing_balance: "57.90",
        currency: "USD",
        transaction_ids: ["provider-transaction-1"],
      }],
    }, "provider-account-1");
    expect(toLocalProviderStatement(account, statements[0]!, "2026-09-07T01:00:00.000Z"))
      .toMatchObject({
        id: localProviderStatementId(account.id, "provider-statement-1"),
        accountId: account.id,
        transactionIds: [localProviderTransactionId(account.id, "provider-transaction-1")],
      });
  });

  it("rejects non-ISO merchant countries, date-only authorization times, and undeclared fields", () => {
    const transaction = {
      id: "provider-transaction-1",
      posted_at: "2026-09-01",
      description: "Example merchant",
      amount: "-42.10",
      currency: "USD",
    };
    const payload = (candidate: Record<string, unknown>) => ({
      profile: "normalized_v1",
      account_id: "provider-account-1",
      transactions: [candidate],
      next_cursor: null,
    });

    expect(() => parseNormalizedV1TransactionPage(
      payload({ ...transaction, merchant_country: "ZZ" }),
      "provider-account-1",
    )).toThrow(/invalid normalized_v1/iu);
    expect(() => parseNormalizedV1TransactionPage(
      payload({ ...transaction, authorized_at: "2026-09-01" }),
      "provider-account-1",
    )).toThrow(/invalid normalized_v1/iu);
    expect(() => parseNormalizedV1TransactionPage(
      payload({ ...transaction, card_number: "never accepted" }),
      "provider-account-1",
    )).toThrow(/invalid normalized_v1/iu);
  });
});
