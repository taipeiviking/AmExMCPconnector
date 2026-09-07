import { createHash } from "node:crypto";
import type { NormalizedV1ProviderAccount } from "./normalized-v1-provider-response";
import { PlaidApiClient } from "./plaid-api-client";
import { PLAID_PROVIDER_ID } from "./plaid-hosted-link-provider";
import {
  plaidInstitutionPolicyForEnvironment,
  type PlaidInstitutionPolicy,
} from "./plaid-institution-policy";
import {
  assertPlaidAllowedInstitution,
  parsePlaidAccounts,
  parsePlaidItem,
  parsePlaidTransactionsGet,
  requireSinglePlaidPersonalCard,
  toNormalizedPlaidAccount,
} from "./plaid-response-mapping";
import {
  ProviderIntegrationError,
  type ProviderAccountSelection,
  type ProviderReadResult,
  type ReadOnlyFinancialProvider,
} from "./provider-types";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const CURSOR_PATTERN = /^plaid-get-v1:([a-f0-9]{64}):(\d{1,7}):(\d{1,7})$/u;

export interface PlaidAccessTokenSource {
  /** Returns caller-owned bytes for exactly one local account. */
  getAccessToken(localAccountId: string): Promise<Uint8Array>;
}

export interface PlaidReadOnlyFinancialConfiguration {
  readonly maximumPageSize?: number;
  readonly defaultLookbackDays?: number;
  readonly now?: () => Date;
}

/**
 * Read-only Plaid Transactions adapter. Plaid read endpoints use HTTP POST,
 * but this class has no mutation methods and the underlying transport has a
 * fixed endpoint allowlist with no payment, transfer, or card-control APIs.
 */
export class PlaidReadOnlyFinancialProvider implements ReadOnlyFinancialProvider {
  public readonly institutionPolicy: PlaidInstitutionPolicy;
  private readonly configuration: ValidatedConfiguration;
  private acceptingRequests = true;

  public constructor(
    configuration: PlaidReadOnlyFinancialConfiguration,
    private readonly api: PlaidApiClient,
    private readonly tokens: PlaidAccessTokenSource,
  ) {
    this.configuration = validateConfiguration(configuration);
    this.institutionPolicy = plaidInstitutionPolicyForEnvironment(api.environment);
  }

  public abortPending(): void {
    this.acceptingRequests = false;
    this.api.abortPending();
  }

  public async listAccounts(localAccountId: string): Promise<ProviderReadResult> {
    this.assertAvailable();
    validateId(localAccountId, "local account ID");
    return await this.withAccessToken(localAccountId, async (accessToken) => {
      const item = await this.getHealthyItem(accessToken);
      const accountResult = await this.api.post("/accounts/get", { access_token: accessToken });
      const account = requireSinglePlaidPersonalCard(parsePlaidAccounts(accountResult.data));
      return {
        data: {
          profile: "normalized_v1",
          accounts: [toNormalizedPlaidAccount(account, "active", item.consentExpiresAt)],
        },
        ...(accountResult.providerRequestId === undefined
          ? {}
          : { providerRequestId: accountResult.providerRequestId }),
      };
    });
  }

  public async getAccountStatus(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    this.assertAvailable();
    validateSelection(selection);
    return await this.withAccessToken(selection.localAccountId, async (accessToken) => {
      const item = await this.getItem(accessToken);
      await this.validateInstitution(item.institutionId);
      let status: NormalizedV1ProviderAccount["status"] = "active";
      if (item.errorCode !== undefined) {
        status = isAuthorizationError(item.errorCode, item.errorType)
          ? "reauthorization_required"
          : "unavailable";
      }
      const accountResult = await this.api.post("/accounts/get", { access_token: accessToken });
      const account = requireSinglePlaidPersonalCard(
        parsePlaidAccounts(accountResult.data),
        selection.providerAccountId,
      );
      return {
        data: {
          profile: "normalized_v1",
          account: toNormalizedPlaidAccount(account, status, item.consentExpiresAt),
        },
        ...(accountResult.providerRequestId === undefined
          ? {}
          : { providerRequestId: accountResult.providerRequestId }),
      };
    });
  }

