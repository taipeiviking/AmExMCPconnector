import {
  ProviderIntegrationError,
  type ProviderAccountSelection,
  type ProviderReadResult,
  type ReadOnlyFinancialProvider,
} from "./provider-types";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set(["providerAccountId", "providerStatementId"]);

export interface ProviderAccessTokenSource {
  /** Returns caller-owned bytes; the caller must overwrite them. */
  getAccessToken(localAccountId: string): Promise<Uint8Array>;
}

export interface GenericReadOnlyProviderEndpoints {
  readonly accounts: string;
  readonly accountStatus: string;
  readonly transactions: string;
  readonly statements: string;
  readonly statement: string;
}

export interface GenericReadOnlyProviderConfiguration {
  readonly providerId: string;
  readonly apiBaseUrl: string;
  /** Relative path templates. Supported placeholders are providerAccountId and providerStatementId. */
  readonly endpoints: GenericReadOnlyProviderEndpoints;
  readonly requestTimeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumPageSize?: number;
  readonly providerRequestIdHeader?: string;
}

/**
 * Configurable provider client whose public surface and transport are GET-only.
 * Provider-specific payload mapping remains an explicit integration step.
 */
export class GenericReadOnlyProviderHttpClient implements ReadOnlyFinancialProvider {
  private readonly configuration: ValidatedReadConfiguration;
  private readonly activeRequests = new Set<AbortController>();
  private acceptingRequests = true;

  public constructor(
    configuration: GenericReadOnlyProviderConfiguration,
    private readonly tokenSource: ProviderAccessTokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.configuration = validateConfiguration(configuration);
  }

  public abortPending(): void {
    this.acceptingRequests = false;
    for (const request of this.activeRequests) request.abort();
  }

  public async listAccounts(localAccountId: string): Promise<ProviderReadResult> {
    validateId(localAccountId, "local account ID");
    return await this.get(
      { localAccountId, providerAccountId: localAccountId },
      this.configuration.endpoints.accounts,
    );
  }

