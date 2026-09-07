import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { assertImportSourceUnchanged } from "../../src/main/import-source-verifier";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("import source approval verifier", () => {
  it("accepts the exact unchanged file and rejects changed content", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "statement.csv");
    const original = Buffer.from("Date,Description,Amount\n2026/09/01,Test,1\n");
    await writeFile(path, original);
    const metadata = await stat(path);
    const expected = {
      byteLength: metadata.size,
      modifiedAtMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(original).digest("hex"),
      maximumBytes: 1024,
    };
    await expect(assertImportSourceUnchanged(path, expected)).resolves.toBeUndefined();

    await writeFile(path, Buffer.from("Date,Description,Amount\n2026/09/01,Evil,2\n"));
    await expect(assertImportSourceUnchanged(path, expected)).rejects.toThrow(/changed after preview/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amex-import-source-"));
  temporaryDirectories.push(directory);
  return directory;
}
