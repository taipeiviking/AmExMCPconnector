import type { CoreSnapshot, FraudAlert } from "../core";

export interface PortfolioConfigurationInput {
  readonly name: string;
  readonly accountIds: readonly string[];
}

export type OwnerAlertDisposition = Extract<
  FraudAlert["status"],
  "reviewed" | "dismissed" | "confirmed_suspicious"
>;

/** Produces an immutable owner-controlled portfolio update for one atomic store
 * commit. Authorization and account data are deliberately untouched. */
export function configureOwnerPortfolio(
  snapshot: CoreSnapshot,
  portfolioId: string,
  input: PortfolioConfigurationInput,
  updatedAt: string,
): CoreSnapshot {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001F\u007F]/u.test(name)) {
    throw new Error("Portfolio name must contain 1 to 80 printable characters.");
  }
  if (input.accountIds.length > 256 || new Set(input.accountIds).size !== input.accountIds.length) {
    throw new Error("Portfolio account selection is invalid or contains duplicates.");
  }
  const portfolio = snapshot.portfolios.find((candidate) => candidate.id === portfolioId);
  if (portfolio === undefined) throw new Error("The owner portfolio is unavailable.");
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
  for (const accountId of input.accountIds) {
    const account = accounts.get(accountId);
    if (account === undefined) throw new Error("The portfolio selection contains an unknown account.");
    if (!account.active) throw new Error("Disconnected accounts cannot be added to a query portfolio.");
  }

  return {
    ...snapshot,
    portfolios: snapshot.portfolios.map((candidate) =>
      candidate.id === portfolioId
        ? { ...candidate, name, accountIds: [...input.accountIds], updatedAt }
        : candidate,
    ),
  };
}

/** Records an owner's review disposition only. It has no provider, card,
 * dispute, or payment side effect. */
export function setOwnerAlertDisposition(
  snapshot: CoreSnapshot,
  portfolioId: string,
  alertId: string,
  status: OwnerAlertDisposition,
  reviewedAt: string,
): CoreSnapshot {
  const portfolio = snapshot.portfolios.find((candidate) => candidate.id === portfolioId);
  if (portfolio === undefined) throw new Error("The owner portfolio is unavailable.");
  const alert = snapshot.fraudAlerts.find((candidate) => candidate.id === alertId);
  if (alert === undefined || !portfolio.accountIds.includes(alert.accountId)) {
    throw new Error("The review alert is unavailable in this portfolio.");
  }

  return {
    ...snapshot,
    fraudAlerts: snapshot.fraudAlerts.map((candidate) =>
      candidate.id === alertId ? { ...candidate, status, reviewedAt } : candidate,
    ),
  };
}

/** A disconnected account is removed from query portfolios so it cannot make
 * a whole-portfolio read unavailable. The encrypted source history remains. */
export function removeAccountFromQueryPortfolios(
  snapshot: CoreSnapshot,
  accountId: string,
  updatedAt: string,
): CoreSnapshot {
  return {
    ...snapshot,
    portfolios: snapshot.portfolios.map((portfolio) =>
      portfolio.accountIds.includes(accountId)
        ? {
            ...portfolio,
            accountIds: portfolio.accountIds.filter((candidate) => candidate !== accountId),
            updatedAt,
          }
        : portfolio,
    ),
  };
}
