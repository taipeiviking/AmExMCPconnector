import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretReferenceResolver } from "../security/secret-reference";
import { withResolvedSecret } from "../security/secret-reference";
import {
  ProviderIntegrationError,
  type ProviderAuthorizationStatus,
  type ProviderConsentAdapter,
  type ProviderConsentCallback,
  type ProviderConsentStart,
  type ProviderDisconnectResult,
  type PreparedProviderRevocation,
  type ProviderTokenSet,
  type ProviderTokenStore,
} from "./provider-types";

const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);
const FORBIDDEN_SCOPE_PART = /(^|[.:/_-])(write|payment|payments|transfer|transfers|dispute|disputes|card-control|card-controls|manage|management)(?=$|[.:/_-])/iu;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface GenericProviderOAuthConfiguration {
  readonly providerId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientIdReference: string;
  readonly clientSecretReference?: string;
  /** Exact provider scopes approved for this connector. Write-like scopes are rejected. */
  readonly readOnlyScopes: readonly string[];
  /** Must be an explicit IPv4 loopback callback URI. */
  readonly redirectUri: string;
  readonly extraAuthorizationParameters?: Readonly<Record<string, string>>;
  readonly consentLifetimeMs?: number;
  readonly refreshSkewSeconds?: number;
  /** Bounds token, refresh, revocation, and response-body operations. */
  readonly requestTimeoutMs?: number;
}

interface PendingConsent {
  readonly state: string;
  readonly verifier: Uint8Array;
  readonly expiresAtMs: number;
}

interface TokenResponseRecord {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly scope?: string;
}

/**
 * Generic OAuth 2.0 authorization-code + PKCE adapter for an independently
 * approved read-only U.S. data provider. It never handles Amex passwords and
 * never exposes token material through its public consent methods.
 */
export class GenericProviderOAuthClient implements ProviderConsentAdapter {
  private readonly configuration: ValidatedOAuthConfiguration;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly activeRequests = new Set<AbortController>();
  private acceptingRequests = true;

  public constructor(
    configuration: GenericProviderOAuthConfiguration,
    private readonly secrets: SecretReferenceResolver,
    private readonly tokens: ProviderTokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.configuration = validateConfiguration(configuration);
  }

  public abortPending(): void {
    this.acceptingRequests = false;
    for (const pending of this.pending.values()) pending.verifier.fill(0);
    this.pending.clear();
    for (const request of this.activeRequests) request.abort();
  }

  public async beginConsent(localAccountId: string): Promise<ProviderConsentStart> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    const previous = this.pending.get(localAccountId);
    previous?.verifier.fill(0);

    const verifierText = randomBytes(32).toString("base64url");
    const verifier = Buffer.from(verifierText, "ascii");
    const state = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
    const expiresAtMs = this.now().getTime() + this.configuration.consentLifetimeMs;
    this.pending.set(localAccountId, { state, verifier, expiresAtMs });

    try {
      const authorizationUrl = await withResolvedSecret(
        this.secrets,
        this.configuration.clientIdReference,
        async (clientIdBytes) => {
          const clientId = decodeCredentialText(clientIdBytes, "provider client ID");
          const url = new URL(this.configuration.authorizationEndpoint);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", this.configuration.redirectUri);
          url.searchParams.set("scope", this.configuration.readOnlyScopes.join(" "));
          url.searchParams.set("state", state);
          url.searchParams.set("code_challenge", codeChallenge);
          url.searchParams.set("code_challenge_method", "S256");
          for (const [name, value] of Object.entries(this.configuration.extraAuthorizationParameters)) {
            url.searchParams.set(name, value);
          }
          return url.toString();
        },
      );
      this.assertAcceptingRequests();
      return {
        providerId: this.configuration.providerId,
        localAccountId,
        authorizationUrl,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    } catch (error) {
      this.cancelConsent(localAccountId);
      throw error;
    }
  }

