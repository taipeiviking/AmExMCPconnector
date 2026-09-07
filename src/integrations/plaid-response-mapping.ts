import { z } from "zod";
import { isIsoCountryCode } from "../core/country-codes";
import type {
  NormalizedV1ProviderAccount,
  NormalizedV1ProviderTransaction,
} from "./normalized-v1-provider-response";
import { ProviderIntegrationError } from "./provider-types";

const safeId = z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const safeText = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const optionalSafeText = z.string().max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(isActualIsoDate);
const isoInstant = z.string().min(1).max(128).refine((value) => Number.isFinite(Date.parse(value)));

const plaidLinkAccountSchema = z.object({
  id: safeId,
  mask: z.string().max(16).nullable().optional(),
  name: safeText,
  type: z.string().min(1).max(64),
  subtype: z.string().min(1).max(128).nullable(),
}).passthrough();

const plaidAccountSchema = z.object({
  account_id: safeId,
  balances: z.object({
    iso_currency_code: z.string().max(16).nullable(),
    unofficial_currency_code: z.string().max(64).nullable(),
  }).passthrough(),
  mask: z.string().max(16).nullable(),
  name: safeText,
  official_name: safeText.nullable().optional(),
  type: z.string().min(1).max(64),
  subtype: z.string().min(1).max(128).nullable(),
}).passthrough();

const plaidTransactionSchema = z.object({
  account_id: safeId,
  transaction_id: safeId,
  amount: z.number().finite(),
  iso_currency_code: z.string().max(16).nullable(),
  unofficial_currency_code: z.string().max(64).nullable(),
  date: isoDate,
  authorized_datetime: isoInstant.nullable().optional(),
  name: safeText,
  merchant_name: safeText.nullable().optional(),
  original_description: optionalSafeText.nullable().optional(),
  pending: z.boolean(),
  personal_finance_category: z.object({
    primary: optionalSafeText,
    detailed: optionalSafeText,
  }).passthrough().nullable().optional(),
  location: z.object({
    country: z.string().max(16).nullable().optional(),
  }).passthrough().nullable().optional(),
}).passthrough();

const accountsResponseSchema = z.object({
  accounts: z.array(plaidAccountSchema).max(100),
  request_id: z.string().max(256).optional(),
}).passthrough();

const transactionsResponseSchema = z.object({
  accounts: z.array(plaidAccountSchema).max(100),
  transactions: z.array(plaidTransactionSchema).max(500),
  total_transactions: z.number().int().min(0).max(1_000_000),
  request_id: z.string().max(256).optional(),
}).passthrough();

const itemResponseSchema = z.object({
  item: z.object({
    item_id: safeId,
    institution_id: safeId.nullable(),
    consent_expiration_time: isoInstant.nullable().optional(),
    error: z.object({
      error_code: z.string().min(1).max(256),
      error_type: z.string().min(1).max(256),
    }).passthrough().nullable(),
  }).passthrough(),
  request_id: z.string().max(256).optional(),
}).passthrough();

const institutionResponseSchema = z.object({
  institution: z.object({
    institution_id: safeId,
    name: safeText,
    country_codes: z.array(z.string().min(2).max(2)).max(100),
    products: z.array(z.string().min(1).max(128)).max(100),
  }).passthrough(),
  request_id: z.string().max(256).optional(),
}).passthrough();

const hostedLinkCreateResponseSchema = z.object({
  link_token: z.string().min(1).max(8192),
  hosted_link_url: z.string().url().max(8192),
  expiration: isoInstant,
  request_id: z.string().max(256).optional(),
}).passthrough();

const publicTokenExchangeResponseSchema = z.object({
  access_token: z.string().min(1).max(8192),
  item_id: safeId,
  request_id: z.string().max(256).optional(),
}).passthrough();

const itemAddResultSchema = z.object({
  public_token: z.string().min(1).max(8192),
  accounts: z.array(plaidLinkAccountSchema).max(100),
}).passthrough();

