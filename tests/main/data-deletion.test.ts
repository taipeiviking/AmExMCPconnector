import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteLocalDataTargets,
  initializeLocalDataOwnership,
  inventoryLocalDataTargets
} from "../../src/main/data-deletion";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  for (const root of temporaryRoots.splice(0)) {
    if (resolve(root).startsWith(resolve(tmpdir()))) await rm(root, { recursive: true, force: true });
  }
});

describe("local data deletion containment", () => {
  it("deletes only allowlisted descendants and leaves unrelated sibling data", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-delete-test-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "ledger.db.enc");
    const importDirectory = join(root, "imports");
    const exportDirectory = join(root, "exports");
    const logDirectory = join(root, "logs");
    const unrelated = join(root, "keep-me.txt");
    const targets = { dataDirectory: root, databasePath, importDirectory, exportDirectory, logDirectory };
    await expect(initializeLocalDataOwnership(targets)).resolves.toBe(true);
    await writeFile(databasePath, "ciphertext");
    await writeFile(unrelated, "unrelated");

    await expect(inventoryLocalDataTargets(targets)).resolves.toMatchObject({ databaseExists: true, fileCount: 1 });
    await deleteLocalDataTargets(targets);

    await expect(readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
  });

  it("refuses root and traversal targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-delete-test-"));
    temporaryRoots.push(root);
    const outside = resolve(root, "..");
    await expect(
      deleteLocalDataTargets({
        dataDirectory: root,
        databasePath: root,
        importDirectory: join(root, "imports"),
        exportDirectory: join(root, "exports"),
        logDirectory: outside
      })
    ).rejects.toThrow(/Refusing to (?:use|treat)/u);
  });

  it("does not claim an existing broad directory containing unrelated entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "amex-delete-test-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "family-photo.txt"), "not app data");
    const targets = {
      dataDirectory: root,
      databasePath: join(root, "ledger.db.enc"),
      importDirectory: join(root, "imports"),
      exportDirectory: join(root, "exports"),
      logDirectory: join(root, "logs")
    };

    await expect(initializeLocalDataOwnership(targets)).resolves.toBe(false);
    await expect(deleteLocalDataTargets(targets)).rejects.toThrow(/ownership marker|ENOENT/u);
    await expect(readFile(join(root, "family-photo.txt"), "utf8")).resolves.toBe("not app data");
  });
});
