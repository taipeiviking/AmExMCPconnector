import { createHash } from "node:crypto";
import type { NormalizedV1ProviderAccount } from "./normalized-v1-provider-response";
import { PlaidApiClient } from "./plaid-api-client";
import {
  plaidInstitutionPolicyForEnvironment,
  type PlaidInstitutionPolicy,
} from "./plaid-institution-policy";
import {
  assertPlaidAllowedInstitution,
  parsePlaidAccounts,
  parsePlaidHostedLinkCreate,
  parsePlaidHostedLinkState,
  parsePlaidHostedLinkUpdateState,
  parsePlaidItem,
  parsePlaidPublicTokenExchange,
  requireSinglePlaidPersonalCard,
  toNormalizedPlaidAccount,
} from "./plaid-response-mapping";
import {
  ProviderIntegrationError,
  type PreparedProviderRevocation,
  type ProviderAuthorizationStatus,
  type ProviderConsentStart,
  type ProviderDisconnectResult,
  type ProviderTokenSet,
  type ProviderTokenStore,
} from "./provider-types";

export const PLAID_PROVIDER_ID = "plaid";
const NON_EXPIRING_ACCESS_TOKEN_DATE = "9999-12-31T23:59:59.999Z";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

export interface PlaidHostedLinkConfiguration {
  readonly clientName: string;
  readonly linkCustomizationName?: string;
  /** Plaid Dashboard-allowlisted HTTPS redirect used by institution OAuth, when required. */
  readonly redirectUri?: string;
  readonly transactionHistoryDays?: number;
  readonly hostedLinkLifetimeSeconds?: number;
  readonly pollIntervalMs?: number;
  readonly completionTimeoutMs?: number;
}

export interface PlaidHostedConsentCompletion {
  readonly authorization: ProviderAuthorizationStatus;
  readonly account: NormalizedV1ProviderAccount;
  readonly itemId: string;
}

export interface PlaidHostedLinkDependencies {
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface PendingHostedLink {
  readonly linkToken: Uint8Array;
  readonly expiresAtMs: number;
  readonly grant:
    | { readonly kind: "new" }
    | {
        readonly kind: "update";
        readonly itemId: string;
        readonly providerAccountId: string;
      };
}

/**
 * Plaid Hosted Link consent and Item lifecycle. This intentionally does not
 * emulate the generic OAuth callback adapter: Hosted Link is opened in the
 * system browser and completion is obtained from /link/token/get.
 */
export class PlaidHostedLinkProvider {
  public readonly institutionPolicy: PlaidInstitutionPolicy;
  private readonly configuration: ValidatedConfiguration;
  private readonly now: () => Date;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly pending = new Map<string, PendingHostedLink>();
  private readonly completions = new Map<string, AbortController>();
  private acceptingRequests = true;

  public constructor(
    configuration: PlaidHostedLinkConfiguration,
    private readonly api: PlaidApiClient,
    private readonly tokens: ProviderTokenStore,
    dependencies: PlaidHostedLinkDependencies = {},
  ) {
    this.configuration = validateConfiguration(configuration);
    if (api.environment === "production" && this.configuration.redirectUri === undefined) {
      throw new ProviderIntegrationError(
        "INVALID_CONFIGURATION",
        "Plaid production Hosted Link requires a Dashboard-allowlisted HTTPS OAuth redirect URI.",
      );
    }
    this.institutionPolicy = plaidInstitutionPolicyForEnvironment(api.environment);
    this.now = dependencies.now ?? (() => new Date());
    this.wait = dependencies.wait ?? abortableWait;
  }

  public abortPending(): void {
    this.acceptingRequests = false;
    for (const pending of this.pending.values()) pending.linkToken.fill(0);
    this.pending.clear();
    for (const completion of this.completions.values()) completion.abort();
    this.completions.clear();
    this.api.abortPending();
  }

  public async beginConsent(localAccountId: string): Promise<ProviderConsentStart> {
    return await this.beginHostedConsent(localAccountId);
  }

