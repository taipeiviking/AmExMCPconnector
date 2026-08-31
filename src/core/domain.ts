import type { IsoCountryCode } from "./country-codes";

export type CountryCode = "US" | "JP";
export type CurrencyCode = "USD" | "JPY";
export type AccountClass = "personal" | "company";
export type CollectionMethod = "provider" | "statement_import";

export type AccountId = string;
export type LegalEntityId = string;
export type PortfolioId = string;
export type TransactionId = string;
export type StatementId = string;
export type FraudAlertId = string;

export type AuthorizationState =
  | "authorized"
  | "import_only"
  | "pending"
  | "reauthorization_required"
  | "revoked"
  | "unavailable";

export interface AuthorizationSnapshot {
  readonly state: AuthorizationState;
  readonly checkedAt: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

/**
 * An account contains identifiers and display metadata, never credentials.
 * Provider access tokens belong only in the encrypted credential store.
 */
export interface AmexAccount {
  readonly id: AccountId;
  readonly displayName: string;
  readonly legalEntityId: LegalEntityId;
  readonly legalEntityName: string;
  readonly country: CountryCode;
  readonly currency: CurrencyCode;
  readonly accountClass: AccountClass;
  readonly businessPurpose: string | null;
  readonly collectionMethod: CollectionMethod;
  readonly authorization: AuthorizationSnapshot;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransactionSource {
  readonly accountId: AccountId;
  readonly legalEntityId: LegalEntityId;
  readonly legalEntityName: string;
  readonly country: CountryCode;
  readonly accountClass: AccountClass;
  readonly accountCurrency: CurrencyCode;
  /** Explicit null means reviewed and intentionally left unassigned. */
  readonly businessPurpose: string | null;
}

export interface FinancialTransaction {
  readonly id: TransactionId;
  readonly externalId?: string;
  readonly source: TransactionSource;
  readonly postedAt: string;
  readonly authorizedAt?: string;
  readonly description: string;
  readonly merchantName?: string;
  readonly merchantCountry?: IsoCountryCode;
  /** Signed decimal string: charges are negative and credits/payments are positive. */
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly categoryId: string | null;
  readonly memo: string | null;
  readonly statementId?: StatementId;
  readonly importFingerprint: string;
  readonly importedAt: string;
}

export interface Money {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export interface Statement {
  readonly id: StatementId;
  readonly accountId: AccountId;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly transactionIds: readonly TransactionId[];
  readonly importedAt: string;
  readonly sourceFileFingerprint: string;
}

/** Portfolios are local, owner-controlled selections. They have no sync identity. */
export interface Portfolio {
  readonly id: PortfolioId;
  readonly name: string;
  readonly accountIds: readonly AccountId[];
  readonly ownerControlled: true;
  readonly storageScope: "this_device_only";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type FraudAlertStatus =
  | "open"
  | "reviewed"
  | "dismissed"
  | "confirmed_suspicious";

export type FraudAlertKind =
  | "large_amount"
  | "possible_duplicate"
  | "unusual_country"
  | "custom_rule";

export interface FraudAlert {
  readonly id: FraudAlertId;
  readonly accountId: AccountId;
  readonly transactionIds: readonly TransactionId[];
  readonly kind: FraudAlertKind;
  readonly severity: "low" | "medium" | "high";
  readonly status: FraudAlertStatus;
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  /** Alerts can only request human review; they never control the card or file a dispute. */
  readonly reviewOnly: true;
  readonly detectedAt: string;
  readonly reviewedAt?: string;
}

export type AccountTarget = { readonly kind: "account"; readonly accountId: AccountId };
export type PortfolioTarget = { readonly kind: "portfolio"; readonly portfolioId: PortfolioId };
export type DataTarget = AccountTarget | PortfolioTarget;

export interface AccountStatusResult {
  readonly accountId: AccountId;
  readonly authorization: AuthorizationSnapshot;
  readonly availableForQueries: boolean;
  readonly recommendedAction: "none" | "reauthorize" | "wait" | "check_provider";
}

export interface TransactionPage {
  readonly transactions: readonly FinancialTransaction[];
  readonly nextCursor: string | null;
}

export interface CurrencyTotal {
  readonly currency: CurrencyCode;
  readonly inflows: string;
  readonly outflows: string;
  readonly net: string;
  readonly transactionCount: number;
}

export interface PortfolioReport {
  readonly portfolioId: PortfolioId;
  readonly portfolioName: string;
  readonly accountIds: readonly AccountId[];
  readonly periodStart?: string;
  readonly periodEnd?: string;
  /** Totals stay separated by currency unless an explicit FX valuation is supplied elsewhere. */
  readonly totals: readonly CurrencyTotal[];
  readonly generatedAt: string;
}

export interface AlertExplanation {
  readonly alertId: FraudAlertId;
  readonly title: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly limitations: readonly string[];
  readonly nextStep: "review_transaction";
}

export interface CoreSnapshot {
  readonly accounts: readonly AmexAccount[];
  readonly portfolios: readonly Portfolio[];
  readonly transactions: readonly FinancialTransaction[];
  readonly statements: readonly Statement[];
  readonly fraudAlerts: readonly FraudAlert[];
}
