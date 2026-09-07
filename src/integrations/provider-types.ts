export type ProviderIntegrationErrorCode =
  | "INVALID_CONFIGURATION"
  | "AUTHORIZATION_REQUIRED"
  | "CONSENT_MISMATCH"
  | "CONSENT_EXPIRED"
  | "CONSENT_CANCELLED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "INVALID_PROVIDER_RESPONSE"
  | "RESPONSE_TOO_LARGE";

/** Stable error surface that never embeds provider payloads or credential values. */
export class ProviderIntegrationError extends Error {
  public constructor(
    public readonly code: ProviderIntegrationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderIntegrationError";
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
  }
}

/** Token material is always scoped by both provider and local account ID. */
export interface ProviderTokenSet {
  readonly accessToken: Uint8Array;
  readonly refreshToken?: Uint8Array;
  readonly tokenType: "Bearer";
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

export interface ProviderTokenStore {
  get(providerId: string, localAccountId: string): Promise<ProviderTokenSet | undefined>;
  put(providerId: string, localAccountId: string, tokens: ProviderTokenSet): Promise<void>;
  delete(providerId: string, localAccountId: string): Promise<boolean>;
}

export interface ProviderConsentStart {
  readonly providerId: string;
  readonly localAccountId: string;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface ProviderConsentCallback {
  readonly state: string;
  readonly code: string;
}

export interface ProviderAuthorizationStatus {
  readonly providerId: string;
  readonly localAccountId: string;
  readonly state:
    | "not_authorized"
    | "pending"
    | "authorized"
    | "reauthorization_required"
    | "unavailable";
  readonly checkedAt: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

export interface ProviderDisconnectResult {
  readonly localCredentialsDeleted: true;
  readonly remoteRevocation: "not_configured" | "succeeded" | "failed";
}

export interface PreparedProviderRevocation {
  /** Best effort and bounded; never exposes or returns the captured token. */
  revoke(): Promise<ProviderDisconnectResult["remoteRevocation"]>;
  close(): void;
}

/** Consent/authentication port; it deliberately exposes no financial mutation operation. */
export interface ProviderConsentAdapter {
  /** Permanently cancels pending consent and network I/O for this runtime instance. */
  abortPending(): void;
  beginConsent(localAccountId: string): Promise<ProviderConsentStart>;
  completeConsent(
    localAccountId: string,
    callback: ProviderConsentCallback,
  ): Promise<ProviderAuthorizationStatus>;
  cancelConsent(localAccountId: string): void;
  checkAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus>;
  refreshAuthorization(localAccountId: string): Promise<ProviderAuthorizationStatus>;
  prepareDisconnect(localAccountId: string): Promise<PreparedProviderRevocation>;
  disconnect(localAccountId: string): Promise<ProviderDisconnectResult>;
}

export interface ProviderAccountSelection {
  /** Local account identity used exclusively for token lookup and audit correlation. */
  readonly localAccountId: string;
  /** Provider identity returned during account discovery/selection. */
  readonly providerAccountId: string;
}

export interface ProviderReadResult<T = unknown> {
  readonly data: T;
  readonly providerRequestId?: string;
}

/** Read-only provider port. Every call requires one explicit account selection. */
export interface ReadOnlyFinancialProvider {
  /** Permanently cancels pending reads for this runtime instance. */
  abortPending(): void;
  listAccounts(localAccountId: string): Promise<ProviderReadResult>;
  getAccountStatus(selection: ProviderAccountSelection): Promise<ProviderReadResult>;
  listTransactions(
    selection: ProviderAccountSelection,
    filter?: {
      readonly from?: string;
      readonly to?: string;
      readonly cursor?: string;
      readonly pageSize?: number;
    },
  ): Promise<ProviderReadResult>;
  listStatements(selection: ProviderAccountSelection): Promise<ProviderReadResult>;
  getStatement(
    selection: ProviderAccountSelection,
    providerStatementId: string,
  ): Promise<ProviderReadResult>;
}