  public async beginHostedConsent(
    localAccountId: string,
    existingProviderAccountId?: string,
  ): Promise<ProviderConsentStart> {
    this.assertAvailable();
    validateId(localAccountId, "local account ID");
    if (this.completions.has(localAccountId)) {
      throw new ProviderIntegrationError("CONSENT_MISMATCH", "Hosted Link completion is already in progress.");
    }
    const previous = this.pending.get(localAccountId);
    previous?.linkToken.fill(0);
    this.pending.delete(localAccountId);

    const commonRequest = {
      client_name: this.configuration.clientName,
      country_codes: ["US"],
      language: "en",
      user: {
        client_user_id: createHash("sha256")
          .update(PLAID_PROVIDER_ID, "utf8")
          .update("\0", "utf8")
          .update(localAccountId, "utf8")
          .digest("hex"),
      },
      hosted_link: { url_lifetime_seconds: this.configuration.hostedLinkLifetimeSeconds },
      ...(this.configuration.linkCustomizationName === undefined
        ? {}
        : { link_customization_name: this.configuration.linkCustomizationName }),
      ...(this.configuration.redirectUri === undefined
        ? {}
        : { redirect_uri: this.configuration.redirectUri }),
    };
    const stored = await this.tokens.get(PLAID_PROVIDER_ID, localAccountId);
    let grant: PendingHostedLink["grant"];
    let response;
    if (stored === undefined) {
      if (existingProviderAccountId !== undefined) {
        throw new ProviderIntegrationError(
          "AUTHORIZATION_REQUIRED",
          "The existing Plaid Item token is unavailable; reconnect cannot safely create a replacement Item.",
        );
      }
      grant = { kind: "new" };
      response = await this.api.post("/link/token/create", {
        ...commonRequest,
        products: ["transactions"],
        transactions: { days_requested: this.configuration.transactionHistoryDays },
        account_filters: {
          credit: { account_subtypes: ["credit card", "charge card"] },
        },
      });
    } else {
      try {
        validateStoredTokenShape(stored);
        if (existingProviderAccountId === undefined) {
          throw new ProviderIntegrationError(
            "INVALID_CONFIGURATION",
            "Plaid reauthorization requires the existing provider account ID.",
          );
        }
        validateId(existingProviderAccountId, "existing provider account ID");
        const itemResult = await this.withSecretText(stored.accessToken, async (accessToken) =>
          await this.api.post("/item/get", { access_token: accessToken }));
        const item = parsePlaidItem(itemResult.data);
        await this.validateInstitution(item.institutionId);
        grant = {
          kind: "update",
          itemId: item.itemId,
          providerAccountId: existingProviderAccountId,
        };
        response = await this.withSecretText(stored.accessToken, async (accessToken) =>
          await this.api.post("/link/token/create", {
            ...commonRequest,
            access_token: accessToken,
          }));
      } finally {
        wipeTokenSet(stored);
      }
    }
    const created = parsePlaidHostedLinkCreate(response.data);
    const token = Buffer.from(created.linkToken, "utf8");
    this.pending.set(localAccountId, {
      linkToken: token,
      expiresAtMs: Date.parse(created.expiresAt),
      grant,
    });
    return {
      providerId: PLAID_PROVIDER_ID,
      localAccountId,
      authorizationUrl: created.authorizationUrl,
      expiresAt: created.expiresAt,
    };
  }