  public async getAccountStatus(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    return await this.get(selection, this.configuration.endpoints.accountStatus);
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
    if (filter.from !== undefined) validateDate(filter.from, "from date");
    if (filter.to !== undefined) validateDate(filter.to, "to date");
    if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider date range is invalid.");
    }
    if (
      filter.cursor !== undefined &&
      (filter.cursor.length < 1 || filter.cursor.length > 2048 || /[\u0000-\u001f\u007f]/u.test(filter.cursor))
    ) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider cursor is invalid.");
    }
    const pageSize = filter.pageSize ?? this.configuration.maximumPageSize;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > this.configuration.maximumPageSize) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider page size is invalid.");
    }
    return await this.get(selection, this.configuration.endpoints.transactions, {
      ...(filter.from === undefined ? {} : { from: filter.from }),
      ...(filter.to === undefined ? {} : { to: filter.to }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      page_size: String(pageSize),
    });
  }

  public async listStatements(selection: ProviderAccountSelection): Promise<ProviderReadResult> {
    return await this.get(selection, this.configuration.endpoints.statements);
  }

  public async getStatement(
    selection: ProviderAccountSelection,
    providerStatementId: string,
  ): Promise<ProviderReadResult> {
    validateId(providerStatementId, "provider statement ID");
    return await this.get(selection, this.configuration.endpoints.statement, {}, providerStatementId);
  }

  private async get(
    selection: ProviderAccountSelection,
    template: string,
    query: Readonly<Record<string, string>> = {},
    providerStatementId?: string,
  ): Promise<ProviderReadResult> {
    if (!this.acceptingRequests) {
      throw new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The provider runtime is closing and cannot accept another read.",
      );
    }
    validateSelection(selection);
    const path = interpolatePath(template, {
      providerAccountId: selection.providerAccountId,
      ...(providerStatementId === undefined ? {} : { providerStatementId }),
    });
    const url = new URL(path, this.configuration.apiBaseUrl);
    if (url.origin !== this.configuration.apiOrigin) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider endpoint escaped its API origin.");
    }
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    const abortController = new AbortController();
    this.activeRequests.add(abortController);
    const timeout = setTimeout(() => abortController.abort(), this.configuration.requestTimeoutMs);
    timeout.unref?.();
    let accessToken: Uint8Array | undefined;
    try {
      accessToken = await this.tokenSource.getAccessToken(selection.localAccountId);
      if (!this.acceptingRequests) {
        throw new ProviderIntegrationError(
          "PROVIDER_UNAVAILABLE",
          "The provider runtime is closing and cannot accept another read.",
        );
      }
      const tokenText = decodeAccessToken(accessToken);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${tokenText}`,
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: abortController.signal,
        });
      } catch (error) {
        throw new ProviderIntegrationError(
          "PROVIDER_UNAVAILABLE",
          "The approved data provider is temporarily unavailable.",
          error,
        );
      }
      if (response.status === 401 || response.status === 403) {
        await discardBody(response, this.configuration.maximumResponseBytes);
        throw new ProviderIntegrationError(
          "AUTHORIZATION_REQUIRED",
          "The provider requires this account to be authorized again.",
        );
      }
      if (!response.ok) {
        await discardBody(response, this.configuration.maximumResponseBytes);
        const unavailable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new ProviderIntegrationError(
          unavailable ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED",
          unavailable
            ? "The approved data provider is temporarily unavailable."
            : "The approved data provider rejected the read request.",
        );
      }
      const data = await readLimitedJson(response, this.configuration.maximumResponseBytes);
      const requestId = response.headers.get(this.configuration.providerRequestIdHeader);
      return {
        data,
        ...(isSafeRequestId(requestId) ? { providerRequestId: requestId } : {}),
      };
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(abortController);
      accessToken?.fill(0);
    }
  }
}

interface ValidatedReadConfiguration {
  readonly providerId: string;
  readonly apiBaseUrl: string;
  readonly apiOrigin: string;
  readonly endpoints: GenericReadOnlyProviderEndpoints;
  readonly requestTimeoutMs: number;
  readonly maximumResponseBytes: number;
  readonly maximumPageSize: number;
  readonly providerRequestIdHeader: string;
}

function validateConfiguration(configuration: GenericReadOnlyProviderConfiguration): ValidatedReadConfiguration {
  validateId(configuration.providerId, "provider ID");
  let apiBase: URL;
  try {
    apiBase = new URL(configuration.apiBaseUrl);
  } catch (error) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider API URL is invalid.", error);
  }
  if (
    apiBase.protocol !== "https:" ||
    apiBase.username.length > 0 ||
    apiBase.password.length > 0 ||
    apiBase.hash.length > 0 ||
    apiBase.search.length > 0
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The provider API base must be HTTPS without credentials, a query, or a fragment.",
    );
  }
  const endpoints = { ...configuration.endpoints };
  validateTemplate(endpoints.accounts, []);
  validateTemplate(endpoints.accountStatus, ["providerAccountId"]);
  validateTemplate(endpoints.transactions, ["providerAccountId"]);
  validateTemplate(endpoints.statements, ["providerAccountId"]);
  validateTemplate(endpoints.statement, ["providerAccountId", "providerStatementId"]);

  const requestTimeoutMs = configuration.requestTimeoutMs ?? 30_000;
  const maximumResponseBytes = configuration.maximumResponseBytes ?? 10 * 1024 * 1024;
  const maximumPageSize = configuration.maximumPageSize ?? 200;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider request timeout is invalid.");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1024 || maximumResponseBytes > 50 * 1024 * 1024) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider response limit is invalid.");
  }
  if (!Number.isSafeInteger(maximumPageSize) || maximumPageSize < 1 || maximumPageSize > 1000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider page-size limit is invalid.");
  }
  const providerRequestIdHeader = (configuration.providerRequestIdHeader ?? "x-request-id").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(providerRequestIdHeader)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The provider request-ID header is invalid.");
  }
  return {
    providerId: configuration.providerId,
    apiBaseUrl: apiBase.toString(),
    apiOrigin: apiBase.origin,
    endpoints,
    requestTimeoutMs,
    maximumResponseBytes,
    maximumPageSize,
    providerRequestIdHeader,
  };
}

function validateTemplate(template: string, required: readonly string[]): void {
  if (
    typeof template !== "string" ||
    !template.startsWith("/") ||
    template.startsWith("//") ||
    template.includes("?") ||
    template.includes("#") ||
    template.includes("\\") ||
    template.split("/").includes("..") ||
    /[\u0000-\u001f\u007f]/u.test(template)
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "A provider endpoint template is invalid.");
  }
  const placeholders = [...template.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]);
  if (
    placeholders.some((placeholder) => placeholder === undefined || !ALLOWED_TEMPLATE_PLACEHOLDERS.has(placeholder)) ||
    required.some((placeholder) => !placeholders.includes(placeholder)) ||
    placeholders.some((placeholder) => !required.includes(placeholder ?? ""))
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "A provider endpoint template has invalid or missing placeholders.",
    );
  }
  const withoutPlaceholders = template.replace(/\{[^{}]+\}/gu, "x");
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "A provider endpoint template is invalid.");
  }
}

function interpolatePath(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^{}]+)\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new ProviderIntegrationError("INVALID_CONFIGURATION", "A provider endpoint value is missing.");
    }
    return encodeURIComponent(value);
  });
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
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The provider ${label} is invalid.`);
  }
}

function decodeAccessToken(bytes: Uint8Array): string {
  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored provider authorization is invalid.", error);
  }
  if (token.length < 1 || token.length > 1024 * 1024 || /[\u0000\r\n]/u.test(token)) {
    throw new ProviderIntegrationError("AUTHORIZATION_REQUIRED", "Stored provider authorization is invalid.");
  }
  return token;
}

async function readLimitedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.includes("application/json") && !contentType?.includes("+json")) {
    await discardBody(response, maximumBytes);
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "The provider did not return JSON data.",
    );
  }
  const bytes = await readLimitedBytes(response, maximumBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "The provider returned invalid JSON data.",
      error,
    );
  } finally {
    bytes.fill(0);
  }
}

async function discardBody(response: Response, maximumBytes: number): Promise<void> {
  const bytes = await readLimitedBytes(response, maximumBytes);
  bytes.fill(0);
}

async function readLimitedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderIntegrationError("RESPONSE_TOO_LARGE", "The provider response exceeded the safety limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
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
    return combined;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function isSafeRequestId(value: string | null): value is string {
  return value !== null && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
