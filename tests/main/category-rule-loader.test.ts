import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadCategoryRules } from "../../src/main/category-rule-loader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("category rule loader", () => {
  it("loads a strict versioned rule set and returns its content fingerprint", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "categories.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      rules: [{
        id: "travel",
        priority: 10,
        match: { kind: "description_contains", value: "hotel" },
        categoryId: "Travel",
        businessPurpose: "Customer visit"
      }]
    }), "utf8");

    const loaded = await loadCategoryRules(path);
    expect(loaded.rules).toEqual([{ id: "travel", priority: 10, match: {
      kind: "description_contains", value: "hotel"
    }, categoryId: "Travel", businessPurpose: "Customer visit" }]);
    expect(loaded.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects duplicate IDs and unknown fields", async () => {
    const directory = await temporaryDirectory();
    const duplicatePath = join(directory, "duplicate.json");
    const rule = { id: "same", priority: 1, match: { kind: "description_prefix", value: "x" }, categoryId: "One" };
    await writeFile(duplicatePath, JSON.stringify({ version: 1, rules: [rule, { ...rule, categoryId: "Two" }] }), "utf8");
    await expect(loadCategoryRules(duplicatePath)).rejects.toThrow(/version 1 rule schema/u);

    const unknownPath = join(directory, "unknown.json");
    await writeFile(unknownPath, JSON.stringify({ version: 1, rules: [], secret: "no" }), "utf8");
    await expect(loadCategoryRules(unknownPath)).rejects.toThrow(/version 1 rule schema/u);

  });

  it("rejects symbolic links and Windows junctions", async () => {
    const directory = await temporaryDirectory();
    const windows = process.platform === "win32";
    const targetPath = join(directory, windows ? "target-directory" : "target.json");
    const linkPath = join(directory, windows ? "linked-directory" : "link.json");
    if (windows) await mkdir(targetPath);
    else await writeFile(targetPath, JSON.stringify({ version: 1, rules: [] }), "utf8");
    await symlink(targetPath, linkPath, windows ? "junction" : "file");
    await expect(loadCategoryRules(linkPath)).rejects.toThrow(/not a link/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amex-category-rules-"));
  temporaryDirectories.push(directory);
  return directory;
}
