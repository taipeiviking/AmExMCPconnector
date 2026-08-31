import { constants as fsConstants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { StorageError } from "./storage-error";

export type AtomicWriteMode = "create" | "replace";

export async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new StorageError(
        "INVALID_DATABASE_FILE",
        "The encrypted database path must refer to a regular file, not a directory or symbolic link.",
      );
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Writes a complete ciphertext file without ever placing plaintext on disk. */
export async function writeFileAtomically(
  filePath: string,
  data: Uint8Array,
  mode: AtomicWriteMode,
): Promise<void> {
  const parentDirectory = dirname(filePath);
  const temporaryPath = join(
    parentDirectory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: FileHandle | undefined;

  try {
    await mkdir(parentDirectory, { mode: 0o700, recursive: true });
    handle = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (mode === "create") {
      // A same-directory hard-link provides atomic no-clobber publication.
      await link(temporaryPath, filePath);
      await unlink(temporaryPath);
    } else {
      // Node/libuv maps this to an atomic same-volume replacement on Windows.
      await rename(temporaryPath, filePath);
    }

    await chmod(filePath, 0o600).catch((error: unknown) => {
      if (process.platform !== "win32") {
        throw error;
      }
    });
    await syncDirectoryBestEffort(parentDirectory);
  } catch (error) {
    if (mode === "create" && hasErrorCode(error, "EEXIST")) {
      throw new StorageError(
        "DATABASE_ALREADY_EXISTS",
        "Refusing to overwrite an existing encrypted database.",
        error,
      );
    }
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError(
      "PERSISTENCE_FAILED",
      "The encrypted database could not be persisted atomically.",
      error,
    );
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT")) {
        // The original error, if any, is more useful than cleanup failure.
      }
    });
  }
}

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directoryPath, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      !hasErrorCode(error, "EACCES") &&
      !hasErrorCode(error, "EBADF") &&
      !hasErrorCode(error, "EINVAL") &&
      !hasErrorCode(error, "EISDIR") &&
      !hasErrorCode(error, "ENOTSUP") &&
      !hasErrorCode(error, "EPERM")
    ) {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