  /** Polls Hosted Link, exchanges one public token, and saves one validated Amex card grant. */
  public async completeHostedConsent(localAccountId: string): Promise<PlaidHostedConsentCompletion> {
    this.assertAvailable();
    validateId(localAccountId, "local account ID");
    const pending = this.pending.get(localAccountId);
    if (pending === undefined) {
      throw new ProviderIntegrationError("CONSENT_MISMATCH", "No matching Plaid Hosted Link session is pending.");
    }
    if (this.completions.has(localAccountId)) {
      throw new ProviderIntegrationError("CONSENT_MISMATCH", "Hosted Link completion is already in progress.");
    }
    const completion = new AbortController();
    this.completions.set(localAccountId, completion);
    const deadline = Math.min(
      pending.expiresAtMs,
      this.now().getTime() + this.configuration.completionTimeoutMs,
    );
    try {
      while (this.now().getTime() < deadline) {
        const status = await this.withSecretText(pending.linkToken, async (linkToken) =>
          await this.api.post("/link/token/get", { link_token: linkToken }));
        if (pending.grant.kind === "new") {
          const link = parsePlaidHostedLinkState(status.data);
          if (link.state === "cancelled") {
            throw new ProviderIntegrationError(
              "CONSENT_CANCELLED",
              "Plaid Hosted Link was closed without connecting an account.",
            );
          }
          if (link.state === "succeeded") {
            return await this.exchangeAndValidate(
              localAccountId,
              link.result.publicToken,
              link.result.accountId,
            );
          }
        } else {
          const link = parsePlaidHostedLinkUpdateState(status.data);
          if (link.state === "cancelled") {
            throw new ProviderIntegrationError(
              "CONSENT_CANCELLED",
              "Plaid Hosted Link was closed without repairing the account.",
            );
          }
          if (link.state === "succeeded") {
            return await this.completeHostedUpdate(localAccountId, pending.grant);
          }
        }
        await this.wait(this.configuration.pollIntervalMs, completion.signal);
      }
      throw new ProviderIntegrationError("CONSENT_EXPIRED", "Plaid Hosted Link did not complete before it expired.");
    } catch (error) {
      if (completion.signal.aborted && !(error instanceof ProviderIntegrationError)) {
        throw new ProviderIntegrationError("CONSENT_CANCELLED", "Plaid Hosted Link completion was cancelled.", error);
      }
      throw error;
    } finally {
      this.completions.delete(localAccountId);
      const current = this.pending.get(localAccountId);
      if (current === pending) this.pending.delete(localAccountId);
      pending.linkToken.fill(0);
    }
  }

  public cancelConsent(localAccountId: string): void {
    validateId(localAccountId, "local account ID");
    this.completions.get(localAccountId)?.abort();
    const pending = this.pending.get(localAccountId);
    this.pending.delete(localAccountId);
    pending?.linkToken.fill(0);
  }

  public async checkAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus> {
    validateId(localAccountId, "local account ID");
    const stored = await this.tokens.get(PLAID_PROVIDER_ID, localAccountId);
    if (stored === undefined) return this.status(localAccountId, "not_authorized", "plaid_item_not_linked");
    try {
      validateStoredTokens(stored, this.now());
      const itemResult = await this.withSecretText(stored.accessToken, async (accessToken) =>
        await this.api.post("/item/get", { access_token: accessToken }));
      const item = parsePlaidItem(itemResult.data);
      if (item.errorCode !== undefined) {
        return isAuthorizationError(item.errorCode, item.errorType)
          ? this.status(localAccountId, "reauthorization_required", "plaid_item_login_required")
          : this.status(localAccountId, "unavailable", "plaid_item_error");
      }
      await this.validateInstitution(item.institutionId);
      const accountsResult = await this.withSecretText(stored.accessToken, async (accessToken) =>
        await this.api.post("/accounts/get", { access_token: accessToken }));
      requireSinglePlaidPersonalCard(parsePlaidAccounts(accountsResult.data));
      return {
        providerId: PLAID_PROVIDER_ID,
        localAccountId,
        state: "authorized",
        checkedAt: this.now().toISOString(),
        ...(item.consentExpiresAt === undefined ? {} : { expiresAt: item.consentExpiresAt }),
      };
    } catch (error) {
      if (error instanceof ProviderIntegrationError && error.code === "AUTHORIZATION_REQUIRED") {
        return this.status(localAccountId, "reauthorization_required", "plaid_item_login_required");
      }
      if (error instanceof ProviderIntegrationError && error.code === "PROVIDER_UNAVAILABLE") {
        return this.status(localAccountId, "unavailable", "plaid_temporarily_unavailable");
      }
      throw error;
    } finally {
      wipeTokenSet(stored);
    }
  }

