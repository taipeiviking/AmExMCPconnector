import type { SecretReferenceResolver } from "../security/secret-reference";
import { withResolvedSecret } from "../security/secret-reference";
import { ProviderIntegrationError, type ProviderReadResult } from "./provider-types";

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidApiConfiguration {
  readonly environment: PlaidEnvironment;
  readonly clientIdReference: string;
  readonly secretReference: string;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
}

export type PlaidApiPath =
  | "/accounts/get"
  | "/institutions/get_by_id"
  | "/item/get"
  | "/item/public_token/exchange"
  | "/item/remove"
  | "/link/token/create"
  | "/link/token/get"
  | "/transactions/get";

const ALLOWED_PATHS: ReadonlySet<PlaidApiPath> = new Set([
  "/accounts/get",
  "/institutions/get_by_id",
  "/item/get",
  "/item/public_token/exchange",
  "/item/remove",
  "/link/token/create",
  "/link/token/get",
  "/transactions/get",
]);

/**
 * Minimal Plaid transport with a fixed endpoint allowlist. Plaid's read APIs
 * use POST requests, but this client intentionally exposes no payment,
 * transfer, identity, account-number, or card-control endpoint.
 */
export class PlaidApiClient {
  public readonly environment: PlaidEnvironment;
  private readonly configuration: ValidatedConfiguration;
  private readonly activeRequests = new Set<AbortController>();
  private acceptingRequests = true;

  public constructor(
    configuration: PlaidApiConfiguration,
    private readonly secrets: SecretReferenceResolver,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.environment = configuration.environment;
    this.configuration = validateConfiguration(configuration, secrets);
  }

  public abortPending(): void {
    this.acceptingRequests = false;
    for (const request of this.activeRequests) request.abort();
  }

  public async post(
    path: PlaidApiPath,
    body: Readonly<Record<string, unknown>>,
  ): Promise<ProviderReadResult> {
    if (!this.acceptingRequests) {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The Plaid provider runtime is closing and cannot accept another request.",
      );
    }
    if (!ALLOWED_PATHS.has(path)) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid endpoint is not allowed.");
    }
    assertSafeRequestBody(body);

    const request = new AbortController();
    this.activeRequests.add(request);
    const timeout = setTimeout(() => request.abort(), this.configuration.requestTimeoutMs);
    timeout.unref?.();
    try {
      return await withResolvedSecret(
        this.secrets,
        this.configuration.clientIdReference,
        async (clientIdBytes) => await withResolvedSecret(
          this.secrets,
          this.configuration.secretReference,
          async (secretBytes) => {
            const clientId = decodeCredential(clientIdBytes, "client ID");
            const secret = decodeCredential(secretBytes, "secret");
            if (!this.acceptingRequests) {
              throw new ProviderIntegrationError(
                "PROVIDER_UNAVAILABLE",
                "The Plaid provider runtime is closing and cannot accept another request.",
              );
            }
            let response: Response;
            try {
              response = await this.fetchImpl(
                new URL(path, this.configuration.apiOrigin),
                {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "PLAID-CLIENT-ID": clientId,
                    "PLAID-SECRET": secret,
                    "Plaid-Version": "2020-09-14",
                  },
                  body: JSON.stringify(body),
                  cache: "no-store",
                  credentials: "omit",
                  redirect: "error",
                  signal: request.signal,
                },
              );
            } catch (error) {
              if (error instanceof ProviderIntegrationError) throw error;
              throw new ProviderIntegrationError(
                "PROVIDER_UNAVAILABLE",
                "Plaid is temporarily unavailable.",
                error,
              );
            }

            const data = await readLimitedJson(response, this.configuration.maximumResponseBytes);
            if (!response.ok) throw plaidResponseError(response.status, data);
            const requestId = safeRequestId(data);
            return { data, ...(requestId === undefined ? {} : { providerRequestId: requestId }) };
          },
          request.signal,
        ),
        request.signal,
      );
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(request);
    }
  }
}

interface ValidatedConfiguration {
  readonly apiOrigin: string;
  readonly clientIdReference: string;
  readonly secretReference: string;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
}

