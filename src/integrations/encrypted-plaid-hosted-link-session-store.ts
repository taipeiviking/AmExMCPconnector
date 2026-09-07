import { createHash } from "node:crypto";
import { z } from "zod";
import { SqlJsSecretVault } from "../storage/sqljs-secret-vault";
import type { PlaidEnvironment } from "./plaid-api-client";
import { ProviderIntegrationError } from "./provider-types";

const NAMESPACE = "plaid-hosted-link-pending-v1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

const storedSessionSchema = z.object({
  schemaVersion: z.literal(1),
  providerId: z.literal("plaid"),
  grantKind: z.literal("new"),
  environment: z.enum(["sandbox", "production"]),
  localAccountId: z.string().min(1).max(512).regex(ID_PATTERN),
  linkToken: z.string().min(4).max(16 * 1024),
  authorizationUrl: z.string().url().max(8192),
  createdAt: z.string().min(1).max(128),
  expiresAt: z.string().min(1).max(128),
}).strict();

export interface PlaidPendingHostedLinkSession {
  readonly grantKind: "new";
  readonly environment: PlaidEnvironment;
  readonly localAccountId: string;
  /** Caller-owned secret bytes. */
  readonly linkToken: Uint8Array;
  readonly authorizationUrl: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PlaidHostedLinkSessionStore {
  /** Returns caller-owned secret bytes. */
  get(localAccountId: string): Promise<PlaidPendingHostedLinkSession | undefined>;
  put(session: PlaidPendingHostedLinkSession): Promise<void>;
  delete(localAccountId: string): Promise<boolean>;
}

/**
 * Crash-recovery state for a not-yet-exchanged new Hosted Link grant. The
 * complete record lives inside the existing encrypted database; filenames,
 * preferences, and logs receive only a keyed hash and never the Link token.
 */
export class EncryptedPlaidHostedLinkSessionStore implements PlaidHostedLinkSessionStore {
  public constructor(
    private readonly vault: SqlJsSecretVault,
    private readonly persistEncryptedDatabase: () => Promise<void>,
  ) {}

  public async get(localAccountId: string): Promise<PlaidPendingHostedLinkSession | undefined> {
    const serialized = this.vault.get(NAMESPACE, sessionKey(localAccountId));
    if (serialized === undefined) return undefined;
    try {
      return deserializeSession(serialized, localAccountId);
    } finally {
      serialized.fill(0);
    }
  }

  public async put(session: PlaidPendingHostedLinkSession): Promise<void> {
    validateSession(session);
    const serialized = serializeSession(session);
    try {
      this.vault.put(NAMESPACE, sessionKey(session.localAccountId), serialized);
      await this.persistEncryptedDatabase();
    } finally {
      serialized.fill(0);
    }
  }

  public async delete(localAccountId: string): Promise<boolean> {
    const deleted = this.vault.delete(NAMESPACE, sessionKey(localAccountId));
    if (deleted) await this.persistEncryptedDatabase();
    return deleted;
  }
}

function sessionKey(localAccountId: string): string {
  validateId(localAccountId);
  return createHash("sha256")
    .update("plaid", "utf8")
    .update("\0", "utf8")
    .update(localAccountId, "utf8")
    .digest("hex");
}

function serializeSession(session: PlaidPendingHostedLinkSession): Uint8Array {
  validateSession(session);
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    providerId: "plaid",
    grantKind: "new",
    environment: session.environment,
    localAccountId: session.localAccountId,
    linkToken: encodeBase64(session.linkToken),
    authorizationUrl: session.authorizationUrl,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  }), "utf8");
}

function deserializeSession(
  serialized: Uint8Array,
  expectedLocalAccountId: string,
): PlaidPendingHostedLinkSession {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(serialized));
  } catch (error) {
    throw invalidStoredSession(error);
  }
  const parsed = storedSessionSchema.safeParse(value);
  if (!parsed.success || parsed.data.localAccountId !== expectedLocalAccountId) {
    throw invalidStoredSession();
  }
  const linkToken = decodeBase64(parsed.data.linkToken);
  const session: PlaidPendingHostedLinkSession = {
    grantKind: "new",
    environment: parsed.data.environment,
    localAccountId: parsed.data.localAccountId,
    linkToken,
    authorizationUrl: parsed.data.authorizationUrl,
    createdAt: parsed.data.createdAt,
    expiresAt: parsed.data.expiresAt,
  };
  try {
    validateSession(session);
    return session;
  } catch (error) {
    linkToken.fill(0);
    throw error;
  }
}

function validateSession(session: PlaidPendingHostedLinkSession): void {
  validateId(session.localAccountId);
  if (
    session.grantKind !== "new" ||
    (session.environment !== "sandbox" && session.environment !== "production") ||
    !(session.linkToken instanceof Uint8Array) ||
    session.linkToken.byteLength < 1 ||
    session.linkToken.byteLength > 8192 ||
    !isCanonicalInstant(session.createdAt) ||
    !isCanonicalInstant(session.expiresAt) ||
    Date.parse(session.expiresAt) <= Date.parse(session.createdAt)
  ) {
    throw invalidStoredSession();
  }
  let url: URL;
  try {
    url = new URL(session.authorizationUrl);
  } catch (error) {
    throw invalidStoredSession(error);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "secure.plaid.com" ||
    !url.pathname.startsWith("/hl/") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw invalidStoredSession();
  }
}

function validateId(localAccountId: string): void {
  if (typeof localAccountId !== "string" || !ID_PATTERN.test(localAccountId)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The local account ID is invalid.");
  }
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function encodeBase64(value: Uint8Array): string {
  const copy = Buffer.from(value);
  try {
    return copy.toString("base64");
  } finally {
    copy.fill(0);
  }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw invalidStoredSession();
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength < 1 || decoded.byteLength > 8192) {
    decoded.fill(0);
    throw invalidStoredSession();
  }
  const result = Uint8Array.from(decoded);
  decoded.fill(0);
  return result;
}

function invalidStoredSession(cause?: unknown): ProviderIntegrationError {
  return new ProviderIntegrationError(
    "INVALID_PROVIDER_RESPONSE",
    "Stored Plaid Hosted Link recovery state is invalid.",
    cause,
  );
}