  public async listTransactions(
    selection: ProviderAccountSelection,
    filter: {
      readonly from?: string;
      readonly to?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
    } = {},
  ): Promise<ProviderReadResult> {
    this.assertAvailable();
    validateSelection(selection);
    const to = filter.to ?? utcDate(this.configuration.now());
    const from = filter.from ?? utcDate(daysAgo(this.configuration.now(), this.configuration.defaultLookbackDays));
    validateDate(from, "from date");
    validateDate(to, "to date");
    if (from > to) throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid date range is invalid.");
    const pageSize = filter.pageSize ?? this.configuration.maximumPageSize;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.configuration.maximumPageSize) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid page size is invalid.");
    }

    const binding = cursorBinding(selection, from, to);
    const cursor = filter.cursor === undefined ? { offset: 0, expectedTotal: undefined } : parseCursor(filter.cursor, binding);
    return await this.withAccessToken(selection.localAccountId, async (accessToken) => {
      await this.getHealthyItem(accessToken);
      const accountsResult = await this.api.post("/accounts/get", { access_token: accessToken });
      requireSinglePlaidPersonalCard(parsePlaidAccounts(accountsResult.data), selection.providerAccountId);
      const result = await this.api.post("/transactions/get", {
        access_token: accessToken,
        start_date: from,
        end_date: to,
        options: {
          account_ids: [selection.providerAccountId],
          count: pageSize,
          offset: cursor.offset,
          include_original_description: true,
          personal_finance_category_version: "v2",
        },
      });
      const page = parsePlaidTransactionsGet(result.data, selection.providerAccountId, from, to);
      if (cursor.expectedTotal !== undefined && page.totalTransactions !== cursor.expectedTotal) {
        throw new ProviderIntegrationError(
          "PROVIDER_UNAVAILABLE",
          "Plaid's transaction list changed during pagination; restart this account sync.",
        );
      }
      const nextOffset = cursor.offset + page.rawTransactionCount;
      if (nextOffset > page.totalTransactions) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "Plaid returned inconsistent transaction pagination metadata.",
        );
      }
      if (nextOffset < page.totalTransactions && page.rawTransactionCount === 0) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "Plaid returned an empty transaction page before the end of the result.",
        );
      }
      const nextCursor = nextOffset < page.totalTransactions
        ? formatCursor(binding, nextOffset, page.totalTransactions)
        : null;
      return {
        data: {
          profile: "normalized_v1",
          account_id: selection.providerAccountId,
          transactions: page.transactions,
          next_cursor: nextCursor,
        },
        ...(result.providerRequestId === undefined ? {} : { providerRequestId: result.providerRequestId }),
      };
    });
  }

  /** Plaid Transactions does not provide issuer statement documents or statement cycles. */
  public async listStatements(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    this.assertAvailable();
    validateSelection(selection);
    return await this.withAccessToken(selection.localAccountId, async (accessToken) => {
      await this.getHealthyItem(accessToken);
      const accountsResult = await this.api.post("/accounts/get", { access_token: accessToken });
      requireSinglePlaidPersonalCard(parsePlaidAccounts(accountsResult.data), selection.providerAccountId);
      return {
        data: {
          profile: "normalized_v1",
          account_id: selection.providerAccountId,
          statements: [],
        },
        ...(accountsResult.providerRequestId === undefined
          ? {}
          : { providerRequestId: accountsResult.providerRequestId }),
      };
    });
  }

  public async getStatement(
    selection: ProviderAccountSelection,
    providerStatementId: string,
  ): Promise<ProviderReadResult> {
    this.assertAvailable();
    validateSelection(selection);
    validateId(providerStatementId, "provider statement ID");
    throw new ProviderIntegrationError(
      "PROVIDER_REJECTED",
      "Plaid Transactions does not provide American Express statement documents.",
    );
  }

  private async getHealthyItem(accessToken: string) {
    const item = await this.getItem(accessToken);
    if (item.errorCode !== undefined) {
      if (isAuthorizationError(item.errorCode, item.errorType)) {
        throw new ProviderIntegrationError(
          "AUTHORIZATION_REQUIRED",
          "Plaid requires this account to be connected again.",
        );
      }
      throw new ProviderIntegrationError("PROVIDER_UNAVAILABLE", "The Plaid Item is temporarily unavailable.");
    }
    await this.validateInstitution(item.institutionId);
    return item;
  }

  private async getItem(accessToken: string) {
    const result = await this.api.post("/item/get", { access_token: accessToken });
    return parsePlaidItem(result.data);
  }

  private async validateInstitution(institutionId: string): Promise<void> {
    const result = await this.api.post("/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
    });
    assertPlaidAllowedInstitution(
      result.data,
      institutionId,
      this.institutionPolicy.allowedExactNames,
    );
  }

  private async withAccessToken<T>(
    localAccountId: string,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.tokens.getAccessToken(localAccountId);
    try {
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true }).decode(token);
      } catch (error) {
        throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored Plaid authorization is invalid.", error);
      }
      if (value.length < 1 || value.length > 8192 || /[\u0000\r\n]/u.test(value)) {
        throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored Plaid authorization is invalid.");
      }
      return await operation(value);
    } finally {
      token.fill(0);
    }
  }

  private assertAvailable(): void {
    if (!this.acceptingRequests) {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The Plaid provider runtime is closing and cannot accept another read.",
      );
    }
  }
}

