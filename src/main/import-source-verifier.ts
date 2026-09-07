import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface ExpectedImportSource {
  readonly byteLength: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
  readonly maximumBytes: number;
}

/** Re-opens the exact owner-selected statement at approval and proves it has
 * not been replaced or edited since preview. It never returns file contents. */
export async function assertImportSourceUnchanged(
  filePath: string,
  expected: ExpectedImportSource,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(expected.sha256)) throw new Error("The expected statement fingerprint is invalid.");
  const pathEntry = await lstat(filePath);
  if (
    !pathEntry.isFile() ||
    pathEntry.isSymbolicLink() ||
    pathEntry.size !== expected.byteLength ||
    pathEntry.size < 1 ||
    pathEntry.size > expected.maximumBytes ||
    pathEntry.mtimeMs !== expected.modifiedAtMs
  ) {
    throw new Error("The selected statement changed after preview. Choose and review it again.");
  }

  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== pathEntry.size ||
      before.mtimeMs !== pathEntry.mtimeMs ||
      (pathEntry.ino !== 0 && before.ino !== pathEntry.ino) ||
      (pathEntry.dev !== 0 && before.dev !== pathEntry.dev)
    ) {
      throw new Error("The selected statement changed after preview. Choose and review it again.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new Error("The selected statement changed while approval was being checked.");
    }
    const actual = createHash("sha256").update(bytes).digest();
    const expectedBytes = Buffer.from(expected.sha256, "hex");
    if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
      throw new Error("The selected statement contents changed after preview. Choose and review it again.");
    }
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}