  public async completeConsent(
    localAccountId: string,
    callback: ProviderConsentCallback,
  ): Promise<ProviderAuthorizationStatus> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    validateCallbackValue(callback.state, "OAuth state", 512);
    validateCallbackValue(callback.code, "authorization code", 8192);
    const pending = this.pending.get(localAccountId);
    this.pending.delete(localAccountId);
    if (!pending) {
      throw new ProviderIntegrationError("CONSENT_MISMATCH", "No matching provider consent request is pending.");
    }
    try {
      if (pending.expiresAtMs <= this.now().getTime()) {
        throw new ProviderIntegrationError("CONSENT_EXPIRED", "The provider consent request has expired.");
      }
      if (!constantTimeTextEqual(pending.state, callback.state)) {
        throw new ProviderIntegrationError("CONSENT_MISMATCH", "The provider consent response did not match.");
      }
      const response = await this.requestToken(
        {
          grant_type: "authorization_code",
          code: callback.code,
          redirect_uri: this.configuration.redirectUri,
          code_verifier: Buffer.from(pending.verifier).toString("ascii"),
        },
        "consent",
      );
      const tokenSet = this.toTokenSet(response);
      try {
        await this.tokens.put(this.configuration.providerId, localAccountId, tokenSet);
      } finally {
        wipeTokenSet(tokenSet);
      }
      return await this.checkAuthorization(localAccountId);
    } finally {
      pending.verifier.fill(0);
    }
  }

  public cancelConsent(localAccountId: string): void {
    validateId(localAccountId, "local account ID");
    const pending = this.pending.get(localAccountId);
    this.pending.delete(localAccountId);
    pending?.verifier.fill(0);
  }

  public async checkAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    const checkedAt = this.now().toISOString();
    if (this.pending.has(localAccountId)) {
      return this.status(localAccountId, "pending", checkedAt);
    }
    const tokenSet = await this.tokens.get(this.configuration.providerId, localAccountId);
    if (!tokenSet) return this.status(localAccountId, "not_authorized", checkedAt);
    try {
      if (Date.parse(tokenSet.expiresAt) > this.now().getTime()) {
        return this.status(localAccountId, "authorized", checkedAt, tokenSet.expiresAt);
      }
      if (!tokenSet.refreshToken) {
        return this.status(
          localAccountId,
          "reauthorization_required",
          checkedAt,
          tokenSet.expiresAt,
          "provider_token_expired",
        );
      }
    } finally {
      wipeTokenSet(tokenSet);
    }

    try {
      return await this.refreshAuthorization(localAccountId);
    } catch (error) {
      if (error instanceof ProviderIntegrationError && error.code === "AUTHORIZATION_REQUIRED") {
        return this.status(localAccountId, "reauthorization_required", checkedAt, undefined, "provider_refresh_rejected");
      }
      if (error instanceof ProviderIntegrationError && error.code === "PROVIDER_UNAVAILABLE") {
        return this.status(localAccountId, "unavailable", checkedAt, undefined, "provider_temporarily_unavailable");
      }
      throw error;
    }
  }

  public async refreshAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    const current = await this.tokens.get(this.configuration.providerId, localAccountId);
    if (!current?.refreshToken) {
      if (current) wipeTokenSet(current);
      throw new ProviderIntegrationError(
        "AUTHORIZATION_REQUIRED",
        "The provider requires this account to be authorized again.",
      );
    }
    try {
      const response = await this.requestToken(
        {
          grant_type: "refresh_token",
          refresh_token: Buffer.from(current.refreshToken).toString("utf8"),
        },
        "refresh",
      );
      const next = this.toTokenSet(response, current.refreshToken);
      try {
        await this.tokens.put(this.configuration.providerId, localAccountId, next);
        return this.status(localAccountId, "authorized", this.now().toISOString(), next.expiresAt);
      } finally {
        wipeTokenSet(next);
      }
    } finally {
      wipeTokenSet(current);
    }
  }

  /** Returns caller-owned access-token bytes and refreshes only when needed. */
  public async getAccessToken(localAccountId: string): Promise<Uint8Array> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    let current = await this.tokens.get(this.configuration.providerId, localAccountId);
    if (!current) {
      throw new ProviderIntegrationError(
        "AUTHORIZATION_REQUIRED",
        "The provider account has not been authorized.",
      );
    }
    const refreshAt = Date.parse(current.expiresAt) - this.configuration.refreshSkewSeconds * 1000;
    if (refreshAt <= this.now().getTime()) {
      wipeTokenSet(current);
      current = undefined;
      await this.refreshAuthorization(localAccountId);
      current = await this.tokens.get(this.configuration.providerId, localAccountId);
      if (!current) {
        throw new ProviderIntegrationError(
          "AUTHORIZATION_REQUIRED",
          "The provider requires this account to be authorized again.",
        );
      }
    }
    try {
      return Uint8Array.from(current.accessToken);
    } finally {
      wipeTokenSet(current);
    }
  }

  public async disconnect(localAccountId: string): Promise<ProviderDisconnectResult> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    this.cancelConsent(localAccountId);
    const prepared = await this.prepareDisconnect(localAccountId);
    try {
      await this.tokens.delete(this.configuration.providerId, localAccountId);
      return {
        localCredentialsDeleted: true,
        remoteRevocation: await prepared.revoke(),
      };
    } finally {
      prepared.close();
    }
  }

  public async prepareDisconnect(localAccountId: string): Promise<PreparedProviderRevocation> {
    this.assertAcceptingRequests();
    validateId(localAccountId, "local account ID");
    const current = await this.tokens.get(this.configuration.providerId, localAccountId);
    const revocationToken = current === undefined
      ? undefined
      : Uint8Array.from(current.refreshToken ?? current.accessToken);
    const tokenTypeHint = current?.refreshToken === undefined ? "access_token" : "refresh_token";
    if (current) wipeTokenSet(current);
    let available = true;
    const close = (): void => {
      if (!available) return;
      available = false;
      revocationToken?.fill(0);
    };
    return {
      revoke: async () => {
        if (!available) return "failed";
        available = false;
        try {
          if (!revocationToken || !this.configuration.revocationEndpoint) return "not_configured";
          const tokenCopy = Buffer.from(revocationToken);
          try {
            await this.requestForm(
              this.configuration.revocationEndpoint,
              {
                token: tokenCopy.toString("utf8"),
                token_type_hint: tokenTypeHint,
              },
              "revocation",
            );
            return "succeeded";
          } catch {
            return "failed";
          } finally {
            tokenCopy.fill(0);
          }
        } finally {
          revocationToken?.fill(0);
        }
      },
      close,
    };
  }

  private status(
    localAccountId: string,
    state: ProviderAuthorizationStatus["state"],
    checkedAt: string,
    expiresAt?: string,
    reason?: string,
  ): ProviderAuthorizationStatus {
    return {
      providerId: this.configuration.providerId,
      localAccountId,
      state,
      checkedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private async requestToken(
    form: Readonly<Record<string, string>>,
    operation: "consent" | "refresh",
  ): Promise<TokenResponseRecord> {
    const response = await this.requestForm(this.configuration.tokenEndpoint, form, operation);
    if (!isTokenResponse(response)) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned invalid authorization data.",
      );
    }
    return response;
  }

  private async requestForm(
    endpoint: string,
    form: Readonly<Record<string, string>>,
    operation: "consent" | "refresh" | "revocation",
  ): Promise<unknown> {
    this.assertAcceptingRequests();
    const abortController = new AbortController();
    this.activeRequests.add(abortController);
    const timeout = setTimeout(
      () => abortController.abort(),
      this.configuration.requestTimeoutMs,
    );
    timeout.unref?.();
    try {
      return await withResolvedSecret(
        this.secrets,
        this.configuration.clientIdReference,
        async (clientIdBytes) => {
          this.assertAcceptingRequests();
        const fields: Record<string, string> = {
          ...form,
          client_id: decodeCredentialText(clientIdBytes, "provider client ID"),
        };
        const send = async (): Promise<unknown> => {
          this.assertAcceptingRequests();
          const response = await this.fetchImpl(endpoint, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams(fields),
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
              signal: abortController.signal,
          });
          const payload = await readLimitedJson(response, 1024 * 1024, response.ok);
          if (!response.ok) {
            throw providerRequestFailure(operation, response.status, payload);
          }
          return payload;
        };
        if (!this.configuration.clientSecretReference) return await send();
        return await withResolvedSecret(
          this.secrets,
          this.configuration.clientSecretReference,
          async (clientSecretBytes) => {
            this.assertAcceptingRequests();
            fields.client_secret = decodeCredentialText(clientSecretBytes, "provider client secret");
            return await send();
          },
          abortController.signal,
        );
      },
        abortController.signal,
      );
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The approved data provider is temporarily unavailable.",
        error,
      );
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(abortController);
    }
  }

  private assertAcceptingRequests(): void {
    if (!this.acceptingRequests) {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The provider runtime is closing and cannot accept another request.",
      );
    }
  }

  private toTokenSet(response: TokenResponseRecord, existingRefreshToken?: Uint8Array): ProviderTokenSet {
    const scopes = response.scope === undefined
      ? [...this.configuration.readOnlyScopes]
      : response.scope.split(/\s+/u).filter((scope) => scope.length > 0);
    if (
      scopes.length === 0 ||
      scopes.some((scope) => !this.configuration.readOnlyScopes.includes(scope))
    ) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned scopes outside the approved read-only set.",
      );
    }
    const accessToken = Buffer.from(response.access_token, "utf8");
    const responseRefresh = response.refresh_token === undefined
      ? undefined
      : Buffer.from(response.refresh_token, "utf8");
    const refreshToken = responseRefresh ??
      (existingRefreshToken === undefined ? undefined : Uint8Array.from(existingRefreshToken));
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      tokenType: "Bearer",
      scopes,
      expiresAt: new Date(this.now().getTime() + response.expires_in * 1000).toISOString(),
    };
  }
}