  /** Plaid Item access tokens do not use refresh tokens; status checking is the refresh operation. */
  public async refreshAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus> {
    return await this.checkAuthorization(localAccountId);
  }

  /** Returns caller-owned bytes for an explicitly selected local account. */
  public async getAccessToken(localAccountId: string): Promise<Uint8Array> {
    validateId(localAccountId, "local account ID");
    const stored = await this.tokens.get(PLAID_PROVIDER_ID, localAccountId);
    if (stored === undefined) {
      throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "This Plaid account has not been connected.");
    }
    try {
      validateStoredTokens(stored, this.now());
      return Uint8Array.from(stored.accessToken);
    } finally {
      wipeTokenSet(stored);
    }
  }

  public async prepareDisconnect(localAccountId: string): Promise<PreparedProviderRevocation> {
    validateId(localAccountId, "local account ID");
    const stored = await this.tokens.get(PLAID_PROVIDER_ID, localAccountId);
    const captured = stored === undefined ? undefined : Uint8Array.from(stored.accessToken);
    if (stored !== undefined) wipeTokenSet(stored);
    let closed = false;
    let attempted = false;
    return {
      revoke: async () => {
        if (closed || attempted || captured === undefined) return "not_configured";
        attempted = true;
        try {
          await this.withSecretText(captured, async (accessToken) =>
            await this.api.post("/item/remove", { access_token: accessToken }));
          return "succeeded";
        } catch {
          return "failed";
        } finally {
          captured.fill(0);
        }
      },
      close: () => {
        closed = true;
        captured?.fill(0);
      },
    };
  }

  public async disconnect(localAccountId: string): Promise<ProviderDisconnectResult> {
    validateId(localAccountId, "local account ID");
    const prepared = await this.prepareDisconnect(localAccountId);
    try {
      await this.tokens.delete(PLAID_PROVIDER_ID, localAccountId);
      return {
        localCredentialsDeleted: true,
        remoteRevocation: await prepared.revoke(),
      };
    } finally {
      prepared.close();
    }
  }

  private async exchangeAndValidate(
    localAccountId: string,
    publicTokenText: string,
    selectedAccountId: string,
  ): Promise<PlaidHostedConsentCompletion> {
    const publicToken = Buffer.from(publicTokenText, "utf8");
    let accessToken: Uint8Array | undefined;
    try {
      const exchangeResult = await this.withSecretText(publicToken, async (publicTokenValue) =>
        await this.api.post("/item/public_token/exchange", { public_token: publicTokenValue }));
      const exchange = parsePlaidPublicTokenExchange(exchangeResult.data);
      accessToken = Buffer.from(exchange.accessToken, "utf8");
      try {
        const validated = await this.validateGrant(accessToken, exchange.itemId, selectedAccountId);
        const stored: ProviderTokenSet = {
          accessToken,
          tokenType: "Bearer",
          scopes: ["transactions"],
          expiresAt: validated.item.consentExpiresAt ?? NON_EXPIRING_ACCESS_TOKEN_DATE,
        };
        await this.tokens.put(PLAID_PROVIDER_ID, localAccountId, stored);
        const authorization: ProviderAuthorizationStatus = {
          providerId: PLAID_PROVIDER_ID,
          localAccountId,
          state: "authorized",
          checkedAt: this.now().toISOString(),
          ...(validated.item.consentExpiresAt === undefined
            ? {}
            : { expiresAt: validated.item.consentExpiresAt }),
        };
        return {
          authorization,
          account: toNormalizedPlaidAccount(
            validated.account,
            "active",
            validated.item.consentExpiresAt,
          ),
          itemId: validated.item.itemId,
        };
      } catch (error) {
        await this.removeUnpersistedItem(accessToken);
        throw error;
      }
    } finally {
      publicToken.fill(0);
      accessToken?.fill(0);
    }
  }

