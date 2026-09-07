import { describe, expect, it } from "vitest";

import { buildImportPreview, parseStatementCsv, type AmexAccount } from "../../src/core";
import {
  MAX_REVIEWABLE_IMPORT_ROWS,
  presentImportPreview,
} from "../../src/main/import-preview-presentation";

const NOW = "2026-09-07T00:00:00.000Z";

describe("import preview presentation", () => {
  it("shows every candidate row, signed totals, warnings, and mapping evidence", () => {
    const parsed = parseStatementCsv(Buffer.from([
      "Date,Description,Amount,Category",
      "2026/09/01,Hotel,1200,Issuer travel",
      "2026/09/02,Refund,-200,Issuer credit",
    ].join("\n")), { account: account(), importedAt: NOW });
    const preview = buildImportPreview(parsed);
    const result = presentImportPreview({
      previewId: "preview-1",
      accountId: "jp-account",
      fileName: "statement.csv",
      parsed,
      preview,
      expiresAt: "2026-09-07T00:10:00.000Z",
      mappingMatchedCount: 1,
      mappingFingerprint: "a".repeat(64),
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.amount)).toEqual(["-1200", "200"]);
    expect(result.totals).toEqual([{ currency: "JPY", signedTotal: "-1000", transactionCount: 2 }]);
    expect(result.warningCount).toBe(1);
    expect(result.mappingFingerprint).toBe("a".repeat(64));
  });

  it("blocks a candidate too large for complete on-screen review", () => {
    const parsed = parseStatementCsv(Buffer.from([
      "Date,Description,Amount",
      ...Array.from({ length: MAX_REVIEWABLE_IMPORT_ROWS + 1 }, (_, index) =>
        `2026/09/01,Row ${index + 1},1`,
      ),
    ].join("\n")), { account: account(), importedAt: NOW });
    expect(() => presentImportPreview({
      previewId: "preview-large",
      accountId: "jp-account",
      fileName: "large.csv",
      parsed,
      preview: buildImportPreview(parsed),
      expiresAt: "2026-09-07T00:10:00.000Z",
      mappingMatchedCount: 0,
    })).toThrow(/at most 1,000 transaction rows/u);
  });
});

function account(): AmexAccount {
  return {
    id: "jp-account",
    displayName: "Japan test",
    legalEntityId: "owner",
    legalEntityName: "Owner",
    country: "JP",
    currency: "JPY",
    accountClass: "personal",
    businessPurpose: null,
    collectionMethod: "statement_import",
    authorization: { state: "import_only", checkedAt: NOW },
    active: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