interface ValidatedOAuthConfiguration {
  readonly providerId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  readonly clientIdReference: string;
  readonly clientSecretReference?: string;
  readonly readOnlyScopes: readonly string[];
  readonly redirectUri: string;
  readonly extraAuthorizationParameters: Readonly<Record<string, string>>;
  readonly consentLifetimeMs: number;
  readonly refreshSkewSeconds: number;
  readonly requestTimeoutMs: number;
}

function validateConfiguration(configuration: GenericProviderOAuthConfiguration): ValidatedOAuthConfiguration {
  validateId(configuration.providerId, "provider ID");
  const authorizationEndpoint = validateHttpsEndpoint(configuration.authorizationEndpoint, "authorization endpoint");
  const tokenEndpoint = validateHttpsEndpoint(configuration.tokenEndpoint, "token endpoint");
  const revocationEndpoint = configuration.revocationEndpoint === undefined
    ? undefined
    : validateHttpsEndpoint(configuration.revocationEndpoint, "revocation endpoint");
  const redirect = new URL(configuration.redirectUri);
  if (
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.port.length === 0 ||
    redirect.username.length > 0 ||
    redirect.password.length > 0 ||
    redirect.hash.length > 0
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The provider redirect URI must use an explicit IPv4 loopback address and port.",
    );
  }
  if (
    configuration.readOnlyScopes.length < 1 ||
    new Set(configuration.readOnlyScopes).size !== configuration.readOnlyScopes.length ||
    configuration.readOnlyScopes.some(
      (scope) => !/^[A-Za-z0-9._:/-]{1,256}$/u.test(scope) || FORBIDDEN_SCOPE_PART.test(scope),
    )
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "Provider scopes must be an explicit, unique read-only set.",
    );
  }
  const extras = configuration.extraAuthorizationParameters ?? {};
  for (const [name, value] of Object.entries(extras)) {
    if (
      !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(name) ||
      RESERVED_AUTHORIZATION_PARAMETERS.has(name.toLowerCase()) ||
      value.length > 2048 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new ProviderIntegrationError(
        "INVALID_CONFIGURATION",
        "An additional provider authorization parameter is invalid.",
      );
    }
  }
  const consentLifetimeMs = configuration.consentLifetimeMs ?? 10 * 60 * 1000;
  const refreshSkewSeconds = configuration.refreshSkewSeconds ?? 300;
  const requestTimeoutMs = configuration.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(consentLifetimeMs) || consentLifetimeMs < 60_000 || consentLifetimeMs > 30 * 60 * 1000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider consent lifetime is invalid.");
  }
  if (!Number.isSafeInteger(refreshSkewSeconds) || refreshSkewSeconds < 0 || refreshSkewSeconds > 3600) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider refresh skew is invalid.");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider authorization request timeout is invalid.");
  }
  if (configuration.clientIdReference.length < 1 || configuration.clientIdReference.length > 2048) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider client ID reference is invalid.");
  }
  return {
    providerId: configuration.providerId,
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    clientIdReference: configuration.clientIdReference,
    ...(configuration.clientSecretReference === undefined
      ? {}
      : { clientSecretReference: configuration.clientSecretReference }),
    readOnlyScopes: [...configuration.readOnlyScopes],
    redirectUri: redirect.toString(),
    extraAuthorizationParameters: { ...extras },
    consentLifetimeMs,
    refreshSkewSeconds,
    requestTimeoutMs,
  };
}

