import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

import { parseQif, parseStatementFile, parseStatementCsv, ValidationError } from "../../../src/core";
import { NOW } from "../fixtures";
import { makeJapanImportAccount } from "./helpers";

describe("bounded CSV, TSV, and QIF parsing", () => {
  it("auto-detects tab-separated UTF-8 data and preserves its format metadata", () => {
    const account = makeJapanImportAccount();
    const result = parseStatementFile(
      Buffer.from("利用日\t内容\t金額\n2026/01/08\t鉄道\t700", "utf8"),
      { account, importedAt: NOW, sourceFileName: "official.tsv" },
    );
    expect(result.metadata).toMatchObject({ format: "csv", encoding: "utf8", sourceFileName: "official.tsv" });
    expect(result.transactions[0]).toMatchObject({ description: "鉄道", amount: "-700" });
  });

  it("decodes CP932 QIF and ignores its account metadata block", () => {
    const account = makeJapanImportAccount();
    const qif = [
      "!Account",
      "Nカード口座",
      "TCCard",
      "^",
      "!Type:CCard",
      "D2026/01/08",
      "T-900",
      "P日本店舗",
      "^",
    ].join("\r\n");
    const result = parseQif(iconv.encode(qif, "cp932"), { account, importedAt: NOW });
    expect(result.metadata.encoding).toBe("cp932");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ description: "日本店舗", amount: "-900" });
    expect(result.issues).toEqual([]);
  });

  it("rejects duplicate normalized headings instead of overwriting a column", () => {
    const account = makeJapanImportAccount();
    expect(() => parseStatementCsv(
      Buffer.from("Date,date,Description,Amount\n2026/01/08,2026/01/08,Store,100"),
      { account, importedAt: NOW },
    )).toThrowError(ValidationError);
  });
});