const linkTokenGetResponseSchema = z.object({
  link_sessions: z.array(z.object({
    finished_at: isoInstant.nullable().optional(),
    results: z.object({
      item_add_results: z.array(itemAddResultSchema).max(10),
    }).passthrough().nullable().optional(),
    on_success: z.object({
      public_token: z.string().min(1).max(8192).nullable().optional(),
      metadata: z.object({
        accounts: z.array(plaidLinkAccountSchema).max(100),
      }).passthrough().nullable().optional(),
    }).passthrough().nullable().optional(),
    exit: z.unknown().nullable().optional(),
    on_exit: z.unknown().nullable().optional(),
  }).passthrough()).max(20),
  request_id: z.string().max(256).optional(),
}).passthrough();

export type PlaidAccount = z.infer<typeof plaidAccountSchema>;

export interface PlaidItemStatus {
  readonly itemId: string;
  readonly institutionId: string;
  readonly consentExpiresAt?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
}

export interface PlaidHostedLinkSuccess {
  readonly publicToken: string;
  readonly accountId: string;
}

export type PlaidHostedLinkState =
  | { readonly state: "pending" }
  | { readonly state: "cancelled" }
  | { readonly state: "succeeded"; readonly result: PlaidHostedLinkSuccess };

export type PlaidHostedLinkUpdateState =
  | { readonly state: "pending" }
  | { readonly state: "cancelled" }
  | { readonly state: "succeeded" };

export interface PlaidTransactionsPage {
  readonly transactions: readonly NormalizedV1ProviderTransaction[];
  readonly rawTransactionCount: number;
  readonly totalTransactions: number;
}

export function parsePlaidHostedLinkCreate(value: unknown): {
  readonly linkToken: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
} {
  const parsed = parse(hostedLinkCreateResponseSchema, value, "Hosted Link creation");
  const authorizationUrl = new URL(parsed.hosted_link_url);
  if (
    authorizationUrl.protocol !== "https:" ||
    authorizationUrl.hostname !== "secure.plaid.com" ||
    !authorizationUrl.pathname.startsWith("/hl/") ||
    authorizationUrl.username.length > 0 ||
    authorizationUrl.password.length > 0
  ) {
    throw invalidResponse("Plaid returned an invalid Hosted Link URL.");
  }
  return {
    linkToken: parsed.link_token,
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: canonicalInstant(parsed.expiration),
  };
}

export function parsePlaidHostedLinkState(value: unknown): PlaidHostedLinkState {
  const parsed = parse(linkTokenGetResponseSchema, value, "Hosted Link status");
  const modernResults = parsed.link_sessions.flatMap((session) => session.results?.item_add_results ?? []);
  const legacyResults = modernResults.length === 0
    ? parsed.link_sessions.flatMap((session) => {
        const success = session.on_success;
        return success === null || success === undefined || typeof success.public_token !== "string"
          ? []
          : [{ public_token: success.public_token, accounts: success.metadata?.accounts ?? [] }];
      })
    : [];
  const results = modernResults.length > 0 ? modernResults : legacyResults;
  if (results.length > 1) {
    throw invalidResponse("Plaid returned more than one Item for an individually authorized account.");
  }
  const result = results[0];
  if (result !== undefined) {
    const accounts = result.accounts.filter(isPersonalCardAccount);
    if (result.accounts.length !== 1 || accounts.length !== 1) {
      throw invalidResponse("Plaid consent must select exactly one personal credit or charge card.");
    }
    return {
      state: "succeeded",
      result: { publicToken: result.public_token, accountId: accounts[0]!.id },
    };
  }
  const finished = parsed.link_sessions.some(
    (session) => session.finished_at !== null && session.finished_at !== undefined,
  );
  return finished ? { state: "cancelled" } : { state: "pending" };
}

/**
 * Update mode repairs the existing Item and never yields a token that should
 * be exchanged. A finished session without an exit callback is the success
 * signal; the unchanged access token must be revalidated separately.
 */
