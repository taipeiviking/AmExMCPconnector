import { createHash } from "node:crypto";
import { z } from "zod";
import { isIsoCountryCode, type IsoCountryCode } from "../core/country-codes";
import type { AmexAccount, FinancialTransaction, Statement } from "../core/domain";
import { canonicalCurrencyAmount } from "../core/money";
import { sourceFor, transactionFingerprint } from "../core/imports/common";
import { ProviderIntegrationError } from "./provider-types";

const safeId = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const safeText = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const optionalText = z.string().max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isActualIsoDate);
const isoInstant = z.string().datetime({ offset: false });
const usdAmount = z.string().min(1).max(64).refine((value) => {
  try {
    canonicalCurrencyAmount(value, "USD", "provider amount");
    return true;
  } catch {
    return false;
  }
});
const profile = z.literal("normalized_v1");
const NORMALIZED_V1_READ_ONLY_SCOPE_SET = new Set([
  "accounts",
  "transactions",
  "statements",
]);

/**
 * The normalized_v1 adapter contract has one exact least-privilege scope set.
 * Providers with different OAuth scope names require a separately reviewed
 * adapter; similarly named or write-capable scopes are never guessed.
 */
export function normalizedV1ReadOnlyScopes(scopes: readonly string[]): readonly string[] {
  if (
    scopes.length !== NORMALIZED_V1_READ_ONLY_SCOPE_SET.size ||
    scopes.some((scope) => !NORMALIZED_V1_READ_ONLY_SCOPE_SET.has(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The normalized_v1 provider adapter requires exactly the reviewed accounts, transactions, and statements read-only scopes.",
    );
  }
  return ["accounts", "transactions", "statements"];
}

const providerAccountSchema = z.object({
  id: safeId,
  country: z.literal("US"),
  currency: z.literal("USD"),
  account_class: z.enum(["personal", "company"]),
  status: z.enum(["active", "reauthorization_required", "unavailable"]),
  last_four: z.string().regex(/^\d{4}$/u).optional(),
  authorization_expires_at: isoInstant.optional(),
}).strict();

const providerTransactionSchema = z.object({
  id: safeId,
  posted_at: isoDate,
  authorized_at: isoInstant.optional(),
  description: safeText,
  merchant_name: safeText.optional(),
  merchant_country: z.string().refine(isIsoCountryCode, {
    message: "Merchant country must be an ISO 3166-1 alpha-2 code.",
  }).optional(),
  amount: usdAmount,
  currency: z.literal("USD"),
  category_id: optionalText.nullable().optional(),
  memo: optionalText.nullable().optional(),
  statement_id: safeId.optional(),
}).strict();

const providerStatementSchema = z.object({
  id: safeId,
  period_start: isoDate,
  period_end: isoDate,
  opening_balance: usdAmount,
  closing_balance: usdAmount,
  currency: z.literal("USD"),
  transaction_ids: z.array(safeId).max(10_000),
}).strict().refine((value) => value.period_start <= value.period_end, {
  message: "Statement period is reversed.",
});

const accountsPayloadSchema = z.object({
  profile,
  accounts: z.array(providerAccountSchema).max(100),
}).strict();

const accountStatusPayloadSchema = z.object({
  profile,
  account: providerAccountSchema,
}).strict();

const transactionsPayloadSchema = z.object({
  profile,
  account_id: safeId,
  transactions: z.array(providerTransactionSchema).max(5000),
  next_cursor: z.string().min(1).max(2048).nullable().optional(),
}).strict();

const statementsPayloadSchema = z.object({
  profile,
  account_id: safeId,
  statements: z.array(providerStatementSchema).max(1000),
}).strict();

export type NormalizedV1ProviderAccount = z.infer<typeof providerAccountSchema>;
export type NormalizedV1ProviderTransaction = z.infer<typeof providerTransactionSchema>;
export type NormalizedV1ProviderStatement = z.infer<typeof providerStatementSchema>;

export interface NormalizedV1TransactionPage {
  readonly accountId: string;
  readonly transactions: readonly NormalizedV1ProviderTransaction[];
  readonly nextCursor: string | null;
}

export function parseNormalizedV1Accounts(value: unknown): readonly NormalizedV1ProviderAccount[] {
  const parsed = parse(accountsPayloadSchema, value, "account discovery");
  assertUniqueIds(parsed.accounts, "provider accounts");
  return parsed.accounts;
}

export function parseNormalizedV1AccountStatus(
  value: unknown,
  expectedProviderAccountId: string,
): NormalizedV1ProviderAccount {
  const parsed = parse(accountStatusPayloadSchema, value, "account status");
  if (parsed.account.id !== expectedProviderAccountId) {
    throw invalidResponse("The provider status response did not match the selected account.");
  }
  return parsed.account;
}

export function parseNormalizedV1TransactionPage(
  value: unknown,
  expectedProviderAccountId: string,
): NormalizedV1TransactionPage {
  const parsed = parse(transactionsPayloadSchema, value, "transactions");
  if (parsed.account_id !== expectedProviderAccountId) {
    throw invalidResponse("The provider transaction response did not match the selected account.");
  }
  assertUniqueIds(parsed.transactions, "provider transactions");
  return {
    accountId: parsed.account_id,
    transactions: parsed.transactions,
    nextCursor: parsed.next_cursor ?? null,
  };
}

export function parseNormalizedV1Statements(
  value: unknown,
  expectedProviderAccountId: string,
): readonly NormalizedV1ProviderStatement[] {
  const parsed = parse(statementsPayloadSchema, value, "statements");
  if (parsed.account_id !== expectedProviderAccountId) {
    throw invalidResponse("The provider statement response did not match the selected account.");
  }
  assertUniqueIds(parsed.statements, "provider statements");
  for (const statement of parsed.statements) {
    if (new Set(statement.transaction_ids).size !== statement.transaction_ids.length) {
      throw invalidResponse("A provider statement repeated a transaction identifier.");
    }
  }
  return parsed.statements;
}

export function toLocalProviderTransaction(
  account: AmexAccount,
  providerTransaction: NormalizedV1ProviderTransaction,
  syncedAt: string,
): FinancialTransaction {
  assertUsProviderAccount(account);
  const amount = canonicalCurrencyAmount(providerTransaction.amount, "USD", "provider transaction amount");
  const description = providerTransaction.description.normalize("NFKC").trim();
  const merchantCountry = providerTransaction.merchant_country === undefined
    ? undefined
    : providerMerchantCountry(providerTransaction.merchant_country);
  const id = localProviderTransactionId(account.id, providerTransaction.id);
  const statementId = providerTransaction.statement_id === undefined
    ? undefined
    : localProviderStatementId(account.id, providerTransaction.statement_id);
  return {
    id,
    externalId: providerTransaction.id,
    source: sourceFor(account),
    postedAt: providerTransaction.posted_at,
    ...(providerTransaction.authorized_at === undefined
      ? {}
      : { authorizedAt: providerTransaction.authorized_at }),
    description,
    ...(providerTransaction.merchant_name === undefined
      ? {}
      : { merchantName: providerTransaction.merchant_name.normalize("NFKC").trim() }),
    ...(merchantCountry === undefined ? {} : { merchantCountry }),
    amount,
    currency: "USD",
    categoryId: providerTransaction.category_id?.normalize("NFKC").trim() || null,
    memo: providerTransaction.memo?.normalize("NFKC").trim() || null,
    ...(statementId === undefined ? {} : { statementId }),
    importFingerprint: transactionFingerprint({
      accountId: account.id,
      externalId: providerTransaction.id,
      postedAt: providerTransaction.posted_at,
      amount,
      currency: "USD",
      description,
    }),
    importedAt: syncedAt,
  };
}

export function toLocalProviderStatement(
  account: AmexAccount,
  providerStatement: NormalizedV1ProviderStatement,
  syncedAt: string,
): Statement {
  assertUsProviderAccount(account);
  return {
    id: localProviderStatementId(account.id, providerStatement.id),
    accountId: account.id,
    periodStart: providerStatement.period_start,
    periodEnd: providerStatement.period_end,
    openingBalance: {
      amount: canonicalCurrencyAmount(providerStatement.opening_balance, "USD", "provider opening balance"),
      currency: "USD",
    },
    closingBalance: {
      amount: canonicalCurrencyAmount(providerStatement.closing_balance, "USD", "provider closing balance"),
      currency: "USD",
    },
    transactionIds: providerStatement.transaction_ids
      .map((id) => localProviderTransactionId(account.id, id))
      .sort(),
    importedAt: syncedAt,
    sourceFileFingerprint: createHash("sha256")
      .update("normalized_v1\0", "utf8")
      .update(account.id, "utf8")
      .update("\0", "utf8")
      .update(providerStatement.id, "utf8")
      .digest("hex"),
  };
}

export function localProviderTransactionId(localAccountId: string, providerTransactionId: string): string {
  return `txn_provider_${stableId(localAccountId, providerTransactionId)}`;
}

export function localProviderStatementId(localAccountId: string, providerStatementId: string): string {
  return `stmt_provider_${stableId(localAccountId, providerStatementId)}`;
}

function stableId(localAccountId: string, providerId: string): string {
  return createHash("sha256")
    .update(localAccountId, "utf8")
    .update("\0", "utf8")
    .update(providerId, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function assertUsProviderAccount(account: AmexAccount): void {
  if (account.country !== "US" || account.currency !== "USD" || account.collectionMethod !== "provider") {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "Provider data can be mapped only to a selected U.S. consent account.",
    );
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, resource: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalidResponse(`The provider returned an invalid normalized_v1 ${resource} payload.`);
  }
  return parsed.data;
}

function assertUniqueIds(values: readonly { readonly id: string }[], label: string): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    throw invalidResponse(`The ${label} payload contained duplicate identifiers.`);
  }
}

function invalidResponse(message: string): ProviderIntegrationError {
  return new ProviderIntegrationError("INVALID_PROVIDER_RESPONSE", message);
}

function providerMerchantCountry(value: string): IsoCountryCode {
  if (!isIsoCountryCode(value)) {
    throw invalidResponse("The provider transaction contained an invalid merchant country.");
  }
  return value;
}

function isActualIsoDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
