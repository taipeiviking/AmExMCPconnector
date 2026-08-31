import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const OWNERSHIP_MARKER = ".amex-local-finance-connector-owned-v1";
const MAX_INVENTORY_ENTRIES = 10_000;

export interface LocalDataTargets {
  dataDirectory: string;
  databasePath: string;
  importDirectory: string;
  exportDirectory: string;
  logDirectory: string;
}

export interface LocalDataInventory {
  readonly databaseExists: boolean;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly paths: readonly string[];
}

/**
 * Claims a narrowly scoped data root for this installation. Existing broad or
 * unrelated directories are never silently claimed. Recursive child targets
 * receive their own marker so a later cleanup can re-prove ownership.
 */
export async function initializeLocalDataOwnership(targets: LocalDataTargets): Promise<boolean> {
  const normalized = normalizeTargets(targets);
  const rootExisted = await pathExists(normalized.root);
  if (rootExisted) {
    await assertDirectoryWithoutReparsePoint(normalized.root);
  } else {
    await mkdir(normalized.root, { recursive: true });
  }

  const rootMarker = join(normalized.root, OWNERSHIP_MARKER);
  if (await pathExists(rootMarker)) {
    await assertMarker(rootMarker, normalized.root);
  } else {
    const existing = await readdir(normalized.root);
    const allowedTopLevelNames = new Set([
      firstRelativeSegment(normalized.root, normalized.databasePath),
      ...normalized.directories.map((directory) => firstRelativeSegment(normalized.root, directory))
    ]);
    if (existing.some((entry) => !allowedTopLevelNames.has(entry))) return false;
    await writeOwnershipMarker(rootMarker, normalized.root);
  }

  for (const directory of normalized.directories) {
    await assertNoReparsePoints(normalized.root, directory);
    if (!(await pathExists(directory))) await mkdir(directory, { recursive: true });
    await assertDirectoryWithoutReparsePoint(directory);
    const marker = join(directory, OWNERSHIP_MARKER);
    if (await pathExists(marker)) {
      await assertMarker(marker, normalized.root);
      continue;
    }
    const existing = await readdir(directory);
    if (existing.length > 0) return false;
    await writeOwnershipMarker(marker, normalized.root);
  }
  return true;
}

/** Inventories only exact, marker-owned application targets. */
export async function inventoryLocalDataTargets(targets: LocalDataTargets): Promise<LocalDataInventory> {
  const normalized = normalizeTargets(targets);
  await assertOwnership(normalized);
  let fileCount = 0;
  let totalBytes = 0;
  let databaseExists = false;

  if (await pathExists(normalized.databasePath)) {
    const databaseStats = await lstat(normalized.databasePath);
    if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
      throw new Error("Refusing cleanup because the encrypted database target is not a regular file.");
    }
    databaseExists = true;
    fileCount += 1;
    totalBytes += databaseStats.size;
  }

  for (const directory of normalized.directories) {
    const inventory = await inventoryDirectory(directory);
    fileCount += inventory.fileCount;
    totalBytes += inventory.totalBytes;
  }

  return {
    databaseExists,
    fileCount,
    totalBytes,
    paths: [normalized.databasePath, ...normalized.directories]
  };
}

/**
 * Deletes only the exact database file and separately marker-owned import,
 * export, and log directories after a fresh inventory and reparse-point check.
 * The root marker is retained; unrelated siblings and renderer preferences are
 * not touched.
 */
export async function deleteLocalDataTargets(targets: LocalDataTargets): Promise<LocalDataInventory> {
  const normalized = normalizeTargets(targets);
  const inventory = await inventoryLocalDataTargets(targets);
  await assertOwnership(normalized);

  if (await pathExists(normalized.databasePath)) {
    const databaseStats = await lstat(normalized.databasePath);
    if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
      throw new Error("Refusing cleanup because the encrypted database target changed after preview.");
    }
    await rm(normalized.databasePath, { force: false });
  }

  for (const directory of normalized.directories) {
    await assertNoReparsePoints(normalized.root, directory);
    await assertMarker(join(directory, OWNERSHIP_MARKER), normalized.root);
    await inventoryDirectory(directory);
    await rm(directory, { recursive: true, force: false, maxRetries: 3 });
  }
  return inventory;
}

