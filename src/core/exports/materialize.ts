import { constants as fsConstants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { ValidationError } from "../errors";
import {
  buildExportManifest,
  encodeExportManifest,
  EXPORT_MANIFEST_FILE_NAME,
  parseExportManifest,
  sha256Bytes,
} from "./manifest";
import type {
  ExportManifest,
  ExportPackage,
  ExportPreview,
  HumanExportApproval,
  MaterializedExportPackage,
} from "./types";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

export interface ExportPackageMaterializer {
  materialize(input: {
    readonly destinationDirectory: string;
    readonly preview: ExportPreview;
    readonly approval: HumanExportApproval;
    readonly package: ExportPackage;
  }): Promise<MaterializedExportPackage>;
}

/** Publishes a complete package directory by one same-volume directory rename. */
export class AtomicDirectoryExportMaterializer implements ExportPackageMaterializer {
  public materialize(input: {
    readonly destinationDirectory: string;
    readonly preview: ExportPreview;
    readonly approval: HumanExportApproval;
    readonly package: ExportPackage;
  }): Promise<MaterializedExportPackage> {
    return materializeExportPackageAtomically(input);
  }
}

export async function materializeExportPackageAtomically(input: {
  readonly destinationDirectory: string;
  readonly preview: ExportPreview;
  readonly approval: HumanExportApproval;
  readonly package: ExportPackage;
}): Promise<MaterializedExportPackage> {
  const destination = resolveExportDestination(input.destinationDirectory);
  const manifest = buildExportManifest(input);
  validatePackageFileNames(input.package);
  const manifestBytes = encodeExportManifest(manifest);
  const manifestSha256 = sha256Bytes(manifestBytes);
  const parent = dirname(destination);
  const staging = join(
    parent,
    `.${basename(destination)}.${process.pid}.${randomBytes(12).toString("hex")}.staging`,
  );
  let stagingCreated = false;

  try {
    await mkdir(parent, { mode: 0o700, recursive: true });
    if (await pathExists(destination)) {
      throw new ValidationError("Export destination already exists; existing files will not be overwritten", {
        destinationDirectory: destination,
      });
    }
    await mkdir(staging, { mode: 0o700 });
    stagingCreated = true;
    for (const file of input.package.files) {
      await writeNewFileDurably(join(staging, file.fileName), file.bytes);
    }
    await writeNewFileDurably(join(staging, EXPORT_MANIFEST_FILE_NAME), manifestBytes);
    await syncDirectoryBestEffort(staging);

    const stagedVerification = await verifyMaterializedExport(staging);
    if (stagedVerification.manifestSha256 !== manifestSha256) {
      throw new ValidationError("Staged export manifest differs from the prepared manifest");
    }

    // On Windows (the supported first-release platform), rename publishes the
    // prepared sibling directory as one operation and refuses an existing target.
    await rename(staging, destination);
    stagingCreated = false;
    // Publication is already committed. A platform-specific inability to fsync
    // a directory must not turn a successful export into a reported failure.
    await syncDirectoryBestEffort(parent).catch(() => undefined);
    return {
      destinationDirectory: destination,
      manifestPath: join(destination, EXPORT_MANIFEST_FILE_NAME),
      manifestSha256,
      manifest: stagedVerification.manifest,
    };
  } catch (caught) {
    if (caught instanceof ValidationError) throw caught;
    throw new ValidationError("Approved export files could not be published atomically", {
      reason: safeErrorCode(caught),
    });
  } finally {
    if (stagingCreated) {
      await rm(staging, { force: true, recursive: true, maxRetries: 3 }).catch(() => undefined);
    }
  }
}

/** Recomputes every file checksum before a materialized package is trusted. */
export async function verifyMaterializedExport(destinationDirectory: string): Promise<MaterializedExportPackage> {
  const destination = resolveExportDestination(destinationDirectory);
  const manifestPath = join(destination, EXPORT_MANIFEST_FILE_NAME);
  const manifestStats = await lstat(manifestPath).catch((caught: unknown) => {
    throw new ValidationError("Export manifest is missing or inaccessible", { reason: safeErrorCode(caught) });
  });
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > MAX_MANIFEST_BYTES) {
    throw new ValidationError("Export manifest must be a bounded regular file");
  }
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseExportManifest(manifestBytes);
  const expectedNames = new Set([EXPORT_MANIFEST_FILE_NAME.toLocaleLowerCase("en-US")]);
  for (const expected of manifest.files) {
    assertSafePackageFileName(expected.fileName);
    const key = expected.fileName.toLocaleLowerCase("en-US");
    if (expectedNames.has(key)) {
      throw new ValidationError("Export manifest repeats a file name or names the manifest itself", {
        fileName: expected.fileName,
      });
    }
    expectedNames.add(key);
  }
  const directoryEntries = await readdir(destination, { withFileTypes: true }).catch((caught: unknown) => {
    throw new ValidationError("Export package directory is inaccessible", { reason: safeErrorCode(caught) });
  });
  const actualNames = new Set<string>();
  for (const entry of directoryEntries) {
    const key = entry.name.toLocaleLowerCase("en-US");
    if (actualNames.has(key) || !expectedNames.has(key)) {
      throw new ValidationError("Export package contains an unexpected file", { fileName: entry.name });
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new ValidationError("Export package entries must be regular files", { fileName: entry.name });
    }
    actualNames.add(key);
  }
  if (actualNames.size !== expectedNames.size) {
    throw new ValidationError("Export package is missing a manifest-listed file");
  }
  for (const expected of manifest.files) {
    const filePath = join(destination, expected.fileName);
    const stats = await lstat(filePath).catch((caught: unknown) => {
      throw new ValidationError("Export package file is missing or inaccessible", {
        fileName: expected.fileName,
        reason: safeErrorCode(caught),
      });
    });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== expected.byteLength) {
      throw new ValidationError("Export package file size or type does not match its manifest", {
        fileName: expected.fileName,
      });
    }
    const bytes = await readFile(filePath);
    if (sha256Bytes(bytes) !== expected.sha256) {
      throw new ValidationError("Export package file checksum does not match its manifest", {
        fileName: expected.fileName,
      });
    }
  }
  return {
    destinationDirectory: destination,
    manifestPath,
    manifestSha256: sha256Bytes(manifestBytes),
    manifest,
  };
}