export function parsePlaidHostedLinkUpdateState(value: unknown): PlaidHostedLinkUpdateState {
  const parsed = parse(linkTokenGetResponseSchema, value, "Hosted Link update status");
  const addedItems = parsed.link_sessions.flatMap(
    (session) => session.results?.item_add_results ?? [],
  );
  if (addedItems.length > 0) {
    throw invalidResponse("Plaid update mode unexpectedly returned a newly created Item.");
  }
  const successful = parsed.link_sessions.some(
    (session) =>
      session.finished_at !== null &&
      session.finished_at !== undefined &&
      session.on_exit == null &&
      session.exit == null,
  );
  if (successful) return { state: "succeeded" };
  const active = parsed.link_sessions.some(
    (session) => session.finished_at === null || session.finished_at === undefined,
  );
  if (active || parsed.link_sessions.length === 0) return { state: "pending" };
  return { state: "cancelled" };
}

export function parsePlaidPublicTokenExchange(value: unknown): {
  readonly accessToken: string;
  readonly itemId: string;
} {
  const parsed = parse(publicTokenExchangeResponseSchema, value, "public token exchange");
  return { accessToken: parsed.access_token, itemId: parsed.item_id };
}

export function parsePlaidItem(value: unknown): PlaidItemStatus {
  const parsed = parse(itemResponseSchema, value, "Item status");
  if (parsed.item.institution_id === null) {
    throw invalidResponse("The Plaid Item is not associated with a financial institution.");
  }
  return {
    itemId: parsed.item.item_id,
    institutionId: parsed.item.institution_id,
    ...(parsed.item.consent_expiration_time === null || parsed.item.consent_expiration_time === undefined
      ? {}
      : { consentExpiresAt: canonicalInstant(parsed.item.consent_expiration_time) }),
    ...(parsed.item.error === null
      ? {}
      : {
          errorCode: parsed.item.error.error_code,
          errorType: parsed.item.error.error_type,
        }),
  };
}

export function assertPlaidAllowedInstitution(
  value: unknown,
  expectedInstitutionId: string,
  allowedExactNames: ReadonlySet<string>,
): void {
  const parsed = parse(institutionResponseSchema, value, "institution lookup").institution;
  if (
    parsed.institution_id !== expectedInstitutionId ||
    !allowedExactNames.has(parsed.name) ||
    !parsed.country_codes.includes("US") ||
    !parsed.products.includes("transactions")
  ) {
    throw invalidResponse("The connected institution did not match the allowed U.S. card institution policy.");
  }
}

export function parsePlaidAccounts(value: unknown): readonly PlaidAccount[] {
  const accounts = parse(accountsResponseSchema, value, "account list").accounts;
  if (new Set(accounts.map((account) => account.account_id)).size !== accounts.length) {
    throw invalidResponse("Plaid returned duplicate account identifiers.");
  }
  return accounts;
}

export function requireSinglePlaidPersonalCard(
  accounts: readonly PlaidAccount[],
  expectedAccountId?: string,
): PlaidAccount {
  const eligible = accounts.filter(isPlaidPersonalCardAccount);
  if (accounts.length !== 1 || eligible.length !== 1) {
    throw invalidResponse("The Plaid Item must expose exactly one U.S. personal credit or charge card.");
  }
  const account = eligible[0]!;
  if (expectedAccountId !== undefined && account.account_id !== expectedAccountId) {
    throw invalidResponse("The Plaid account did not match the account selected during consent.");
  }
  return account;
}

export function toNormalizedPlaidAccount(
  account: PlaidAccount,
  status: NormalizedV1ProviderAccount["status"],
  consentExpiresAt?: string,
): NormalizedV1ProviderAccount {
  if (!isPlaidPersonalCardAccount(account)) {
    throw invalidResponse("Plaid returned an unsupported account instead of a U.S. personal card.");
  }
  const lastFour = account.mask !== null && /^\d{4}$/u.test(account.mask)
    ? account.mask
    : undefined;
  return {
    id: account.account_id,
    country: "US",
    currency: "USD",
    account_class: "personal",
    status,
    ...(lastFour === undefined ? {} : { last_four: lastFour }),
    ...(consentExpiresAt === undefined ? {} : { authorization_expires_at: consentExpiresAt }),
  };
}

