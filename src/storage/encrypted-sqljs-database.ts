import { randomBytes } from "node:crypto";
import { stat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

import initSqlJs from "sql.js";
import type {
  BindParams,
  Database,
  QueryExecResult,
  SqlJsStatic,
  SqlValue,
} from "sql.js";

import { regularFileExists, writeFileAtomically } from "./atomic-file";
import {
  decryptDatabaseEnvelope,
  encryptDatabaseEnvelope,
} from "./encrypted-envelope";
import type { KeyProtector } from "./key-protector";
import { validateKeyProtector } from "./key-protector";
import { StorageError, isStorageError } from "./storage-error";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const DEFAULT_MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const KEY_PROTECTION_CONTEXT =
  "amex-local-finance-connector/encrypted-sqljs/data-key/v1";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");

let defaultSqlJsPromise: Promise<SqlJsStatic> | undefined;

export type SqlParameters = BindParams;
export type SqlResult = QueryExecResult;
export type SqlRow = Record<string, SqlValue>;

export interface EncryptedSqlJsDatabaseOptions {
  /** Ciphertext file. Relative paths are normalized immediately. */
  readonly filePath: string;
  /** Required. There is intentionally no plaintext or environment-key fallback. */
  readonly keyProtector: KeyProtector;
  /** Optional initialized sql.js module, useful for tests or custom packaging. */
  readonly sqlJs?: SqlJsStatic | Promise<SqlJsStatic>;
  /** Optional sql.js WASM resolver. */
  readonly locateFile?: (fileName: string) => string;
  /** Refuses unexpectedly large plaintext databases before allocation or save. */
  readonly maxDatabaseBytes?: number;
}

export interface CreateEncryptedSqlJsDatabaseOptions
  extends EncryptedSqlJsDatabaseOptions {
  /** Schema/bootstrap SQL executed before the first encrypted persistence. */
  readonly initialSql?: string | readonly string[];
}

/**
 * In-memory sql.js with envelope encryption at every disk boundary.
 *
 * `run` and `exec` mutate only the in-memory image. Call `save`, or use the
 * default saving behavior of `close`, to atomically publish encrypted bytes.
 */
export class EncryptedSqlJsDatabase {
  public readonly filePath: string;

  private readonly keyProtector: KeyProtector;
  private readonly database: Database;
  private readonly dataKey: Buffer;
  private readonly maxDatabaseBytes: number;
  private persisted: boolean;
  private dirty: boolean;
  private generation = 0;
  private closed = false;
  private closing = false;
  private saveTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;

  private constructor(input: {
    filePath: string;
    keyProtector: KeyProtector;
    database: Database;
    dataKey: Uint8Array;
    maxDatabaseBytes: number;
    persisted: boolean;
    dirty: boolean;
  }) {
    this.filePath = input.filePath;
    this.keyProtector = input.keyProtector;
    this.database = input.database;
    this.dataKey = Buffer.from(input.dataKey);
    this.maxDatabaseBytes = input.maxDatabaseBytes;
    this.persisted = input.persisted;
    this.dirty = input.dirty;
  }

  /** Opens an existing encrypted database. Missing files are never created. */
  public static async open(
    options: EncryptedSqlJsDatabaseOptions,
  ): Promise<EncryptedSqlJsDatabase> {
    const normalized = normalizeOptions(options);
    validateKeyProtector(normalized.keyProtector);
    await assertProtectorAvailable(normalized.keyProtector);

    if (!(await regularFileExists(normalized.filePath))) {
      throw new StorageError(
        "DATABASE_NOT_FOUND",
        "The encrypted database does not exist. Creation must be requested explicitly.",
      );
    }

    const encryptedStats = await stat(normalized.filePath);
    // Envelope overhead is bounded to just over 1 MiB.
    if (encryptedStats.size > normalized.maxDatabaseBytes + 2 * 1024 * 1024) {
      throw new StorageError(
        "DATABASE_TOO_LARGE",
        "The encrypted database exceeds the configured size limit.",
      );
    }

    const envelope = await readFile(normalized.filePath);
    const decrypted = await decryptDatabaseEnvelope(
      envelope,
      normalized.keyProtector.id,
      async (protectedKey) =>
        Promise.resolve(
          normalized.keyProtector.unprotectKey(
            protectedKey,
            KEY_PROTECTION_CONTEXT,
          ),
        ),
    );

    if (decrypted.plaintext.byteLength > normalized.maxDatabaseBytes) {
      decrypted.plaintext.fill(0);
      decrypted.dataKey.fill(0);
      throw new StorageError(
        "DATABASE_TOO_LARGE",
        "The decrypted database exceeds the configured size limit.",
      );
    }
    let database: Database;
    try {
      assertSqliteHeader(decrypted.plaintext);
      const sqlJs = await loadSqlJs(options);
      // sql.js may retain the supplied array as its live backing image. Give
      // it an owned copy, then wipe only the separate crypto output below.
      database = new sqlJs.Database(Uint8Array.from(decrypted.plaintext));
    } catch (error) {
      decrypted.dataKey.fill(0);
      if (isStorageError(error)) {
        throw error;
      }
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "The authenticated payload is not a valid SQLite database.",
        error,
      );
    } finally {
      decrypted.plaintext.fill(0);
    }

    try {
      configureSqlite(database);
    } catch (error) {
      database.close();
      decrypted.dataKey.fill(0);
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "The SQLite database could not be securely initialized.",
        error,
      );
    }

    try {
      return new EncryptedSqlJsDatabase({
        dataKey: decrypted.dataKey,
        database,
        dirty: false,
        filePath: normalized.filePath,
        keyProtector: normalized.keyProtector,
        maxDatabaseBytes: normalized.maxDatabaseBytes,
        persisted: true,
      });
    } catch (error) {
      database.close();
      throw error;
    } finally {
      decrypted.dataKey.fill(0);
    }
  }

  /** Creates and atomically persists a new encrypted database. */
  public static async create(
    options: CreateEncryptedSqlJsDatabaseOptions,
  ): Promise<EncryptedSqlJsDatabase> {
    const normalized = normalizeOptions(options);
    validateKeyProtector(normalized.keyProtector);
    await assertProtectorAvailable(normalized.keyProtector);

    if (await regularFileExists(normalized.filePath)) {
      throw new StorageError(
        "DATABASE_ALREADY_EXISTS",
        "Refusing to overwrite an existing encrypted database.",
      );
    }

    const sqlJs = await loadSqlJs(options);
    const database = new sqlJs.Database();
    try {
      configureSqlite(database);
      // sql.js exports a never-touched database as zero bytes. This no-op
      // persistent pragma materializes a valid SQLite header without adding
      // application schema or reserving a table name.
      database.run("PRAGMA user_version = 0;");
    } catch (error) {
      database.close();
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "A new SQLite database could not be securely initialized.",
        error,
      );
    }
    const dataKey = randomBytes(KEY_BYTES);
    const instance = new EncryptedSqlJsDatabase({
      dataKey,
      database,
      dirty: true,
      filePath: normalized.filePath,
      keyProtector: normalized.keyProtector,
      maxDatabaseBytes: normalized.maxDatabaseBytes,
      persisted: false,
    });
    dataKey.fill(0);

    try {
      if (options.initialSql !== undefined) {
        const statements =
          typeof options.initialSql === "string"
            ? [options.initialSql]
            : options.initialSql;
        for (const sql of statements) {
          instance.exec(sql);
        }
      }
      await instance.save();
      return instance;
    } catch (error) {
      await instance.disposeAfterFailedCreate();
      throw error;
    }
  }

  /** Explicit convenience for installations that intentionally allow first-run creation. */
  public static async openOrCreate(
    options: CreateEncryptedSqlJsDatabaseOptions,
  ): Promise<EncryptedSqlJsDatabase> {
    const filePath = normalizeFilePath(options.filePath);
    if (await regularFileExists(filePath)) {
      return EncryptedSqlJsDatabase.open(options);
    }

    try {
      return await EncryptedSqlJsDatabase.create(options);
    } catch (error) {
      // Another process may have won the no-clobber create race.
      if (isStorageError(error) && error.code === "DATABASE_ALREADY_EXISTS") {
        return EncryptedSqlJsDatabase.open(options);
      }
      throw error;
    }
  }

  public get isDirty(): boolean {
    return this.dirty;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  /** Executes SQL and returns sql.js result sets. Treats all SQL as potentially mutating. */
  public exec(sql: string, params?: SqlParameters): SqlResult[] {
    this.assertOpen();
    assertSql(sql);
    this.markPotentiallyDirty();
    return this.database.exec(sql, params);
  }

  /** Executes a statement and returns SQLite's changed-row count. */
  public run(sql: string, params?: SqlParameters): number {
    this.assertOpen();
    assertSql(sql);
    this.markPotentiallyDirty();
    this.database.run(sql, params);
    const changedRows = this.database.getRowsModified();
    return changedRows;
  }

  /**
   * Executes one read-only SELECT/WITH/EXPLAIN statement and materializes its
   * rows. SQLite `query_only` is also enabled for defense in depth.
   */
  public query<T extends SqlRow = SqlRow>(
    sql: string,
    params?: SqlParameters,
  ): T[] {
    this.assertOpen();
    assertSql(sql);
    assertReadOnlyQuery(sql);

    this.database.run("PRAGMA query_only = ON;");
    let statement: ReturnType<Database["prepare"]> | undefined;
    const rows: T[] = [];
    try {
      statement = this.database.prepare(sql, params);
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement?.free();
      this.database.run("PRAGMA query_only = OFF;");
    }
  }

  /** Encrypts a point-in-time snapshot and atomically persists it. */
  public save(): Promise<void> {
    this.assertOpen();
    return this.enqueueSave();
  }

  /**
   * Saves by default, then releases sql.js memory and zeroes the retained DEK.
   * Pass `{ save: false }` only for an explicit discard operation.
   */
  public close(options: { save?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closing = true;
    this.closePromise = this.finishClose(options.save !== false);
    return this.closePromise;
  }

  private async finishClose(saveChanges: boolean): Promise<void> {
    try {
      if (saveChanges && this.dirty) {
        await this.enqueueSave();
      } else {
        await this.saveTail;
      }
      this.database.close();
      this.dataKey.fill(0);
      this.closed = true;
    } catch (error) {
      this.closing = false;
      this.closePromise = undefined;
      throw error;
    }
  }

  private enqueueSave(): Promise<void> {
    const generation = this.generation;
    const exported = this.database.export();
    if (exported.byteLength > this.maxDatabaseBytes) {
      exported.fill(0);
      return Promise.reject(
        new StorageError(
          "DATABASE_TOO_LARGE",
          "The database exceeds the configured size limit and was not persisted.",
        ),
      );
    }

    const operation = this.saveTail.then(async () => {
      let protectedKey: Uint8Array | undefined;
      let encrypted: Uint8Array | undefined;
      try {
        await assertProtectorAvailable(this.keyProtector);
        protectedKey = await Promise.resolve(
          this.keyProtector.protectKey(
            this.dataKey,
            KEY_PROTECTION_CONTEXT,
          ),
        );
        encrypted = encryptDatabaseEnvelope({
          dataKey: this.dataKey,
          iv: randomBytes(IV_BYTES),
          plaintext: exported,
          protectedKey,
          protectorId: this.keyProtector.id,
        });
        await writeFileAtomically(
          this.filePath,
          encrypted,
          this.persisted ? "replace" : "create",
        );
        this.persisted = true;
        if (this.generation === generation) {
          this.dirty = false;
        }
      } finally {
        exported.fill(0);
        protectedKey?.fill(0);
        encrypted?.fill(0);
      }
    });

    this.saveTail = operation.catch(() => undefined);
    return operation;
  }

  private markPotentiallyDirty(): void {
    this.generation += 1;
    this.dirty = true;
  }

  private assertOpen(): void {
    if (this.closed || this.closing) {
      throw new StorageError(
        "DATABASE_CLOSED",
        this.closed
          ? "The encrypted database is closed."
          : "The encrypted database is closing and no longer accepts operations.",
      );
    }
  }

  private async disposeAfterFailedCreate(): Promise<void> {
    await this.saveTail.catch(() => undefined);
    if (!this.closed) {
      this.database.close();
      this.dataKey.fill(0);
      this.closed = true;
    }
  }
}

function normalizeOptions(options: EncryptedSqlJsDatabaseOptions): {
  filePath: string;
  keyProtector: KeyProtector;
  maxDatabaseBytes: number;
} {
  if (options === null || typeof options !== "object") {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "Encrypted database options are required.",
    );
  }

  const maxDatabaseBytes =
    options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES;
  if (
    !Number.isSafeInteger(maxDatabaseBytes) ||
    maxDatabaseBytes < 4096 ||
    maxDatabaseBytes > 2 * 1024 * 1024 * 1024
  ) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "maxDatabaseBytes must be a safe integer between 4 KiB and 2 GiB.",
    );
  }

  return {
    filePath: normalizeFilePath(options.filePath),
    keyProtector: options.keyProtector,
    maxDatabaseBytes,
  };
}