interface ValidatedConfiguration {
  readonly maximumPageSize: number;
  readonly defaultLookbackDays: number;
  readonly now: () => Date;
}

function validateConfiguration(configuration: PlaidReadOnlyFinancialConfiguration): ValidatedConfiguration {
  const maximumPageSize = configuration.maximumPageSize ?? 200;
  const defaultLookbackDays = configuration.defaultLookbackDays ?? 730;
  if (!Number.isSafeInteger(maximumPageSize) || maximumPageSize < 1 || maximumPageSize > 500) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid page-size limit is invalid.");
  }
  if (!Number.isSafeInteger(defaultLookbackDays) || defaultLookbackDays < 1 || defaultLookbackDays > 730) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid lookback is invalid.");
  }
  return {
    maximumPageSize,
    defaultLookbackDays,
    now: configuration.now ?? (() => new Date()),
  };
}

function cursorBinding(selection: ProviderAccountSelection, from: string, to: string): string {
  return createHash("sha256")
    .update(PLAID_PROVIDER_ID, "utf8")
    .update("\0", "utf8")
    .update(selection.localAccountId, "utf8")
    .update("\0", "utf8")
    .update(selection.providerAccountId, "utf8")
    .update("\0", "utf8")
    .update(from, "utf8")
    .update("\0", "utf8")
    .update(to, "utf8")
    .digest("hex");
}

function formatCursor(binding: string, offset: number, total: number): string {
  return `plaid-get-v1:${binding}:${offset}:${total}`;
}

function parseCursor(cursor: string, expectedBinding: string): { readonly offset: number; readonly expectedTotal: number } {
  const match = CURSOR_PATTERN.exec(cursor);
  if (match === null || match[1] !== expectedBinding) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The Plaid cursor does not belong to the selected account and date range.",
    );
  }
  const offset = Number(match[2]);
  const expectedTotal = Number(match[3]);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(expectedTotal) || offset < 1 || offset >= expectedTotal) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid cursor is invalid.");
  }
  return { offset, expectedTotal };
}

function validateSelection(selection: ProviderAccountSelection): void {
  validateId(selection.localAccountId, "local account ID");
  validateId(selection.providerAccountId, "provider account ID");
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`);
  }
}

function validateDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The Plaid ${label} is invalid.`);
  }
}

function isAuthorizationError(errorCode: string, errorType?: string): boolean {
  return errorCode === "ITEM_LOGIN_REQUIRED" ||
    errorCode === "INVALID_ACCESS_TOKEN" ||
    errorCode === "ITEM_NOT_FOUND" ||
    errorType === "OAUTH_ERROR";
}

function daysAgo(now: Date, days: number): Date {
  const value = new Date(now.getTime());
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - days);
  return value;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
