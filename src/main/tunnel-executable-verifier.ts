import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type TunnelExecutableVerificationErrorCode =
  | "INVALID_PATH"
  | "NOT_A_FILE"
  | "REPARSE_POINT_REJECTED"
  | "OUTSIDE_ALLOWED_DIRECTORY"
  | "HASH_MISMATCH"
  | "VERIFICATION_FAILED";

export class TunnelExecutableVerificationError extends Error {
  public constructor(
    public readonly code: TunnelExecutableVerificationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "TunnelExecutableVerificationError";
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

export interface VerifyTunnelExecutableOptions {
  readonly expectedSha256?: string;
  readonly allowedDirectories?: readonly string[];
  readonly platform?: NodeJS.Platform;
}

export interface VerifiedTunnelExecutable {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Resolves, bounds, and hashes a tunnel executable immediately before launch. */
export async function verifyTunnelExecutable(
  executablePath: string,
  options: VerifyTunnelExecutableOptions = {},
): Promise<VerifiedTunnelExecutable> {
  const platform = options.platform ?? process.platform;
  if (
    typeof executablePath !== "string" ||
    executablePath.length < 1 ||
    executablePath.length > 32_767 ||
    !isAbsolute(executablePath) ||
    executablePath.includes("\0") ||
    (platform === "win32" && !executablePath.toLowerCase().endsWith(".exe"))
  ) {
    throw new TunnelExecutableVerificationError(
      "INVALID_PATH",
      "The tunnel client must be an absolute executable path.",
    );
  }
  if (options.expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/u.test(options.expectedSha256)) {
    throw new TunnelExecutableVerificationError(
      "INVALID_PATH",
      "The configured tunnel executable hash is invalid.",
    );
  }

  try {
    if (platform === "win32") await assertNoWindowsReparseComponents(resolve(executablePath));
    const direct = await lstat(executablePath);
    if (direct.isSymbolicLink()) {
      throw new TunnelExecutableVerificationError(
        "REPARSE_POINT_REJECTED",
        "Symbolic-link tunnel executables are not allowed.",
      );
    }
    if (!direct.isFile()) {
      throw new TunnelExecutableVerificationError("NOT_A_FILE", "The tunnel client path is not a regular file.");
    }
    const canonicalPath = await realpath(executablePath);
    const canonicalStat = await stat(canonicalPath);
    if (!canonicalStat.isFile()) {
      throw new TunnelExecutableVerificationError("NOT_A_FILE", "The tunnel client path is not a regular file.");
    }
    // On Windows, realpath may expand a non-reparse DOS 8.3 name or strip a
    // \\?\ namespace prefix. Component lstat checks above reject actual
    // symbolic links/junctions, so a remaining spelling-only difference is
    // safe. Canonical containment and the pinned digest are checked below.
    if (platform !== "win32" && !samePath(resolve(executablePath), resolve(canonicalPath), platform)) {
      throw new TunnelExecutableVerificationError(
        "REPARSE_POINT_REJECTED",
        "The tunnel client path resolves through a reparse point.",
      );
    }
    if (options.allowedDirectories && options.allowedDirectories.length > 0) {
      const allowed = await Promise.all(options.allowedDirectories.map(async (directory) => await realpath(directory)));
      if (!allowed.some((directory) => isContained(directory, canonicalPath, platform))) {
        throw new TunnelExecutableVerificationError(
          "OUTSIDE_ALLOWED_DIRECTORY",
          "The tunnel client is outside the approved installation directory.",
        );
      }
    }
    const sha256 = await sha256File(canonicalPath);
    if (options.expectedSha256 !== undefined && !safeHashEqual(sha256, options.expectedSha256)) {
      throw new TunnelExecutableVerificationError(
        "HASH_MISMATCH",
        "The tunnel client failed executable integrity verification.",
      );
    }
    return { canonicalPath, sha256, sizeBytes: canonicalStat.size };
  } catch (error) {
    if (error instanceof TunnelExecutableVerificationError) throw error;
    throw new TunnelExecutableVerificationError(
      "VERIFICATION_FAILED",
      "The tunnel client executable could not be verified.",
      error,
    );
  }
}

async function assertNoWindowsReparseComponents(path: string): Promise<void> {
  const root = parse(path).root;
  const child = relative(root, path);
  let current = root;
  for (const component of child.split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink()) {
      throw new TunnelExecutableVerificationError(
        "REPARSE_POINT_REJECTED",
        "Symbolic-link or junction tunnel paths are not allowed.",
      );
    }
  }
}

function samePath(first: string, second: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isContained(directory: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalizedDirectory = platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory);
  const normalizedCandidate = platform === "win32" ? resolve(candidate).toLowerCase() : resolve(candidate);
  const child = relative(normalizedDirectory, normalizedCandidate);
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function safeHashEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual.toLowerCase(), "ascii");
  const expectedBytes = Buffer.from(expected.toLowerCase(), "ascii");
  try {
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } finally {
    actualBytes.fill(0);
    expectedBytes.fill(0);
  }
}
