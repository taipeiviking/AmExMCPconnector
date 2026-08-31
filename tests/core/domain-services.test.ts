import { describe, expect, it } from "vitest";

import {
  assertSnapshotContainsNoSecrets,
  buildPortfolioReport,
  detectReviewOnlyAlerts,
  mapTransactionCategory,
  reconcileStatement,
  validatePortfolio,
  validateTransaction,
  ValidationError,
} from "../../src/core";
import { makeAccount, makePortfolio, makeStatement, makeTransaction, NOW } from "./fixtures";

describe("financial domain services", () => {
  it("keeps portfolio totals separate by currency", () => {
    const us = makeAccount();
    const jp = makeAccount({
      id: "jp",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const portfolio = makePortfolio([us, jp]);
    const report = buildPortfolioReport({
      portfolio,
      accounts: [us, jp],
      transactions: [
        makeTransaction(us, { id: "us-charge", amount: "-12.50" }),
        makeTransaction(us, { id: "us-credit", amount: "2.50" }),
        makeTransaction(jp, { id: "jp-charge", amount: "-1000" }),
      ],
      generatedAt: NOW,
    });

    expect(report.totals).toEqual([
      { currency: "JPY", inflows: "0", outflows: "1000", net: "-1000", transactionCount: 1 },
      { currency: "USD", inflows: "2.50", outflows: "12.50", net: "-10.00", transactionCount: 2 },
    ]);
  });

  it("rejects portfolio amounts that exceed currency minor units instead of rounding", () => {
    const jp = makeAccount({
      id: "jp",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    expect(() =>
      buildPortfolioReport({
        portfolio: makePortfolio([jp]),
        accounts: [jp],
        transactions: [makeTransaction(jp, { amount: "-1000.5" })],
        generatedAt: NOW,
      }),
    ).toThrowError(/minor-unit precision/iu);
  });

  it("reconciles opening balance plus signed activity", () => {
    const account = makeAccount();
    const transaction = makeTransaction(account, { amount: "-10.00" });
    const statement = makeStatement(account, transaction);

    expect(reconcileStatement(statement, [transaction])).toMatchObject({
      status: "reconciled",
      expectedClosingBalance: "90.00",
      difference: "0.00",
    });
    expect(
      reconcileStatement({ ...statement, closingBalance: { amount: "91.00", currency: "USD" } }, [transaction]),
    ).toMatchObject({ status: "mismatch", difference: "1.00" });
  });

  it("applies the highest-priority matching category rule", () => {
    const transaction = makeTransaction(makeAccount(), { merchantName: "Example Cloud", description: "Example Cloud monthly" });
    const result = mapTransactionCategory(transaction, [
      { id: "generic", priority: 1, match: { kind: "description_contains", value: "cloud" }, categoryId: "software" },
      {
        id: "specific",
        priority: 10,
        match: { kind: "merchant_equals", value: "example cloud" },
        categoryId: "hosting",
        businessPurpose: "Infrastructure",
      },
    ]);
    expect(result).toEqual({
      transactionId: transaction.id,
      categoryId: "hosting",
      businessPurpose: "Infrastructure",
      matchedRuleId: "specific",
    });
  });

  it("detects anomalies as review-only and does not label them as proven fraud", () => {
    const account = makeAccount();
    const transactions = [
      makeTransaction(account, { id: "first", amount: "-500.00", merchantCountry: "GB" }),
      makeTransaction(account, { id: "second", amount: "-500.00", merchantCountry: "GB" }),
    ];
    const alerts = detectReviewOnlyAlerts(transactions, {
      largeAmountThresholds: { USD: "250" },
      detectedAt: NOW,
    });

    expect(alerts.some((alert) => alert.kind === "possible_duplicate")).toBe(true);
    expect(alerts.some((alert) => alert.kind === "unusual_country")).toBe(true);
    expect(alerts.some((alert) => alert.evidence.includes("merchant-country:GB"))).toBe(true);
    expect(alerts.every((alert) => alert.reviewOnly)).toBe(true);
    expect(alerts.every((alert) => !alert.explanation.toLocaleLowerCase().includes("confirmed fraud"))).toBe(true);
  });

  it("validates source metadata and device-local portfolio invariants", () => {
    const account = makeAccount();
    const mismatched = makeTransaction(account, {
      source: { ...makeTransaction(account).source, legalEntityId: "wrong-entity" },
    });
    expect(validateTransaction(mismatched, account).map((issue) => issue.code)).toContain("SOURCE_ENTITY_MISMATCH");

    const invalidPortfolio = { ...makePortfolio([account]), ownerControlled: false as true };
    expect(validatePortfolio(invalidPortfolio, new Set([account.id])).map((issue) => issue.code)).toContain("PORTFOLIO_SCOPE");

    const firstRunPortfolio = { ...makePortfolio([account]), accountIds: [] };
    expect(validatePortfolio(firstRunPortfolio, new Set())).toEqual([]);
  });

  it("rejects credential-shaped fields from financial records", () => {
    expect(() => assertSnapshotContainsNoSecrets({ account: { id: "a", refreshToken: "do-not-store-here" } })).toThrow(
      ValidationError,
    );
  });
});
