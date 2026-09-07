import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ParsedTransactionImport } from "../../src/core";
import {
  applyConfiguredCategoryMapping,
  assertCategoryMappingUnchanged,
} from "../../src/main/category-mapping-workflow";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("category mapping import workflow", () => {
  it("maps category and business purpose and binds approval to the rule-file fingerprint", async () => {
    const directory = await temporaryDirectory();
    const mappingPath = join(directory, "categories.json");
    await writeFile(mappingPath, JSON.stringify({
      version: 1,
      rules: [{
        id: "travel",
        priority: 10,
        match: { kind: "merchant_equals", value: "Example Hotel" },
        categoryId: "travel",
        businessPurpose: "Customer visit",
      }],
    }), "utf8");

    const applied = await applyConfiguredCategoryMapping(parsedImport(), mappingPath);
    expect(applied.matchedTransactionCount).toBe(1);
    expect(applied.parsed.transactions[0]?.categoryId).toBe("travel");
    expect(applied.parsed.transactions[0]?.source.businessPurpose).toBe("Customer visit");
    expect(applied.parsed.normalizedTransactions[0]?.categoryId).toBe("travel");
    await expect(assertCategoryMappingUnchanged(mappingPath, applied.sourceFingerprint)).resolves.toBeUndefined();

    await writeFile(mappingPath, JSON.stringify({ version: 1, rules: [] }), "utf8");
    await expect(assertCategoryMappingUnchanged(mappingPath, applied.sourceFingerprint)).rejects.toThrow(
      /changed after preview/u,
    );
  });

  it("leaves the parsed import untouched when no mapping file is configured", async () => {
    const parsed = parsedImport();
    const applied = await applyConfiguredCategoryMapping(parsed, undefined);
    expect(applied).toEqual({ parsed, matchedTransactionCount: 0 });
  });
});

function parsedImport(): ParsedTransactionImport {
  const source = {
    accountId: "jp-personal",
    legalEntityId: "owner",
    legalEntityName: "Owner",
    country: "JP" as const,
    accountClass: "personal" as const,
    accountCurrency: "JPY",
    businessPurpose: null,
  };
  return {
    sourceFingerprint: "a".repeat(64),
    normalizedTransactions: [{
      sourceRow: 2,
      source,
      postedAt: "2026-09-01",
      description: "EXAMPLE HOTEL",
      amount: "-10000",
      currency: "JPY",
      categoryId: null,
      memo: null,
    }],
    transactions: [{
      id: "txn-1",
      source,
      postedAt: "2026-09-01",
      description: "EXAMPLE HOTEL",
      merchantName: "Example Hotel",
      amount: "-10000",
      currency: "JPY",
      categoryId: null,
      memo: null,
      importFingerprint: "b".repeat(64),
      importedAt: "2026-09-02T00:00:00.000Z",
    }],
    issues: [],
    metadata: { format: "csv", encoding: "utf8", inputBytes: 100, parsedRows: 1 },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amex-category-workflow-"));
  temporaryDirectories.push(directory);
  return directory;
}