export function parsePlaidTransactionsGet(
  value: unknown,
  expectedAccountId: string,
  from: string,
  to: string,
): PlaidTransactionsPage {
  const parsed = parse(transactionsResponseSchema, value, "transaction list");
  const account = parsed.accounts.find((candidate) => candidate.account_id === expectedAccountId);
  if (account === undefined || !isPlaidPersonalCardAccount(account)) {
    throw invalidResponse("Plaid did not return the selected U.S. personal card with its transactions.");
  }
  if (new Set(parsed.transactions.map((transaction) => transaction.transaction_id)).size !== parsed.transactions.length) {
    throw invalidResponse("Plaid returned duplicate transaction identifiers.");
  }
  const transactions = parsed.transactions
    .filter((transaction) => !transaction.pending)
    .map((transaction) => toNormalizedTransaction(transaction, expectedAccountId, from, to));
  return {
    transactions,
    rawTransactionCount: parsed.transactions.length,
    totalTransactions: parsed.total_transactions,
  };
}

function toNormalizedTransaction(
  transaction: z.infer<typeof plaidTransactionSchema>,
  expectedAccountId: string,
  from: string,
  to: string,
): NormalizedV1ProviderTransaction {
  if (
    transaction.account_id !== expectedAccountId ||
    transaction.iso_currency_code !== "USD" ||
    transaction.unofficial_currency_code !== null ||
    transaction.date < from ||
    transaction.date > to
  ) {
    throw invalidResponse("Plaid returned a transaction outside the selected account, currency, or date range.");
  }
  const merchantCountry = transaction.location?.country?.toUpperCase();
  if (merchantCountry !== undefined && merchantCountry !== null && !isIsoCountryCode(merchantCountry)) {
    throw invalidResponse("Plaid returned an invalid merchant country.");
  }
  const authorizedAt = transaction.authorized_datetime === null || transaction.authorized_datetime === undefined
    ? undefined
    : canonicalInstant(transaction.authorized_datetime);
  const categoryId = transaction.personal_finance_category?.detailed ||
    transaction.personal_finance_category?.primary || null;
  return {
    id: transaction.transaction_id,
    posted_at: transaction.date,
    ...(authorizedAt === undefined ? {} : { authorized_at: authorizedAt }),
    description: transaction.name,
    ...(transaction.merchant_name === null || transaction.merchant_name === undefined
      ? {}
      : { merchant_name: transaction.merchant_name }),
    ...(merchantCountry === undefined || merchantCountry === null ? {} : { merchant_country: merchantCountry }),
    amount: plaidAmountToSignedLedger(transaction.amount),
    currency: "USD",
    category_id: categoryId,
    memo: transaction.original_description?.trim() || null,
  };
}

function isPersonalCardAccount(account: z.infer<typeof plaidLinkAccountSchema>): boolean {
  return account.type === "credit" && (account.subtype === "credit card" || account.subtype === "charge card");
}

function isPlaidPersonalCardAccount(account: PlaidAccount): boolean {
  return isPersonalCardAccount({
    id: account.account_id,
    mask: account.mask,
    name: account.name,
    type: account.type,
    subtype: account.subtype,
  }) && account.balances.iso_currency_code === "USD" && account.balances.unofficial_currency_code === null;
}

function plaidAmountToSignedLedger(value: number): string {
  const minorUnits = value * 100;
  const rounded = Math.round(minorUnits);
  if (!Number.isSafeInteger(rounded) || Math.abs(minorUnits - rounded) > 1e-6) {
    throw invalidResponse("Plaid returned a USD amount with unsupported precision.");
  }
  const ledgerMinorUnits = -rounded;
  const absolute = Math.abs(ledgerMinorUnits);
  const sign = ledgerMinorUnits < 0 ? "-" : "";
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function canonicalInstant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw invalidResponse("Plaid returned an invalid timestamp.");
  return new Date(milliseconds).toISOString();
}

function parse<T>(schema: z.ZodType<T>, value: unknown, resource: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse(`Plaid returned an invalid ${resource} response.`);
  return parsed.data;
}

function invalidResponse(message: string): ProviderIntegrationError {
  return new ProviderIntegrationError("INVALID_PROVIDER_RESPONSE", message);
}

function isActualIsoDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