function validateHttpsEndpoint(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The provider ${label} is invalid.`, error);
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      `The provider ${label} must be an HTTPS URL without embedded credentials.`,
    );
  }
  return url.toString();
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`);
  }
}

function validateCallbackValue(value: string, label: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ProviderIntegrationError("CONSENT_MISMATCH", `The provider ${label} is invalid.`);
  }
}

function decodeCredentialText(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`, error);
  }
  if (value.length < 1 || value.length > 8192 || /[\u0000\r\n]/u.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`);
  }
  return value;
}

function constantTimeTextEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  try {
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
}

function isTokenResponse(value: unknown): value is TokenResponseRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.access_token === "string" &&
    record.access_token.length >= 1 &&
    record.access_token.length <= 1024 * 1024 &&
    (record.refresh_token === undefined ||
      (typeof record.refresh_token === "string" && record.refresh_token.length >= 1 && record.refresh_token.length <= 1024 * 1024)) &&
    typeof record.token_type === "string" &&
    record.token_type.toLowerCase() === "bearer" &&
    typeof record.expires_in === "number" &&
    Number.isSafeInteger(record.expires_in) &&
    record.expires_in >= 1 &&
    record.expires_in <= 365 * 24 * 60 * 60 &&
    (record.scope === undefined || typeof record.scope === "string")
  );
}