function validateConfiguration(
  configuration: PlaidApiConfiguration,
  secrets: SecretReferenceResolver,
): ValidatedConfiguration {
  if (configuration.environment !== "sandbox" && configuration.environment !== "production") {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid environment is invalid.");
  }
  for (const reference of [configuration.clientIdReference, configuration.secretReference]) {
    if (
      typeof reference !== "string" ||
      reference.length < 1 ||
      reference.length > 2048 ||
      !secrets.supports(reference)
    ) {
      throw new ProviderIntegrationError(
        "INVALID_CONFIGURATION",
        "Plaid requires two supported protected credential references.",
      );
    }
  }
  const requestTimeoutMs = configuration.requestTimeoutMs ?? 30_000;
  const maximumResponseBytes = configuration.maximumResponseBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1024 ||
    maximumResponseBytes > 50 * 1024 * 1024
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid response limit is invalid.");
  }
  return {
    apiOrigin: `https://${configuration.environment}.plaid.com/`,
    clientIdReference: configuration.clientIdReference,
    secretReference: configuration.secretReference,
    requestTimeoutMs,
    maximumResponseBytes,
  };
}

function assertSafeRequestBody(value: unknown, depth = 0): void {
  if (depth > 12) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request is too deeply nested.");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains an invalid number.");
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > 1024 * 1024 || /[\u0000]/u.test(value)) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains an invalid value.");
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains too many values.");
    }
    for (const item of value) assertSafeRequestBody(item, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains an invalid value.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 1000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains too many fields.");
  }
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(key)) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The Plaid request contains an invalid field.");
    }
    assertSafeRequestBody(item, depth + 1);
  }
}

function decodeCredential(bytes: Uint8Array, label: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The protected Plaid ${label} is invalid.`, error);
  }
  if (value.length < 1 || value.length > 8192 || /[\u0000\r\n]/u.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The protected Plaid ${label} is invalid.`);
  }
  return value;
}

async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderIntegrationError("RESPONSE_TOO_LARGE", "The Plaid response exceeded the safety limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ProviderIntegrationError("INVALID_PROVIDER_RESPONSE", "Plaid returned an empty response.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ProviderIntegrationError("RESPONSE_TOO_LARGE", "The Plaid response exceeded the safety limit.");
      }
      chunks.push(Uint8Array.from(next.value));
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
    } catch (error) {
      throw new ProviderIntegrationError("INVALID_PROVIDER_RESPONSE", "Plaid returned invalid JSON.", error);
    } finally {
      combined.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function plaidResponseError(status: number, data: unknown): ProviderIntegrationError {
  const record = asRecord(data);
  const errorCode = typeof record?.error_code === "string" ? record.error_code : undefined;
  const errorType = typeof record?.error_type === "string" ? record.error_type : undefined;
  if (
    errorCode === "ITEM_LOGIN_REQUIRED" ||
    errorCode === "INVALID_ACCESS_TOKEN" ||
    errorCode === "ITEM_NOT_FOUND" ||
    errorCode === "ACCESS_NOT_GRANTED" ||
    errorCode === "ADDITIONAL_CONSENT_REQUIRED" ||
    errorCode === "PENDING_DISCONNECT" ||
    errorCode === "PENDING_EXPIRATION" ||
    errorType === "OAUTH_ERROR"
  ) {
    return new ProviderIntegrationError(
      "AUTHORIZATION_REQUIRED",
      "Plaid requires this account to be connected again.",
    );
  }
  if (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    errorCode === "PRODUCT_NOT_READY" ||
    errorType === "INSTITUTION_ERROR" ||
    errorType === "RATE_LIMIT_EXCEEDED" ||
    errorType === "API_ERROR"
  ) {
    return new ProviderIntegrationError("PROVIDER_UNAVAILABLE", "Plaid is temporarily unavailable.");
  }
  return new ProviderIntegrationError("PROVIDER_REJECTED", "Plaid rejected the request.");
}

function safeRequestId(data: unknown): string | undefined {
  const value = asRecord(data)?.request_id;
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