function normalizeFilePath(filePath: string): string {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "A non-empty encrypted database file path is required.",
    );
  }
  if (filePath.includes("\0")) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "The encrypted database file path contains a null byte.",
    );
  }
  return resolve(filePath);
}

async function loadSqlJs(
  options: EncryptedSqlJsDatabaseOptions,
): Promise<SqlJsStatic> {
  if (options.sqlJs !== undefined) {
    return Promise.resolve(options.sqlJs);
  }

  if (options.locateFile !== undefined) {
    return initSqlJs({ locateFile: options.locateFile });
  }

  defaultSqlJsPromise ??= initSqlJs({ locateFile: defaultLocateFile });
  return defaultSqlJsPromise;
}

function defaultLocateFile(fileName: string): string {
  const packagedAsset = resolve(dirname(__dirname), "vendor", fileName);
  if (existsSync(packagedAsset)) {
    return packagedAsset;
  }
  return resolve(dirname(require.resolve("sql.js")), fileName);
}

function configureSqlite(database: Database): void {
  database.run("PRAGMA foreign_keys = ON;");
  database.run("PRAGMA trusted_schema = OFF;");
  database.run("PRAGMA secure_delete = ON;");
}

async function assertProtectorAvailable(protector: KeyProtector): Promise<void> {
  try {
    await Promise.resolve(protector.assertAvailable());
  } catch (error) {
    if (isStorageError(error)) {
      throw error;
    }
    throw new StorageError(
      "KEY_PROTECTION_UNAVAILABLE",
      "The configured KeyProtector is unavailable; plaintext fallback is prohibited.",
      error,
    );
  }
}

function assertDataKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new StorageError(
      "DECRYPTION_FAILED",
      `The KeyProtector did not return a ${KEY_BYTES}-byte database key.`,
    );
  }
}

function assertSqliteHeader(plaintext: Uint8Array): void {
  if (
    plaintext.byteLength < SQLITE_HEADER.byteLength ||
    !Buffer.from(
      plaintext.buffer,
      plaintext.byteOffset,
      SQLITE_HEADER.byteLength,
    ).equals(SQLITE_HEADER)
  ) {
    plaintext.fill(0);
    throw new StorageError(
      "INVALID_DATABASE_FILE",
      "The authenticated payload does not contain a SQLite database.",
    );
  }
}

function assertSql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "SQL must be a non-empty string.",
    );
  }
}

function assertReadOnlyQuery(sql: string): void {
  if (!/^(?:SELECT|WITH|EXPLAIN)\b/i.test(sql.trimStart())) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "query() accepts only read-only SELECT, WITH, or EXPLAIN statements; use run() or exec() for mutations.",
    );
  }
}
