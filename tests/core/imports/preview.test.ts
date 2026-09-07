import { describe, expect, it } from "vitest";

import { buildImportPreview, parseStatementCsv } from "../../../src/core";
import { NOW } from "../fixtures";
import { makeJapanImportAccount } from "./helpers";

describe("statement import preview", () => {
  it("retains only the first of two within-file duplicates for review", () => {
    const account = makeJapanImportAccount();
    const parsed = parseStatementCsv(
      Buffer.from("Date,Description,Amount\n2026/01/08,Store,100\n2026/01/08,Store,100"),
      { account, importedAt: NOW },
    );
    const preview = buildImportPreview(parsed);
    expect(preview.duplicateFindings).toHaveLength(1);
    expect(preview.duplicateFindings[0]?.classification).toBe("within_file");
    expect(preview.acceptedTransactions).toHaveLength(1);
    expect(preview.readyForHumanApproval).toBe(false);
  });

  it("classifies duplicates within a file and against the existing ledger", () => {
    const account = makeJapanImportAccount();
    const parsed = parseStatementCsv(
      Buffer.from([
        "Date,Description,Amount,Reference",
        "2026/01/08,Store,100,ref-1",
        "2026/01/08,Store,100,ref-1",
      ].join("\n")),
      { account, importedAt: NOW },
    );
    const existing = [{ ...parsed.transactions[0]!, id: "existing-1" }];
    const preview = buildImportPreview(parsed, { existingTransactions: existing });

    expect(preview.duplicateFindings.map((finding) => finding.classification)).toEqual([
      "already_imported",
      "within_file",
      "already_imported",
    ]);
    expect(preview.acceptedTransactions).toEqual([]);
    expect(preview.readyForHumanApproval).toBe(false);
  });

  it("detects conflicting reuse of an account-scoped external id", () => {
    const account = makeJapanImportAccount();
    const prior = parseStatementCsv(
      Buffer.from("Date,Description,Amount,Reference\n2026/01/08,Store,100,ref-1"),
      { account, importedAt: NOW },
    ).transactions[0]!;
    const changed = parseStatementCsv(
      Buffer.from("Date,Description,Amount,Reference\n2026/01/08,Store,200,ref-1"),
      { account, importedAt: NOW },
    );
    expect(buildImportPreview(changed, { existingTransactions: [prior] }).duplicateFindings).toContainEqual(
      expect.objectContaining({ classification: "external_id_conflict", externalId: "ref-1" }),
    );
  });

  it("previews statement-balance reconciliation without persisting anything", () => {
    const account = makeJapanImportAccount();
    const parsed = parseStatementCsv(
      Buffer.from("Date,Description,Amount\n2026/01/08,Store,100"),
      { account, importedAt: NOW },
    );
    const preview = buildImportPreview(parsed, {
      statementBalance: {
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        openingBalance: "1000",
        closingBalance: "900",
        currency: "JPY",
      },
    });
    expect(preview.reconciliation).toMatchObject({
      status: "reconciled",
      transactionActivity: "-100",
      expectedClosingBalance: "900",
      difference: "0",
    });
    expect(preview.readyForHumanApproval).toBe(true);
  });

  it("blocks an exact source file fingerprint from being approved twice", () => {
    const account = makeJapanImportAccount();
    const parsed = parseStatementCsv(Buffer.from("Date,Description,Amount\n2026/01/08,Store,100"), {
      account,
      importedAt: NOW,
    });
    const preview = buildImportPreview(parsed, { existingSourceFingerprints: [parsed.sourceFingerprint] });
    expect(preview.duplicateFindings[0]?.classification).toBe("source_file_already_imported");
    expect(preview.acceptedTransactions).toEqual([]);
  });
});