interface NormalizedTargets {
  root: string;
  databasePath: string;
  directories: string[];
}

function normalizeTargets(targets: LocalDataTargets): NormalizedTargets {
  const root = resolve(targets.dataDirectory);
  const parsedRoot = parse(root).root;
  if (root === parsedRoot || root.toLowerCase() === resolve(homedir()).toLowerCase()) {
    throw new Error("Refusing to treat a filesystem root or user profile as application-owned data.");
  }
  const databasePath = assertStrictDescendant(root, targets.databasePath);
  const directories = [targets.importDirectory, targets.exportDirectory, targets.logDirectory].map((path) =>
    assertStrictDescendant(root, path)
  );
  const allTargets = [databasePath, ...directories];
  if (new Set(allTargets.map((path) => path.toLowerCase())).size !== allTargets.length) {
    throw new Error("Refusing cleanup because configured application data targets overlap.");
  }
  for (const directory of directories) {
    if (databasePath.startsWith(`${directory}${sep}`) || directories.some((other) => other !== directory && other.startsWith(`${directory}${sep}`))) {
      throw new Error("Refusing cleanup because configured application data targets are nested.");
    }
  }
  return { root, databasePath, directories };
}

async function assertOwnership(targets: NormalizedTargets): Promise<void> {
  await assertDirectoryWithoutReparsePoint(targets.root);
  await assertMarker(join(targets.root, OWNERSHIP_MARKER), targets.root);
  await assertNoReparsePoints(targets.root, targets.databasePath);
  for (const directory of targets.directories) {
    await assertNoReparsePoints(targets.root, directory);
    await assertDirectoryWithoutReparsePoint(directory);
    await assertMarker(join(directory, OWNERSHIP_MARKER), targets.root);
  }
}

async function inventoryDirectory(root: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.isSymbolicLink()) throw new Error("Refusing cleanup because an application data target contains a reparse point.");
      if (details.isDirectory()) {
        pending.push(path);
      } else if (details.isFile()) {
        if (entry.name !== OWNERSHIP_MARKER) {
          fileCount += 1;
          totalBytes += details.size;
        }
      } else {
        throw new Error("Refusing cleanup because an application data target contains an unsupported filesystem entry.");
      }
      if (fileCount + pending.length > MAX_INVENTORY_ENTRIES) {
        throw new Error("Refusing cleanup because the local data inventory is unexpectedly large.");
      }
    }
  }
  return { fileCount, totalBytes };
}

async function assertNoReparsePoints(root: string, target: string): Promise<void> {
  const child = relative(root, target);
  let current = root;
  for (const segment of child.split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!(await pathExists(current))) continue;
    const details = await lstat(current);
    if (details.isSymbolicLink()) throw new Error("Refusing cleanup through a symbolic link or Windows reparse point.");
  }
}

async function assertDirectoryWithoutReparsePoint(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Refusing cleanup because an application data directory is not a regular directory.");
  }
}

async function writeOwnershipMarker(markerPath: string, root: string): Promise<void> {
  const contents = markerContents(root);
  try {
    await writeFile(markerPath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertMarker(markerPath, root);
  }
}

async function assertMarker(markerPath: string, root: string): Promise<void> {
  const details = await lstat(markerPath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("Application data ownership marker is invalid.");
  const contents = await readFile(markerPath, "utf8");
  if (contents !== markerContents(root)) throw new Error("Application data ownership marker does not match this installation path.");
}

function markerContents(root: string): string {
  return `${JSON.stringify({ application: "amex-local-finance-connector", schema: 1, root: resolve(root) })}\n`;
}

function firstRelativeSegment(root: string, target: string): string {
  return relative(root, target).split(sep)[0]!;
}

function assertStrictDescendant(root: string, path: string): string {
  const target = resolve(path);
  const child = relative(root, target);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Refusing to use a path outside the configured local application data directory.");
  }
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