function validatePackageFileNames(packageResult: ExportPackage): void {
  if (packageResult.automaticPosting !== false || packageResult.files.length === 0) {
    throw new ValidationError("An export package must contain local files and prohibit automatic posting");
  }
  const seen = new Set<string>();
  for (const file of packageResult.files) {
    assertSafePackageFileName(file.fileName);
    const key = file.fileName.toLocaleLowerCase("en-US");
    if (key === EXPORT_MANIFEST_FILE_NAME || seen.has(key)) {
      throw new ValidationError("Export package file names must be unique and cannot replace the manifest", {
        fileName: file.fileName,
      });
    }
    seen.add(key);
  }
}

function assertSafePackageFileName(fileName: string): void {
  const stem = fileName.split(".")[0]?.toLocaleUpperCase("en-US") ?? "";
  if (
    fileName.length === 0 ||
    fileName.length > 180 ||
    fileName !== basename(fileName) ||
    fileName === "." ||
    fileName === ".." ||
    /[<>:"/\\|?*\u0000-\u001F]/u.test(fileName) ||
    /[. ]$/u.test(fileName) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
  ) {
    throw new ValidationError("Export package contains an unsafe file name", { fileName });
  }
}

export function resolveExportDestination(value: string): string {
  if (value.trim().length === 0 || !isAbsolute(value)) {
    throw new ValidationError("Export destination must be an explicit absolute directory path");
  }
  const destination = resolve(value);
  if (destination === parse(destination).root) {
    throw new ValidationError("Export destination cannot be a filesystem root");
  }
  return destination;
}

async function writeNewFileDurably(filePath: string, bytes: Uint8Array): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(filePath, 0o600).catch((caught: unknown) => {
      if (process.platform !== "win32") throw caught;
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (caught) {
    if (hasErrorCode(caught, "ENOENT")) return false;
    throw caught;
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (caught) {
    if (
      !hasErrorCode(caught, "EACCES") &&
      !hasErrorCode(caught, "EBADF") &&
      !hasErrorCode(caught, "EINVAL") &&
      !hasErrorCode(caught, "EISDIR") &&
      !hasErrorCode(caught, "ENOTSUP") &&
      !hasErrorCode(caught, "EPERM")
    ) {
      throw caught;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safeErrorCode(caught: unknown): string {
  if (caught !== null && typeof caught === "object" && "code" in caught && typeof caught.code === "string") {
    return caught.code;
  }
  return caught instanceof Error ? caught.name : "UNKNOWN";
}

function hasErrorCode(caught: unknown, code: string): boolean {
  return caught !== null && typeof caught === "object" && "code" in caught && caught.code === code;
}
