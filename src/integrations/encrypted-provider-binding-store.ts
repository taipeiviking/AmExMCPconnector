import { createHash } from "node:crypto";
import { SqlJsSecretVault } from "../storage/sqljs-secret-vault";
import { ProviderIntegrationError } from "./provider-types";

const NAMESPACE = "provider-account-binding-v1";
const REVERSE_NAMESPACE = "provider-account-binding-owner-v1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;

export interface EncryptedProviderBinding {
  readonly providerAccountId: string;
  readonly lastFour?: string;
}

/** Stores provider identifiers separately from financial-domain account records. */
export class EncryptedProviderBindingStore {
  public constructor(
    private readonly vault: SqlJsSecretVault,
    private readonly persistEncryptedDatabase: () => Promise<void>,
  ) {}

  public async get(providerId: string, localAccountId: string): Promise<EncryptedProviderBinding | undefined> {
    return this.getInMemory(providerId, localAccountId);
  }

  private getInMemory(providerId: string, localAccountId: string): EncryptedProviderBinding | undefined {
    const serialized = this.vault.get(NAMESPACE, bindingKey(providerId, localAccountId));
    if (!serialized) return undefined;
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(serialized)) as unknown;
      if (!isBinding(parsed)) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The encrypted provider account binding is invalid.",
        );
      }
      return { providerAccountId: parsed.providerAccountId, ...(parsed.lastFour ? { lastFour: parsed.lastFour } : {}) };
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The encrypted provider account binding is invalid.",
        error,
      );
    } finally {
      serialized.fill(0);
    }
  }

  public async put(
    providerId: string,
    localAccountId: string,
    binding: EncryptedProviderBinding,
  ): Promise<void> {
    validateId(providerId, "provider ID");
    validateId(localAccountId, "local account ID");
    validateId(binding.providerAccountId, "provider account ID");
    if (binding.lastFour !== undefined && !/^\d{4}$/u.test(binding.lastFour)) {
      throw new ProviderIntegrationError("INVALID_PROVIDER_RESPONSE", "The provider account mask is invalid.");
    }
    const owner = this.reverseOwner(providerId, binding.providerAccountId);
    if (owner !== undefined && owner !== localAccountId) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "That provider account is already bound to a different local account.",
      );
    }
    const existing = this.getInMemory(providerId, localAccountId);
    if (existing !== undefined && existing.providerAccountId !== binding.providerAccountId) {
      const existingOwner = this.reverseOwner(providerId, existing.providerAccountId);
      if (existingOwner !== undefined && existingOwner !== localAccountId) {
        throw new ProviderIntegrationError(
          "INVALID_PROVIDER_RESPONSE",
          "The encrypted provider account binding index is inconsistent.",
        );
      }
      this.vault.delete(REVERSE_NAMESPACE, reverseBindingKey(providerId, existing.providerAccountId));
    }
    const serialized = Buffer.from(JSON.stringify(binding), "utf8");
    const serializedOwner = Buffer.from(localAccountId, "utf8");
    try {
      this.vault.put(NAMESPACE, bindingKey(providerId, localAccountId), serialized);
      this.vault.put(REVERSE_NAMESPACE, reverseBindingKey(providerId, binding.providerAccountId), serializedOwner);
      await this.persistEncryptedDatabase();
    } finally {
      serialized.fill(0);
      serializedOwner.fill(0);
    }
  }

  public async delete(providerId: string, localAccountId: string): Promise<boolean> {
    const deleted = this.deleteInMemory(providerId, localAccountId);
    if (deleted) await this.persistEncryptedDatabase();
    return deleted;
  }

  /** Used only by a caller-owned encrypted-database transaction. */
  public deleteInMemory(providerId: string, localAccountId: string): boolean {
    const existing = this.getInMemory(providerId, localAccountId);
    const deleted = this.vault.delete(NAMESPACE, bindingKey(providerId, localAccountId));
    if (existing === undefined) return deleted;
    const owner = this.reverseOwner(providerId, existing.providerAccountId);
    if (owner !== undefined && owner !== localAccountId) {
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The encrypted provider account binding index is inconsistent.",
      );
    }
    const reverseDeleted = this.vault.delete(
      REVERSE_NAMESPACE,
      reverseBindingKey(providerId, existing.providerAccountId),
    );
    return deleted || reverseDeleted;
  }

  private reverseOwner(providerId: string, providerAccountId: string): string | undefined {
    const serialized = this.vault.get(REVERSE_NAMESPACE, reverseBindingKey(providerId, providerAccountId));
    if (!serialized) return undefined;
    try {
      const owner = new TextDecoder("utf-8", { fatal: true }).decode(serialized);
      validateId(owner, "local account ID");
      return owner;
    } catch (error) {
      if (error instanceof ProviderIntegrationError) throw error;
      throw new ProviderIntegrationError(
        "INVALID_PROVIDER_RESPONSE",
        "The encrypted provider account binding index is invalid.",
        error,
      );
    } finally {
      serialized.fill(0);
    }
  }
}

function bindingKey(providerId: string, localAccountId: string): string {
  validateId(providerId, "provider ID");
  validateId(localAccountId, "local account ID");
  return createHash("sha256")
    .update(providerId, "utf8")
    .update("\0", "utf8")
    .update(localAccountId, "utf8")
    .digest("hex");
}

function reverseBindingKey(providerId: string, providerAccountId: string): string {
  validateId(providerId, "provider ID");
  validateId(providerAccountId, "provider account ID");
  return createHash("sha256")
    .update(providerId, "utf8")
    .update("\0provider-account\0", "utf8")
    .update(providerAccountId, "utf8")
    .digest("hex");
}

function validateId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", `The ${label} is invalid.`);
  }
}

function isBinding(value: unknown): value is EncryptedProviderBinding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) => key === "providerAccountId" || key === "lastFour") &&
    typeof record.providerAccountId === "string" &&
    ID_PATTERN.test(record.providerAccountId) &&
    (record.lastFour === undefined || (typeof record.lastFour === "string" && /^\d{4}$/u.test(record.lastFour)))
  );
}