function providerRequestFailure(
  operation: "consent" | "refresh" | "revocation",
  status: number,
  payload: unknown,
): ProviderIntegrationError {
  if (status === 408 || status === 429 || status >= 500) {
    return new ProviderIntegrationError(
      "PROVIDER_UNAVAILABLE",
      "The approved data provider is temporarily unavailable.",
    );
  }
  const errorCode = oauthErrorCode(payload);
  if (operation === "refresh" && (errorCode === "invalid_grant" || errorCode === "invalid_token")) {
    return new ProviderIntegrationError(
      "AUTHORIZATION_REQUIRED",
      "The provider requires this account to be authorized again.",
    );
  }
  return new ProviderIntegrationError(
    "PROVIDER_REJECTED",
    "The approved data provider rejected the authorization request.",
  );
}

function oauthErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && /^[A-Za-z0-9._~-]{1,128}$/u.test(error) ? error : undefined;
}

async function readLimitedJson(
  response: Response,
  maximumBytes: number,
  strict: boolean = true,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        throw new ProviderIntegrationError("RESPONSE_TOO_LARGE", "The provider response exceeded the safety limit.");
      }
      chunks.push(Uint8Array.from(next.value));
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    try {
      if (combined.byteLength === 0) return undefined;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      if (!strict) return undefined;
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The provider returned an invalid response.",
        error,
      );
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function wipeTokenSet(tokens: ProviderTokenSet): void {
  tokens.accessToken.fill(0);
  tokens.refreshToken?.fill(0);
}