  private async completeHostedUpdate(
    localAccountId: string,
    grant: Extract<PendingHostedLink["grant"], { readonly kind: "update" }>,
  ): Promise<PlaidHostedConsentCompletion> {
    const stored = await this.tokens.get(PLAID_PROVIDER_ID, localAccountId);
    if (stored === undefined) {
      throw new ProviderIntegrationError(
        "AUTHORIZATION_REQUIRED",
        "The Plaid Item token was removed while reauthorization was in progress.",
      );
    }
    try {
      validateStoredTokenShape(stored);
      const validated = await this.validateGrant(
        stored.accessToken,
        grant.itemId,
        grant.providerAccountId,
      );
      const expiresAt = validated.item.consentExpiresAt ?? NON_EXPIRING_ACCESS_TOKEN_DATE;
      if (Date.parse(expiresAt) <= this.now().getTime()) {
        throw new ProviderIntegrationError(
          "AUTHORIZATION_REQUIRED",
          "Plaid reauthorization completed, but account consent is still expired.",
        );
      }
      await this.tokens.put(PLAID_PROVIDER_ID, localAccountId, {
        accessToken: stored.accessToken,
        tokenType: "Bearer",
        scopes: ["transactions"],
        expiresAt,
      });
      return {
        authorization: {
          providerId: PLAID_PROVIDER_ID,
          localAccountId,
          state: "authorized",
          checkedAt: this.now().toISOString(),
          ...(validated.item.consentExpiresAt === undefined
            ? {}
            : { expiresAt: validated.item.consentExpiresAt }),
        },
        account: toNormalizedPlaidAccount(
          validated.account,
          "active",
          validated.item.consentExpiresAt,
        ),
        itemId: validated.item.itemId,
      };
    } finally {
      wipeTokenSet(stored);
    }
  }

  private async validateGrant(accessToken: Uint8Array, expectedItemId: string, selectedAccountId: string) {
    const itemResult = await this.withSecretText(accessToken, async (value) =>
      await this.api.post("/item/get", { access_token: value }));
    const item = parsePlaidItem(itemResult.data);
    if (item.itemId !== expectedItemId || item.errorCode !== undefined) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "Plaid did not return the exact healthy Item created by Hosted Link.",
      );
    }
    await this.validateInstitution(item.institutionId);
    const accountsResult = await this.withSecretText(accessToken, async (value) =>
      await this.api.post("/accounts/get", { access_token: value }));
    const account = requireSinglePlaidPersonalCard(parsePlaidAccounts(accountsResult.data), selectedAccountId);
    return { item, account };
  }

  private async validateInstitution(institutionId: string): Promise<void> {
    const institutionResult = await this.api.post("/institutions/get_by_id", {
      institution_id: institutionId,
      country_codes: ["US"],
    });
    assertPlaidAllowedInstitution(
      institutionResult.data,
      institutionId,
      this.institutionPolicy.allowedExactNames,
    );
  }

  private async removeUnpersistedItem(accessToken: Uint8Array): Promise<void> {
    await this.withSecretText(accessToken, async (value) =>
      await this.api.post("/item/remove", { access_token: value })).catch(() => undefined);
  }

  private async withSecretText<T>(
    bytes: Uint8Array,
    operation: (value: string) => Promise<T>,
  ): Promise<T> {
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored Plaid authorization is invalid.", error);
    }
    if (value.length < 1 || value.length > 8192 || /[\u0000\r\n]/u.test(value)) {
      throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored Plaid authorization is invalid.");
    }
    return await operation(value);
  }

  private status(
    localAccountId: string,
    state: ProviderAuthorizationStatus["state"],
    reason: string,
  ): ProviderAuthorizationStatus {
    return {
      providerId: PLAID_PROVIDER_ID,
      localAccountId,
      state,
      checkedAt: this.now().toISOString(),
      reason,
    };
  }

  private assertAvailable(): void {
    if (!this.acceptingRequests) {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The Plaid provider runtime is closing and cannot accept another request.",
      );
    }
  }
}

