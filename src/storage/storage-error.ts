export type StorageErrorCode =
  | "INVALID_CONFIGURATION"
  | "KEY_PROTECTION_UNAVAILABLE"
  | "DATABASE_NOT_FOUND"
  | "DATABASE_ALREADY_EXISTS"
  | "INVALID_DATABASE_FILE"
  | "KEY_PROTECTOR_MISMATCH"
  | "DECRYPTION_FAILED"
  | "DATABASE_TOO_LARGE"
  | "PERSISTENCE_FAILED"
  | "DATABASE_CLOSED";

/** A stable, non-secret error surface for callers and audit logging. */
export class StorageError extends Error {
  public readonly code: StorageErrorCode;

  public constructor(code: StorageErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.code = code;

    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
        writable: true,
      });
    }
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}
