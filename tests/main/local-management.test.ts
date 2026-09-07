import { describe, expect, it } from "vitest";

import type { AmexAccount, CoreSnapshot, FraudAlert, Portfolio } from "../../src/core";
import {
  configureOwnerPortfolio,
  removeAccountFromQueryPortfolios,
  setOwnerAlertDisposition,
} from "../../src/main/local-management";

const NOW = "2026-09-07T00:00:00.000Z";

describe("local portfolio and alert management", () => {
  it("updates only selected active portfolio membership and its display name", () => {
    const first = account("first", true);
    const second = account("second", true);
    const snapshot = makeSnapshot([first, second]);
    const updated = configureOwnerPortfolio(snapshot, "owner-main", {
      name: "Travel review",
      accountIds: [second.id],
    }, NOW);
    expect(updated.portfolios[0]).toMatchObject({ name: "Travel review", accountIds: ["second"], updatedAt: NOW });
    expect(updated.accounts).toEqual(snapshot.accounts);
  });

  it("rejects duplicate, unknown, and disconnected membership", () => {
    const active = account("active", true);
    const inactive = account("inactive", false);
    const snapshot = makeSnapshot([active, inactive]);
    expect(() => configureOwnerPortfolio(snapshot, "owner-main", { name: "Owner", accountIds: ["active", "active"] }, NOW)).toThrow(/duplicates/u);
    expect(() => configureOwnerPortfolio(snapshot, "owner-main", { name: "Owner", accountIds: ["missing"] }, NOW)).toThrow(/unknown/u);
    expect(() => configureOwnerPortfolio(snapshot, "owner-main", { name: "Owner", accountIds: ["inactive"] }, NOW)).toThrow(/Disconnected/u);
  });

  it("records a review-only alert disposition without changing its evidence", () => {
    const selected = account("selected", true);
    const alert = fraudAlert(selected.id);
    const snapshot = { ...makeSnapshot([selected]), fraudAlerts: [alert] };
    const updated = setOwnerAlertDisposition(snapshot, "owner-main", alert.id, "reviewed", NOW);
    expect(updated.fraudAlerts[0]).toEqual({ ...alert, status: "reviewed", reviewedAt: NOW });
    expect(updated.transactions).toEqual(snapshot.transactions);
  });

  it("removes a disconnected account from every portfolio but preserves account data", () => {
    const selected = account("selected", true);
    const snapshot = makeSnapshot([selected]);
    const updated = removeAccountFromQueryPortfolios(snapshot, selected.id, NOW);
    expect(updated.portfolios[0]?.accountIds).toEqual([]);
    expect(updated.accounts).toEqual(snapshot.accounts);
  });
});

function account(id: string, active: boolean): AmexAccount {
  return {
    id,
    displayName: id,
    legalEntityId: `entity-${id}`,
    legalEntityName: "Owner",
    country: "JP",
    currency: "JPY",
    accountClass: "personal",
    businessPurpose: null,
    collectionMethod: "statement_import",
    authorization: { state: "import_only", checkedAt: NOW },
    active,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSnapshot(accounts: readonly AmexAccount[]): CoreSnapshot {
  const portfolio: Portfolio = {
    id: "owner-main",
    name: "Owner portfolio",
    accountIds: accounts.map((account) => account.id),
    ownerControlled: true,
    storageScope: "this_device_only",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { accounts, portfolios: [portfolio], transactions: [], statements: [], fraudAlerts: [] };
}

function fraudAlert(accountId: string): FraudAlert {
  return {
    id: "alert-1",
    accountId,
    transactionIds: ["txn-1"],
    kind: "large_amount",
    severity: "medium",
    status: "open",
    title: "Review amount",
    explanation: "A synthetic threshold was exceeded.",
    evidence: ["Synthetic evidence"],
    reviewOnly: true,
    detectedAt: NOW,
  };
}
