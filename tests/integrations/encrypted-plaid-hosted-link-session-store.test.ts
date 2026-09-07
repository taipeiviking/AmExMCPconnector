import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedPlaidHostedLinkSessionStore } from "../../src/integrations/encrypted-plaid-hosted-link-session-store";
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

describe("encrypted Plaid Hosted Link recovery store", () => {
  it("round-trips only new-session recovery state without plaintext on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amex-plaid-recovery-"));
    createdDirectories.push(directory);
    const filePath = join(directory, "finance.db.enc");
    const protector = new TestKeyProtector();
    const database = await EncryptedSqlJsDatabase.create({ filePath, keyProtector: protector });
    const store = new EncryptedPlaidHostedLinkSessionStore(
      SqlJsSecretVault.initialize(database),
      async () => await database.save(),
    );
    const linkToken = Buffer.from("LINK_TOKEN_MUST_STAY_ENCRYPTED", "utf8");
    await store.put({
      grantKind: "new",
      environment: "sandbox",
      localAccountId: "local-personal-card",
      linkToken,
      authorizationUrl: "https://secure.plaid.com/hl/PRIVATE_SESSION_PATH",
      createdAt: "2026-09-07T00:00:00.000Z",
      expiresAt: "2026-09-07T00:30:00.000Z",
    });
    linkToken.fill(0);
    await database.close();

    const disk = await readFile(filePath);
    expect(disk.includes(Buffer.from("LINK_TOKEN_MUST_STAY_ENCRYPTED", "utf8"))).toBe(false);
    expect(disk.includes(Buffer.from("PRIVATE_SESSION_PATH", "utf8"))).toBe(false);
    expect(disk.includes(Buffer.from("local-personal-card", "utf8"))).toBe(false);

    const reopened = await EncryptedSqlJsDatabase.open({ filePath, keyProtector: protector });
    const reopenedStore = new EncryptedPlaidHostedLinkSessionStore(
      SqlJsSecretVault.open(reopened),
      async () => await reopened.save(),
    );
    const recovered = await reopenedStore.get("local-personal-card");
    expect(recovered).toMatchObject({
      grantKind: "new",
      environment: "sandbox",
      localAccountId: "local-personal-card",
      authorizationUrl: "https://secure.plaid.com/hl/PRIVATE_SESSION_PATH",
      createdAt: "2026-09-07T00:00:00.000Z",
      expiresAt: "2026-09-07T00:30:00.000Z",
    });
    expect(Buffer.from(recovered?.linkToken ?? []).toString("utf8"))
      .toBe("LINK_TOKEN_MUST_STAY_ENCRYPTED");
    recovered?.linkToken.fill(0);
    expect(await reopenedStore.delete("local-personal-card")).toBe(true);
    expect(await reopenedStore.get("local-personal-card")).toBeUndefined();
    await reopened.close();
  });
});

class TestKeyProtector implements KeyProtector {
  public readonly id = "test.plaid-recovery-protector.v1";
  private readonly master = Buffer.alloc(32, 0x6b);

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
