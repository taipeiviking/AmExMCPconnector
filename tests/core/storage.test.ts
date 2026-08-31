import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ElectronSafeStorageKeyProtector,
  EncryptedSqlJsDatabase,
  SqlJsSecretVault,
  StorageError,
  type KeyProtector,
} from "../../src/storage";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    const resolvedDirectory = resolve(directory);
    const resolvedTemp = resolve(tmpdir());
    if (!resolvedDirectory.startsWith(`${resolvedTemp}\\`) && !resolvedDirectory.startsWith(`${resolvedTemp}/`)) {
      throw new Error(`Refusing to remove non-temporary test directory: ${resolvedDirectory}`);
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("EncryptedSqlJsDatabase", () => {
  it("persists only an authenticated encrypted envelope and reopens it", async () => {
    const filePath = await tempFile("finance.db.enc");
    const protector = new TestKeyProtector();
    const database = await EncryptedSqlJsDatabase.create({
      filePath,
      keyProtector: protector,
      initialSql: "CREATE TABLE records(value TEXT NOT NULL);",
    });
    database.run("INSERT INTO records(value) VALUES (?)", ["PLAINTEXT_MARKER_NEVER_ON_DISK"]);
    await database.close();

    const diskBytes = await readFile(filePath);
    expect(diskBytes.subarray(0, 8).toString("ascii")).toBe("ALFCDBE1");
    expect(diskBytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(diskBytes.includes(Buffer.from("PLAINTEXT_MARKER_NEVER_ON_DISK"))).toBe(false);

    const reopened = await EncryptedSqlJsDatabase.open({ filePath, keyProtector: protector });
    expect(reopened.query<{ value: string } & Record<string, string>>("SELECT value FROM records")).toEqual([
      { value: "PLAINTEXT_MARKER_NEVER_ON_DISK" },
    ]);
    await reopened.close();
  });

  it("fails closed when no valid secure protector is supplied", async () => {
    const filePath = await tempFile("missing-protector.db.enc");
    await expect(
      EncryptedSqlJsDatabase.create({ filePath, keyProtector: undefined as unknown as KeyProtector }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      EncryptedSqlJsDatabase.create({
        filePath,
        keyProtector: {
          id: "unavailable.test",
          assertAvailable: () => {
            throw new Error("OS key store locked");
          },
          protectKey: (key) => Uint8Array.from(key),
          unprotectKey: (key) => Uint8Array.from(key),
        },
      }),
    ).rejects.toMatchObject({ code: "KEY_PROTECTION_UNAVAILABLE" });
  });

  it("detects ciphertext tampering and refuses to overwrite existing databases", async () => {
    const filePath = await tempFile("tamper.db.enc");
    const protector = new TestKeyProtector();
    const database = await EncryptedSqlJsDatabase.create({ filePath, keyProtector: protector });
    await database.close();
    await expect(EncryptedSqlJsDatabase.create({ filePath, keyProtector: protector })).rejects.toMatchObject({
      code: "DATABASE_ALREADY_EXISTS",
    });

    const tampered = await readFile(filePath);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    await writeFile(filePath, tampered);
    await expect(EncryptedSqlJsDatabase.open({ filePath, keyProtector: protector })).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
    });
  });

  it("serializes concurrent saves without losing a later in-memory generation", async () => {
    const filePath = await tempFile("concurrent.db.enc");
    const protector = new TestKeyProtector();
    const database = await EncryptedSqlJsDatabase.create({
      filePath,
      keyProtector: protector,
      initialSql: "CREATE TABLE records(value TEXT NOT NULL);",
    });
    database.run("INSERT INTO records(value) VALUES ('first')");
    const firstSave = database.save();
    database.run("INSERT INTO records(value) VALUES ('second')");
    const secondSave = database.save();
    await Promise.all([firstSave, secondSave]);
    await database.close();

    const reopened = await EncryptedSqlJsDatabase.open({ filePath, keyProtector: protector });
    expect(reopened.query<{ value: string } & Record<string, string>>("SELECT value FROM records ORDER BY value")).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
    expect(() => reopened.query("DELETE FROM records")).toThrow(StorageError);
    await reopened.close();
  });

  it("stores opaque tokens in the encrypted database and lists metadata without values", async () => {
    const filePath = await tempFile("vault.db.enc");
    const protector = new TestKeyProtector();
    const database = await EncryptedSqlJsDatabase.create({ filePath, keyProtector: protector });
    const vault = SqlJsSecretVault.initialize(database, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const token = Buffer.from("OAUTH_TOKEN_MARKER_NOT_PLAINTEXT", "utf8");
    vault.put("oauth", "demo-account", token);
    expect(vault.listMetadata()).toEqual([
      {
        namespace: "oauth",
        key: "demo-account",
        byteLength: token.length,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(Buffer.from(vault.get("oauth", "demo-account") ?? [])).toEqual(token);
    await database.close();
    expect((await readFile(filePath)).includes(token)).toBe(false);

    const reopened = await EncryptedSqlJsDatabase.open({ filePath, keyProtector: protector });
    const reopenedVault = SqlJsSecretVault.open(reopened);
    expect(Buffer.from(reopenedVault.get("oauth", "demo-account") ?? []).toString("utf8")).toBe(
      "OAUTH_TOKEN_MARKER_NOT_PLAINTEXT",
    );
    expect(reopenedVault.delete("oauth", "demo-account")).toBe(true);
    await reopened.close();
  });
});

describe("ElectronSafeStorageKeyProtector", () => {
  it("binds wrapped keys to their context and refuses unavailable encryption", () => {
    const adapter = new ElectronSafeStorageKeyProtector({
      isEncryptionAvailable: () => true,
      encryptString: (plainText) => Buffer.from(plainText, "utf8"),
      decryptString: (encrypted) => encrypted.toString("utf8"),
    });
    const key = Buffer.alloc(32, 0x7c);
    const wrapped = adapter.protectKey(key, "context-a");
    expect(Buffer.from(adapter.unprotectKey(wrapped, "context-a"))).toEqual(key);
    expect(() => adapter.unprotectKey(wrapped, "context-b")).toThrow(StorageError);

    const unavailable = new ElectronSafeStorageKeyProtector({
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    });
    expect(() => unavailable.assertAvailable()).toThrowError(/unavailable/iu);
  });
});

class TestKeyProtector implements KeyProtector {
  public readonly id = "test.aes.keyprotector.v1";
  readonly #master = Buffer.alloc(32, 0x33);

  public assertAvailable(): void {}

  public protectKey(key: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#master, iv);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  public unprotectKey(protectedKey: Uint8Array): Uint8Array {
    const bytes = Buffer.from(protectedKey);
    const decipher = createDecipheriv("aes-256-gcm", this.#master, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}

async function tempFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amex-finance-core-"));
  createdDirectories.push(directory);
  return join(directory, name);
}
