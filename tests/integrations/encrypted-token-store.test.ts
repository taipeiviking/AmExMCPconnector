import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedProviderBindingStore } from "../../src/integrations/encrypted-provider-binding-store";
import { EncryptedVaultProviderTokenStore } from "../../src/integrations/encrypted-vault-provider-token-store";
import { EncryptedSqlJsDatabase, SqlJsSecretVault, type KeyProtector } from "../../src/storage";

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

describe("encrypted provider token store", () => {
  it("persists tokens under separate provider/account keys without plaintext on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-token-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "tokens.db.enc");
    const database = await EncryptedSqlJsDatabase.create({
      filePath,
      keyProtector: new TestKeyProtector(),
    });
    const vault = SqlJsSecretVault.initialize(database);
    const store = new EncryptedVaultProviderTokenStore(vault, async () => await database.save());
    await store.put("provider-a", "account-a", {
      accessToken: Buffer.from("ACCESS_TOKEN_ACCOUNT_A", "utf8"),
      refreshToken: Buffer.from("REFRESH_TOKEN_ACCOUNT_A", "utf8"),
      tokenType: "Bearer",
      scopes: ["transactions.read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    await store.put("provider-a", "account-b", {
      accessToken: Buffer.from("ACCESS_TOKEN_ACCOUNT_B", "utf8"),
      tokenType: "Bearer",
      scopes: ["transactions.read"],
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    const accountA = await store.get("provider-a", "account-a");
    const accountB = await store.get("provider-a", "account-b");
    expect(Buffer.from(accountA?.accessToken ?? []).toString("utf8")).toBe("ACCESS_TOKEN_ACCOUNT_A");
    expect(Buffer.from(accountB?.accessToken ?? []).toString("utf8")).toBe("ACCESS_TOKEN_ACCOUNT_B");
    expect(await store.get("provider-b", "account-a")).toBeUndefined();
    accountA?.accessToken.fill(0);
    accountA?.refreshToken?.fill(0);
    accountB?.accessToken.fill(0);

    await database.close();
    const disk = await readFile(filePath);
    expect(disk.includes(Buffer.from("ACCESS_TOKEN_ACCOUNT_A", "utf8"))).toBe(false);
    expect(disk.includes(Buffer.from("REFRESH_TOKEN_ACCOUNT_A", "utf8"))).toBe(false);
  });

  it("keeps exact bindings encrypted, isolated, and one-to-one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-binding-store-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "bindings.db.enc");
    const database = await EncryptedSqlJsDatabase.create({
      filePath,
      keyProtector: new TestKeyProtector(),
    });
    const vault = SqlJsSecretVault.initialize(database);
    const store = new EncryptedProviderBindingStore(vault, async () => await database.save());

    await store.put("provider-a", "local-account-a", {
      providerAccountId: "provider-account-4242",
      lastFour: "4242",
    });
    await expect(store.put("provider-a", "local-account-b", {
      providerAccountId: "provider-account-4242",
      lastFour: "4242",
    })).rejects.toMatchObject({ code: "INVALID_PROVIDER_RESPONSE" });
    await store.put("provider-a", "local-account-b", {
      providerAccountId: "provider-account-5151",
      lastFour: "5151",
    });

    await expect(store.get("provider-a", "local-account-a")).resolves.toEqual({
      providerAccountId: "provider-account-4242",
      lastFour: "4242",
    });
    await expect(store.get("provider-a", "local-account-b")).resolves.toEqual({
      providerAccountId: "provider-account-5151",
      lastFour: "5151",
    });
    await expect(store.get("provider-b", "local-account-a")).resolves.toBeUndefined();

    await database.close();
    const disk = await readFile(filePath);
    expect(disk.includes(Buffer.from("provider-account-4242", "utf8"))).toBe(false);
    expect(disk.includes(Buffer.from("provider-account-5151", "utf8"))).toBe(false);
  });
});

class TestKeyProtector implements KeyProtector {
  public readonly id = "test.token-store-protector.v1";
  private readonly master = Buffer.alloc(32, 0x5a);

  public assertAvailable(): void {}

  public protectKey(key: Uint8Array): Uint8Array {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, iv);
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }

  public unprotectKey(protectedKey: Uint8Array): Uint8Array {
    const bytes = Buffer.from(protectedKey);
    const decipher = createDecipheriv("aes-256-gcm", this.master, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  }
}