interface ValidatedConfiguration {
  readonly clientName: string;
  readonly linkCustomizationName?: string;
  readonly redirectUri?: string;
  readonly transactionHistoryDays: number;
  readonly hostedLinkLifetimeSeconds: number;
  readonly pollIntervalMs: number;
  readonly completionTimeoutMs: number;
}

function validateConfiguration(configuration: PlaidHostedLinkConfiguration): ValidatedConfiguration {
  if (
    typeof configuration.clientName !== "string" ||
    configuration.clientName.trim().length < 1 ||
    configuration.clientName.trim().length > 30 ||
    /[\u0000-\u001f\u007f]/u.test(configuration.clientName)
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid client name is invalid.");
  }
  if (
    configuration.linkCustomizationName !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u.test(configuration.linkCustomizationName)
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid Link customization name is invalid.");
  }
  let redirectUri: string | undefined;
  if (configuration.redirectUri !== undefined) {
    const parsed = new URL(configuration.redirectUri);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new ProviderIntegrationError(
        "INVALID_CONFIGURATION",
        "Plaid's institution OAuth redirect must be an allowlisted HTTPS URL without a query or fragment.",
      );
    }
    redirectUri = parsed.toString();
  }
  const transactionHistoryDays = configuration.transactionHistoryDays ?? 730;
  const hostedLinkLifetimeSeconds = configuration.hostedLinkLifetimeSeconds ?? 1800;
  const pollIntervalMs = configuration.pollIntervalMs ?? 1500;
  const completionTimeoutMs = configuration.completionTimeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(transactionHistoryDays) || transactionHistoryDays < 30 || transactionHistoryDays > 730) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "Plaid transaction history must be 30-730 days.");
  }
  if (
    !Number.isSafeInteger(hostedLinkLifetimeSeconds) ||
    hostedLinkLifetimeSeconds < 300 ||
    hostedLinkLifetimeSeconds > 86_400
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid Hosted Link lifetime is invalid.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 10_000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid polling interval is invalid.");
  }
  if (!Number.isSafeInteger(completionTimeoutMs) || completionTimeoutMs < 1000 || completionTimeoutMs > 30 * 60 * 1000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid completion timeout is invalid.");
  }
  return {
    clientName: configuration.clientName.trim(),
    ...(configuration.linkCustomizationName === undefined
      ? {}
      : { linkCustomizationName: configuration.linkCustomizationName }),
    ...(redirectUri === undefined ? {} : { redirectUri }),
    transactionHistoryDays,
    hostedLinkLifetimeSeconds,
    pollIntervalMs,
    completionTimeoutMs,
  };
}

function validateStoredTokens(tokens: ProviderTokenSet, now: Date): void {
  validateStoredTokenShape(tokens);
  if (Date.parse(tokens.expiresAt) <= now.getTime()) {
    throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Plaid authorization has expired.");
  }
}

function validateStoredTokenShape(tokens: ProviderTokenSet): void {
  if (
    tokens.tokenType !== "Bearer" ||
    tokens.refreshToken !== undefined ||
    tokens.scopes.length !== 1 ||
    tokens.scopes[0] !== "transactions" ||
    !Number.isFinite(Date.parse(tokens.expiresAt))
  ) {
    throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored Plaid authorization is invalid.");
  }
}

function wipeTokenSet(tokens: ProviderTokenSet): void {
  tokens.accessToken.fill(0);
  tokens.refreshToken?.fill(0);
}

function isAuthorizationError(errorCode: string, errorType?: string): boolean {
  return errorCode === "ITEM_LOGIN_REQUIRED" ||
    errorCode === "INVALID_ACCESS_TOKEN" ||
    errorCode === "ITEM_NOT_FOUND" ||
    errorType === "OAUTH_ERROR";
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`);
  }
}

async function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    timeout.unref?.();
  });
}
