import Decimal from "decimal.js";

import { isIsoCountryCode } from "./country-codes";
import type { AmexAccount, FinancialTransaction, Portfolio, Statement } from "./domain";
import { ValidationError } from "./errors";
import { parseCurrencyAmount } from "./money";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FORBIDDEN_SECRET_KEYS = /(?:password|passcode|secret|access.?token|refresh.?token|credential)/iu;

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly recordId?: string;
}

export function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`, { field });
  }
}

export function assertIsoDate(value: string, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    !ISO_DATE.test(value) ||
    match === null ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ValidationError(`${field} must be an ISO date`, { field, value });
  }
}

export function assertIsoInstant(value: string, field: string): void {
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a UTC ISO timestamp`, { field, value });
  }
}

export function assertDecimal(value: string, field: string): void {
  try {
    const decimal = new Decimal(value);
    if (!decimal.isFinite() || decimal.decimalPlaces() > 8) {
      throw new Error("invalid precision");
    }
  } catch {
    throw new ValidationError(`${field} must be a finite decimal string with at most 8 decimal places`, {
      field,
      value,
    });
  }
}

export function validateAccount(account: AmexAccount): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (account.id.trim().length === 0) issues.push(error("ACCOUNT_ID_EMPTY", "Account id is empty"));
  if (account.displayName.trim().length === 0) issues.push(error("ACCOUNT_NAME_EMPTY", "Account display name is empty"));
  if (account.legalEntityId.trim().length === 0) issues.push(error("ENTITY_ID_EMPTY", "Legal entity id is empty"));
  if (account.collectionMethod === "statement_import" && account.authorization.state !== "import_only") {
    issues.push(error("IMPORT_AUTH_STATE", "Statement-import accounts must use the import_only authorization state", account.id));
  }
  if (account.collectionMethod === "provider" && account.authorization.state === "import_only") {
    issues.push(error("PROVIDER_AUTH_STATE", "Provider accounts cannot use the import_only authorization state", account.id));
  }
  if (account.accountClass === "company" && account.businessPurpose === null) {
    issues.push(warning("BUSINESS_PURPOSE_UNASSIGNED", "Company account has no business purpose assigned", account.id));
  }
  return issues;
}

export function validateTransaction(
  transaction: FinancialTransaction,
  account?: AmexAccount,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (transaction.id.trim().length === 0) issues.push(error("TRANSACTION_ID_EMPTY", "Transaction id is empty"));
  if (transaction.description.trim().length === 0) {
    issues.push(error("DESCRIPTION_EMPTY", "Transaction description is empty", transaction.id));
  }
  try {
    parseCurrencyAmount(transaction.amount, transaction.currency, "amount");
  } catch (caught) {
    issues.push(error("INVALID_AMOUNT", caught instanceof Error ? caught.message : "Invalid amount", transaction.id));
  }
  try {
    assertIsoDate(transaction.postedAt, "postedAt");
  } catch (caught) {
    issues.push(error("INVALID_POSTED_DATE", caught instanceof Error ? caught.message : "Invalid date", transaction.id));
  }
  if (transaction.importFingerprint.trim().length < 16) {
    issues.push(error("WEAK_IMPORT_FINGERPRINT", "Import fingerprint is missing or too short", transaction.id));
  }
  if (transaction.merchantCountry !== undefined && !isIsoCountryCode(transaction.merchantCountry)) {
    issues.push(error("INVALID_MERCHANT_COUNTRY", "Merchant country is not an ISO 3166-1 alpha-2 code", transaction.id));
  }
  if (account !== undefined) {
    const checks: ReadonlyArray<readonly [boolean, string, string]> = [
      [transaction.source.accountId === account.id, "SOURCE_ACCOUNT_MISMATCH", "Source account does not match account"],
      [
        transaction.source.legalEntityId === account.legalEntityId,
        "SOURCE_ENTITY_MISMATCH",
        "Source legal entity does not match account",
      ],
      [transaction.source.country === account.country, "SOURCE_COUNTRY_MISMATCH", "Source country does not match account"],
      [
        transaction.source.accountClass === account.accountClass,
        "SOURCE_CLASS_MISMATCH",
        "Source account class does not match account",
      ],
      [
        transaction.source.accountCurrency === account.currency,
        "SOURCE_CURRENCY_MISMATCH",
        "Source account currency does not match account",
      ],
    ];
    for (const [passes, code, message] of checks) {
      if (!passes) issues.push(error(code, message, transaction.id));
    }
  }
  return issues;
}

export function validateStatement(statement: Statement): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  try {
    assertIsoDate(statement.periodStart, "periodStart");
    assertIsoDate(statement.periodEnd, "periodEnd");
    parseCurrencyAmount(statement.openingBalance.amount, statement.openingBalance.currency, "openingBalance.amount");
    parseCurrencyAmount(statement.closingBalance.amount, statement.closingBalance.currency, "closingBalance.amount");
  } catch (caught) {
    issues.push(error("INVALID_STATEMENT", caught instanceof Error ? caught.message : "Invalid statement", statement.id));
  }
  if (statement.periodStart > statement.periodEnd) {
    issues.push(error("STATEMENT_PERIOD_REVERSED", "Statement period start is after its end", statement.id));
  }
  if (statement.openingBalance.currency !== statement.closingBalance.currency) {
    issues.push(error("STATEMENT_CURRENCY_MISMATCH", "Opening and closing balances use different currencies", statement.id));
  }
  if (new Set(statement.transactionIds).size !== statement.transactionIds.length) {
    issues.push(error("STATEMENT_DUPLICATE_TRANSACTION", "Statement repeats a transaction id", statement.id));
  }
  return issues;
}

export function validatePortfolio(portfolio: Portfolio, accountIds: ReadonlySet<string>): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (portfolio.ownerControlled !== true || portfolio.storageScope !== "this_device_only") {
    issues.push(error("PORTFOLIO_SCOPE", "Portfolio must be owner-controlled and local to this device", portfolio.id));
  }
  // An owner-controlled portfolio may be empty during first-run setup. It becomes
  // queryable immediately and gains accounts only through the local desktop UI.
  if (new Set(portfolio.accountIds).size !== portfolio.accountIds.length) {
    issues.push(error("PORTFOLIO_DUPLICATE_ACCOUNT", "Portfolio repeats an account", portfolio.id));
  }
  for (const accountId of portfolio.accountIds) {
    if (!accountIds.has(accountId)) {
      issues.push(error("PORTFOLIO_ACCOUNT_MISSING", "Portfolio references an unknown account", portfolio.id));
    }
  }
  return issues;
}

export function findForbiddenSecretFields(value: unknown, path = "$", seen = new Set<object>()): readonly string[] {
  if (typeof value !== "object" || value === null) return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_SECRET_KEYS.test(key)) found.push(childPath);
    found.push(...findForbiddenSecretFields(child, childPath, seen));
  }
  return found;
}

export function assertSnapshotContainsNoSecrets(value: unknown): void {
  const forbidden = findForbiddenSecretFields(value);
  if (forbidden.length > 0) {
    throw new ValidationError("Financial domain records must never contain credentials or tokens", { forbidden });
  }
}

function error(code: string, message: string, recordId?: string): ValidationIssue {
  return { severity: "error", code, message, ...(recordId === undefined ? {} : { recordId }) };
}

function warning(code: string, message: string, recordId?: string): ValidationIssue {
  return { severity: "warning", code, message, ...(recordId === undefined ? {} : { recordId }) };
}
