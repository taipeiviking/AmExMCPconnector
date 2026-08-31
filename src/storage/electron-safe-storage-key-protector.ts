import { createHash, timingSafeEqual } from "node:crypto";

import type { KeyProtector } from "./key-protector";
import { StorageError, isStorageError } from "./storage-error";

/** The subset of Electron's `safeStorage` API used by this adapter. */
export interface ElectronSafeStorageLike {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}

const PAYLOAD_PREFIX = "ALFC-DEK-V1";
const KEY_BYTES = 32;

/**
 * Uses Electron `safeStorage` (DPAPI on Windows) to wrap database DEKs.
 * Instantiate this only in Electron's main process after `app.whenReady()`.
 */
export class ElectronSafeStorageKeyProtector implements KeyProtector {
  public readonly id = "electron.safestorage.v1";

  public constructor(private readonly safeStorage: ElectronSafeStorageLike) {
    if (
      safeStorage === null ||
      typeof safeStorage !== "object" ||
      typeof safeStorage.isEncryptionAvailable !== "function" ||
      typeof safeStorage.encryptString !== "function" ||
      typeof safeStorage.decryptString !== "function"
    ) {
      throw new StorageError(
        "INVALID_CONFIGURATION",
        "Electron safeStorage was not supplied or does not expose the required API.",
      );
    }
  }

  public assertAvailable(): void {
    let available: boolean;
    try {
      available = this.safeStorage.isEncryptionAvailable();
    } catch (error) {
      throw new StorageError(
        "KEY_PROTECTION_UNAVAILABLE",
        "Electron safeStorage could not determine whether encryption is available.",
        error,
      );
    }

    if (!available) {
      throw new StorageError(
        "KEY_PROTECTION_UNAVAILABLE",
        "Electron safeStorage encryption is unavailable. Wait for app readiness and do not fall back to plaintext storage.",
      );
    }

    if (process.platform === "linux" && this.selectedBackend() === "basic_text") {
      throw new StorageError(
        "KEY_PROTECTION_UNAVAILABLE",
        "Electron safeStorage selected the insecure Linux basic_text backend; database access is refused.",
      );
    }
  }

  public protectKey(key: Uint8Array, context: string): Uint8Array {
    this.assertAvailable();
    assertDataKey(key);

    const contextHash = hashContext(context);
    const plaintext = `${PAYLOAD_PREFIX}.${contextHash}.${Buffer.from(key).toString("base64")}`;

    try {
      return Buffer.from(this.safeStorage.encryptString(plaintext));
    } catch (error) {
      throw new StorageError(
        "KEY_PROTECTION_UNAVAILABLE",
        "Electron safeStorage failed to protect the database key.",
        error,
      );
    }
  }

  public unprotectKey(protectedKey: Uint8Array, context: string): Uint8Array {
    this.assertAvailable();

    let plaintext: string;
    try {
      plaintext = this.safeStorage.decryptString(Buffer.from(protectedKey));
    } catch (error) {
      throw new StorageError(
        "DECRYPTION_FAILED",
        "The operating-system key store could not unlock the database key.",
        error,
      );
    }

    try {
      const parts = plaintext.split(".");
      if (parts.length !== 3 || parts[0] !== PAYLOAD_PREFIX) {
        throw new StorageError(
          "DECRYPTION_FAILED",
          "The protected database key payload is invalid.",
        );
      }

      const actualContextHash = parts[1];
      const encodedKey = parts[2];
      if (actualContextHash === undefined || encodedKey === undefined) {
        throw new StorageError(
          "DECRYPTION_FAILED",
          "The protected database key payload is incomplete.",
        );
      }

      const expectedContextHash = hashContext(context);
      if (!equalText(actualContextHash, expectedContextHash)) {
        throw new StorageError(
          "DECRYPTION_FAILED",
          "The protected database key belongs to a different storage context.",
        );
      }

      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) {
        throw new StorageError(
          "DECRYPTION_FAILED",
          "The protected database key encoding is invalid.",
        );
      }

      const key = Buffer.from(encodedKey, "base64");
      assertDataKey(key);
      return key;
    } catch (error) {
      if (isStorageError(error)) {
        throw error;
      }
      throw new StorageError(
        "DECRYPTION_FAILED",
        "The protected database key payload could not be decoded.",
        error,
      );
    }
  }

  private selectedBackend(): string | undefined {
    try {
      return this.safeStorage.getSelectedStorageBackend?.();
    } catch (error) {
      throw new StorageError(
        "KEY_PROTECTION_UNAVAILABLE",
        "Electron safeStorage could not report its selected key-store backend.",
        error,
      );
    }
  }
}

/**
 * Resolves Electron lazily so importing the storage package in plain Node.js
 * does not load Electron. Calling this outside Electron's main process fails.
 */
export function createElectronSafeStorageKeyProtector(): ElectronSafeStorageKeyProtector {
  if (process.versions.electron === undefined) {
    throw new StorageError(
      "KEY_PROTECTION_UNAVAILABLE",
      "Electron safeStorage is only available in the Electron main process.",
    );
  }

  let electronModule: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    electronModule = require("electron") as unknown;
  } catch (error) {
    throw new StorageError(
      "KEY_PROTECTION_UNAVAILABLE",
      "Electron is unavailable; an explicit secure KeyProtector is required.",
      error,
    );
  }

  if (
    electronModule === null ||
    typeof electronModule !== "object" ||
    !("safeStorage" in electronModule)
  ) {
    throw new StorageError(
      "KEY_PROTECTION_UNAVAILABLE",
      "Electron safeStorage is only available in the Electron main process.",
    );
  }

  const safeStorage = (electronModule as { safeStorage?: unknown }).safeStorage;
  return new ElectronSafeStorageKeyProtector(safeStorage as ElectronSafeStorageLike);
}

function hashContext(context: string): string {
  if (typeof context !== "string" || context.length === 0) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "Key-protection context must be a non-empty string.",
    );
  }
  return createHash("sha256").update(context, "utf8").digest("base64url");
}

function assertDataKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new StorageError(
      "DECRYPTION_FAILED",
      `Database data-encryption keys must be exactly ${KEY_BYTES} bytes.`,
    );
  }
}

function equalText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
