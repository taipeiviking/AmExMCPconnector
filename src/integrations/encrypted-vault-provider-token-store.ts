import { createHash } from "node:crypto";
import { SqlJsSecretVault } from "../storage/sqljs-secret-vault";
import { ProviderIntegrationError, type ProviderTokenSet, type ProviderTokenStore } from "./provider-types";

const NAMESPACE = "provider-oauth-v1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

/**
 * Persists per-account OAuth material in the encrypted local database. The
 * supplied persistence hook must publish the encrypted database after each
 * mutation; callers must discard their runtime if that hook fails.
 */
export class EncryptedVaultProviderTokenStore implements ProviderTokenStore {
  public constructor(
    private readonly vault: SqlJsSecretVault,
    private readonly persistEncryptedDatabase: () => Promise<void>,
  ) {}

  public async get(providerId: string, localAccountId: string): Promise<ProviderTokenSet | undefined> {
    const key = tokenKey(providerId, localAccountId);
    const serialized = this.vault.get(NAMESPACE, key);
    if (!serialized) return undefined;
    try {
      return deserializeTokenSet(serialized);
    } finally {
      serialized.fill(0);
    }
  }

  public async put(providerId: string, localAccountId: string, tokens: ProviderTokenSet): Promise<void> {
    const key = tokenKey(providerId, localAccountId);
    const serialized = serializeTokenSet(tokens);
    try {
      this.vault.put(NAMESPACE, key, serialized);
      await this.persistEncryptedDatabase();
    } finally {
      serialized.fill(0);
    }
  }

  public async delete(providerId: string, localAccountId: string): Promise<boolean> {
    const deleted = this.deleteInMemory(providerId, localAccountId);
    if (deleted) await this.persistEncryptedDatabase();
    return deleted;
  }

  /** Used only by a caller-owned encrypted-database transaction. */
  public deleteInMemory(providerId: string, localAccountId: string): boolean {
    return this.vault.delete(NAMESPACE, tokenKey(providerId, localAccountId));
  }
}

function tokenKey(providerId: string, localAccountId: string): string {
  validateId(providerId, "provider ID");
  validateId(localAccountId, "local account ID");
  return createHash("sha256")
    .update(providerId, "utf8")
    .update("\0", "utf8")
    .update(localAccountId, "utf8")
    .digest("hex");
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      `The ${label} is invalid.`,
    );
  }
}

function serializeTokenSet(tokens: ProviderTokenSet): Uint8Array {
  validateTokenSet(tokens);
  return Buffer.from(
    JSON.stringify({
      accessToken: encodeBase64(tokens.accessToken),
      refreshToken:
        tokens.refreshToken === undefined ? undefined : encodeBase64(tokens.refreshToken),
      tokenType: tokens.tokenType,
      scopes: [...tokens.scopes],
      expiresAt: tokens.expiresAt,
    }),
    "utf8",
  );
}

function deserializeTokenSet(serialized: Uint8Array): ProviderTokenSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(serialized));
  } catch (error) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "Stored provider authorization material is invalid.",
      error,
    );
  }
  if (!isTokenRecord(parsed)) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "Stored provider authorization material is invalid.",
    );
  }
  const accessToken = decodeBase64(parsed.accessToken);
  const refreshToken = parsed.refreshToken === undefined ? undefined : decodeBase64(parsed.refreshToken);
  const result: ProviderTokenSet = {
    accessToken,
    tokenType: "Bearer",
    scopes: [...parsed.scopes],
    expiresAt: parsed.expiresAt,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
  validateTokenSet(result);
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "Stored provider authorization material is invalid.",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > 1024 * 1024) {
    decoded.fill(0);
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "Stored provider authorization material is invalid.",
    );
  }
  const result = Uint8Array.from(decoded);
  decoded.fill(0);
  return result;
}

function encodeBase64(value: Uint8Array): string {
  const copy = Buffer.from(value);
  try {
    return copy.toString("base64");
  } finally {
    copy.fill(0);
  }
}

function validateTokenSet(tokens: ProviderTokenSet): void {
  if (
    !(tokens.accessToken instanceof Uint8Array) ||
    tokens.accessToken.byteLength < 1 ||
    tokens.accessToken.byteLength > 1024 * 1024 ||
    (tokens.refreshToken !== undefined &&
      (!(tokens.refreshToken instanceof Uint8Array) ||
        tokens.refreshToken.byteLength < 1 ||
        tokens.refreshToken.byteLength > 1024 * 1024)) ||
    tokens.tokenType !== "Bearer" ||
    !Array.isArray(tokens.scopes) ||
    tokens.scopes.some((scope) => typeof scope !== "string" || scope.length < 1 || scope.length > 256) ||
    !Number.isFinite(Date.parse(tokens.expiresAt))
  ) {
    throw new ProviderIntegrationError(
      "INVALID_PROVIDER_RESPONSE",
      "Provider authorization material is invalid.",
    );
  }
}

interface SerializedTokenRecord {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: "Bearer";
  readonly scopes: readonly string[];
  readonly expiresAt: string;
}

function isTokenRecord(value: unknown): value is SerializedTokenRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    (record.refreshToken === undefined || typeof record.refreshToken === "string") &&
    record.tokenType === "Bearer" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string") &&
    typeof record.expiresAt === "string"
  );
}
