import { EncryptedSqlJsDatabase, type SqlRow } from "./encrypted-sqljs-database";
import { StorageError } from "./storage-error";

const TABLE_NAME = "local_secret_vault";
const DEFAULT_MAX_SECRET_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    namespace TEXT NOT NULL,
    secret_key TEXT NOT NULL,
    secret_value BLOB NOT NULL CHECK(length(secret_value) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, secret_key)
  ) WITHOUT ROWID;
`;

export interface SecretVaultOptions {
  /** Maximum accepted value size. Defaults to 1 MiB. */
  readonly maxSecretBytes?: number;
  /** Injectable UTC clock for deterministic tests. */
  readonly now?: () => Date;
}

export interface SecretVaultEntryMetadata {
  readonly namespace: string;
  readonly key: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Opaque byte-secret storage inside an EncryptedSqlJsDatabase.
 *
 * The vault deliberately has no string convenience API and its list method
 * never selects secret values. Returned secret buffers are caller-owned and
 * should be zeroed as soon as they are no longer needed. Mutations remain
 * in-memory until the caller explicitly invokes `database.save()`.
 */
export class SqlJsSecretVault {
  private readonly maxSecretBytes: number;
  private readonly now: () => Date;

  private constructor(
    private readonly database: EncryptedSqlJsDatabase,
    options: SecretVaultOptions,
  ) {
    this.maxSecretBytes = normalizeMaxSecretBytes(options.maxSecretBytes);
    this.now = options.now ?? (() => new Date());
  }

  /** Creates the vault table in memory; caller decides when to save. */
  public static initialize(
    database: EncryptedSqlJsDatabase,
    options: SecretVaultOptions = {},
  ): SqlJsSecretVault {
    database.exec(CREATE_TABLE_SQL);
    return new SqlJsSecretVault(database, options);
  }

  /** Opens an initialized vault without mutating the database. */
  public static open(
    database: EncryptedSqlJsDatabase,
    options: SecretVaultOptions = {},
  ): SqlJsSecretVault {
    const rows = database.query<SqlRow & { name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1",
      [TABLE_NAME],
    );
    if (rows.length !== 1) {
      throw new StorageError(
        "INVALID_CONFIGURATION",
        "The secret vault has not been initialized in this encrypted database.",
      );
    }
    return new SqlJsSecretVault(database, options);
  }

  /** Inserts or replaces one opaque secret and returns non-secret metadata. */
  public put(
    namespace: string,
    key: string,
    secret: Uint8Array,
  ): SecretVaultEntryMetadata {
    validateIdentifier(namespace, "namespace");
    validateIdentifier(key, "key");
    if (
      !(secret instanceof Uint8Array) ||
      secret.byteLength === 0 ||
      secret.byteLength > this.maxSecretBytes
    ) {
      throw new StorageError(
        "INVALID_CONFIGURATION",
        `Secret values must contain between 1 and ${this.maxSecretBytes} bytes.`,
      );
    }

    const now = this.now().toISOString();
    const transientSecret = Uint8Array.from(secret);
    try {
      this.database.run(
        `
          INSERT INTO ${TABLE_NAME}
            (namespace, secret_key, secret_value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(namespace, secret_key) DO UPDATE SET
            secret_value = excluded.secret_value,
            updated_at = excluded.updated_at
        `,
        [namespace, key, transientSecret, now, now],
      );
    } finally {
      transientSecret.fill(0);
    }

    const metadata = this.getMetadata(namespace, key);
    if (metadata === undefined) {
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "The secret vault could not verify the stored entry.",
      );
    }
    return metadata;
  }

  /** Returns a new caller-owned byte array, or undefined when absent. */
  public get(namespace: string, key: string): Uint8Array | undefined {
    validateIdentifier(namespace, "namespace");
    validateIdentifier(key, "key");
    const rows = this.database.query<SqlRow & { secret_value: Uint8Array }>(
      `SELECT secret_value FROM ${TABLE_NAME} WHERE namespace = ? AND secret_key = ? LIMIT 1`,
      [namespace, key],
    );
    if (rows.length === 0) {
      return undefined;
    }

    const value = rows[0]?.secret_value;
    if (!(value instanceof Uint8Array)) {
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "The secret vault entry has an invalid value type.",
      );
    }

    const result = Uint8Array.from(value);
    value.fill(0);
    return result;
  }

  /** Deletes one secret in memory. Returns whether an entry existed. */
  public delete(namespace: string, key: string): boolean {
    validateIdentifier(namespace, "namespace");
    validateIdentifier(key, "key");
    return (
      this.database.run(
        `DELETE FROM ${TABLE_NAME} WHERE namespace = ? AND secret_key = ?`,
        [namespace, key],
      ) > 0
    );
  }

  /** Lists non-secret metadata only, optionally scoped to one namespace. */
  public listMetadata(namespace?: string): SecretVaultEntryMetadata[] {
    let rows: RawMetadataRow[];
    if (namespace === undefined) {
      rows = this.database.query<RawMetadataRow>(`
        SELECT
          namespace,
          secret_key,
          length(secret_value) AS byte_length,
          created_at,
          updated_at
        FROM ${TABLE_NAME}
        ORDER BY namespace, secret_key
      `);
    } else {
      validateIdentifier(namespace, "namespace");
      rows = this.database.query<RawMetadataRow>(
        `
          SELECT
            namespace,
            secret_key,
            length(secret_value) AS byte_length,
            created_at,
            updated_at
          FROM ${TABLE_NAME}
          WHERE namespace = ?
          ORDER BY secret_key
        `,
        [namespace],
      );
    }
    return rows.map(toMetadata);
  }

  private getMetadata(
    namespace: string,
    key: string,
  ): SecretVaultEntryMetadata | undefined {
    const rows = this.database.query<RawMetadataRow>(
      `
        SELECT
          namespace,
          secret_key,
          length(secret_value) AS byte_length,
          created_at,
          updated_at
        FROM ${TABLE_NAME}
        WHERE namespace = ? AND secret_key = ?
        LIMIT 1
      `,
      [namespace, key],
    );
    return rows[0] === undefined ? undefined : toMetadata(rows[0]);
  }
}

interface RawMetadataRow extends SqlRow {
  namespace: string;
  secret_key: string;
  byte_length: number;
  created_at: string;
  updated_at: string;
}

function toMetadata(row: RawMetadataRow): SecretVaultEntryMetadata {
  if (
    typeof row.namespace !== "string" ||
    typeof row.secret_key !== "string" ||
    typeof row.byte_length !== "number" ||
    !Number.isSafeInteger(row.byte_length) ||
    row.byte_length < 1 ||
    typeof row.created_at !== "string" ||
    typeof row.updated_at !== "string"
  ) {
    throw new StorageError(
      "INVALID_DATABASE_FILE",
      "The secret vault contains invalid metadata.",
    );
  }
  return {
    byteLength: row.byte_length,
    createdAt: row.created_at,
    key: row.secret_key,
    namespace: row.namespace,
    updatedAt: row.updated_at,
  };
}

function validateIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      `Secret vault ${label} must be 1-${MAX_IDENTIFIER_LENGTH} characters and use only letters, numbers, '.', '_', ':', '@', '/', or '-'.`,
    );
  }
}

function normalizeMaxSecretBytes(value: number | undefined): number {
  const normalized = value ?? DEFAULT_MAX_SECRET_BYTES;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > 16 * 1024 * 1024
  ) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "maxSecretBytes must be a safe integer between 1 byte and 16 MiB.",
    );
  }
  return normalized;
}
