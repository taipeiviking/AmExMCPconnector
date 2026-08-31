import { StorageError } from "./storage-error";

/**
 * Protects the random data-encryption key (DEK) with an operating-system or
 * hardware-backed facility. Implementations must never return the DEK in
 * plaintext from `protectKey` and must fail closed when protection is not
 * available.
 */
export interface KeyProtector {
  /** Stable identifier persisted in the encrypted database envelope. */
  readonly id: string;

  /** Throws when secure protection cannot currently be used. */
  assertAvailable(): Promise<void> | void;

  /** Returns a newly allocated, opaque protected-key blob. */
  protectKey(key: Uint8Array, context: string): Promise<Uint8Array> | Uint8Array;

  /** Returns a newly allocated plaintext key, or throws on any failure. */
  unprotectKey(
    protectedKey: Uint8Array,
    context: string,
  ): Promise<Uint8Array> | Uint8Array;
}

const KEY_PROTECTOR_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function validateKeyProtector(protector: KeyProtector): void {
  if (
    protector === null ||
    typeof protector !== "object" ||
    typeof protector.id !== "string" ||
    !KEY_PROTECTOR_ID_PATTERN.test(protector.id) ||
    typeof protector.assertAvailable !== "function" ||
    typeof protector.protectKey !== "function" ||
    typeof protector.unprotectKey !== "function"
  ) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "A valid KeyProtector with a stable lowercase id is required; plaintext key storage is not supported.",
    );
  }
}
