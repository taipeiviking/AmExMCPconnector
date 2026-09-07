import { describe, expect, it } from "vitest";

import { parseStatementFile, parseStatementXlsx, ValidationError } from "../../../src/core";
import { NOW } from "../fixtures";
import { makeJapanImportAccount, makeStatementXlsx, makeStoredZip } from "./helpers";

describe("safe XLSX statement imports", () => {
  it("parses a visible worksheet, Excel date serial, Japanese text, and numeric amount", () => {
    const account = makeJapanImportAccount();
    const bytes = makeStatementXlsx();
    const result = parseStatementXlsx(bytes, { account, importedAt: NOW, sourceFileName: "amex.xlsx" });

    expect(result.metadata).toMatchObject({
      format: "xlsx",
      sourceFileName: "amex.xlsx",
      worksheetName: "利用明細",
      parsedRows: 1,
    });
    expect(result.issues).toEqual([]);
    expect(result.normalizedTransactions[0]).toMatchObject({
      sourceRow: 2,
      postedAt: "2026-01-08",
      description: "サンプル店舗",
      amount: "-1200",
      externalId: "jp-ref-1",
      source: { accountId: account.id, country: "JP" },
    });
    expect(result.transactions[0]?.importFingerprint).toHaveLength(64);
    expect(parseStatementFile(bytes, { account, importedAt: NOW }).metadata.format).toBe("xlsx");
  });

  it("rejects macro-bearing workbooks and unsafe archive paths", () => {
    const account = makeJapanImportAccount();
    expect(() => parseStatementXlsx(makeStatementXlsx({ includeMacro: true }), { account, importedAt: NOW })).toThrow(/macro/iu);
    const traversal = makeStoredZip({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": "<workbook/>",
      "../escape": "bad",
    });
    expect(() => parseStatementXlsx(traversal, { account, importedAt: NOW })).toThrow(/unsafe archive path/iu);
  });

  it("rejects formula cells rather than trusting cached calculated values", () => {
    const account = makeJapanImportAccount();
    expect(() => parseStatementXlsx(makeStatementXlsx({ includeFormula: true }), {
      account,
      importedAt: NOW,
    })).toThrow(/formula cells are not accepted/iu);
  });

  it("checks the integrity CRC before parsing workbook XML", () => {
    const account = makeJapanImportAccount();
    const corrupted = Buffer.from(makeStatementXlsx());
    const workbookTag = corrupted.indexOf(Buffer.from("<workbook", "utf8"));
    expect(workbookTag).toBeGreaterThan(0);
    corrupted[workbookTag + 1] = 0x58;
    expect(() => parseStatementXlsx(corrupted, { account, importedAt: NOW })).toThrow(/CRC integrity/iu);
  });

  it("rejects legacy binary XLS with an actionable conversion message", () => {
    const account = makeJapanImportAccount();
    const oleHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => parseStatementFile(oleHeader, { account, importedAt: NOW })).toThrowError(ValidationError);
    expect(() => parseStatementFile(oleHeader, { account, importedAt: NOW })).toThrow(/save.*xlsx.*CSV/iu);
  });
});
