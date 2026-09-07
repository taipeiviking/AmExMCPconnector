/** A stable, non-secret error surface for credential lookup failures. */
export type SecretReferenceErrorCode =
  | "UNSUPPORTED_REFERENCE"
  | "INVALID_REFERENCE"
  | "PLATFORM_UNAVAILABLE"
  | "SECRET_NOT_FOUND"
  | "SECRET_TOO_LARGE"
  | "RESOLVER_FAILED"
  | "SECRET_WRITE_FAILED"
  | "SECRET_DELETE_FAILED";

export class SecretReferenceError extends Error {
  public constructor(
    public readonly code: SecretReferenceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SecretReferenceError";
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

/**
 * Resolves an opaque reference into caller-owned bytes. Implementations must
 * never interpret an unknown reference as a literal secret.
 */
export interface SecretReferenceResolver {
  supports(reference: string): boolean;
  resolve(reference: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Writes only to an explicit protected-secret reference. Implementations must
 * never fall back to plaintext files, process environment, or literal values. */
export interface SecretReferenceStore {
  supports(reference: string): boolean;
  write(reference: string, secret: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** Returns false when the protected reference did not exist. */
  delete(reference: string, signal?: AbortSignal): Promise<boolean>;
}

/** Routes references without introducing an environment-variable or plaintext fallback. */
export class CompositeSecretReferenceResolver implements SecretReferenceResolver {
  public constructor(private readonly resolvers: readonly SecretReferenceResolver[]) {}

  public supports(reference: string): boolean {
    return this.resolvers.some((resolver) => resolver.supports(reference));
  }

  public async resolve(reference: string, signal?: AbortSignal): Promise<Uint8Array> {
    const resolver = this.resolvers.find((candidate) => candidate.supports(reference));
    if (!resolver) {
      throw new SecretReferenceError(
        "UNSUPPORTED_REFERENCE",
        "The credential reference scheme is not supported.",
      );
    }
    return await resolver.resolve(reference, signal);
  }
}

/** Ensures resolved bytes are overwritten after the supplied operation completes. */
export async function withResolvedSecret<T>(
  resolver: SecretReferenceResolver,
  reference: string,
  operation: (secret: Uint8Array) => Promise<T> | T,
  signal?: AbortSignal,
): Promise<T> {
  const secret = await resolver.resolve(reference, signal);
  try {
    return await operation(secret);
  } finally {
    secret.fill(0);
  }
}
