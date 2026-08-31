import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

import { parseQif, parseStatementCsv, ValidationError } from "../../src/core";
import { makeAccount, NOW } from "./fixtures";

describe("statement imports", () => {
  it("parses a US Amex-style CSV and converts positive charges to signed ledger amounts", () => {
    const account = makeAccount({
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const csv = [
      "Date,Description,Amount,Reference,Category,Country",
      "01/05/2026,Coffee Shop,12.34,ref-1,Meals,GB",
      "01/06/2026,Statement Credit,-5.00,ref-2,Credits,FR",
      "bad-date,Broken Row,2.00,ref-3,Other,US",
    ].join("\r\n");

    const result = parseStatementCsv(Buffer.from(csv, "utf8"), { account, importedAt: NOW });
    expect(result.transactions.map((transaction) => transaction.amount)).toEqual(["-12.34", "5.00"]);
    expect(result.transactions[0]).toMatchObject({
      externalId: "ref-1",
      categoryId: "Meals",
      merchantCountry: "GB",
      source: { accountId: account.id, legalEntityId: account.legalEntityId, country: "US" },
    });
    expect(result.transactions[1]?.merchantCountry).toBe("FR");
    expect(result.issues).toMatchObject([{ severity: "error", code: "INVALID_CSV_ROW", row: 4 }]);
  });

  it("parses Shift-JIS Japanese headers without scraping credentials", () => {
    const account = makeAccount({
      id: "jp-import",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const csv = "ご利用日,ご利用店名,ご利用金額,用途\r\n2026/01/08,サンプル店舗,1200,出張費\r\n";
    const bytes = iconv.encode(csv, "shift_jis");

    const result = parseStatementCsv(bytes, { account, importedAt: NOW });
    expect(result.issues).toEqual([]);
    expect(result.transactions[0]).toMatchObject({
      postedAt: "2026-01-08",
      description: "サンプル店舗",
      amount: "-1200",
      source: { businessPurpose: "出張費", country: "JP" },
    });
  });

  it("rejects excess USD and JPY precision without silently rounding", () => {
    const us = makeAccount({
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const usResult = parseStatementCsv(
      Buffer.from("Date,Description,Amount\n01/01/2026,Too precise,1.239", "utf8"),
      { account: us, importedAt: NOW },
    );
    expect(usResult.transactions).toEqual([]);
    expect(usResult.issues[0]?.message).toMatch(/minor-unit precision/iu);

    const jp = makeAccount({
      id: "jp-import",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const jpResult = parseStatementCsv(
      Buffer.from("Date,Description,Amount\n2026/01/01,端数,100.5", "utf8"),
      { account: jp, importedAt: NOW },
      { encoding: "utf8" },
    );
    expect(jpResult.transactions).toEqual([]);
    expect(jpResult.issues[0]?.message).toMatch(/minor-unit precision/iu);
  });

  it("requires accounts explicitly configured for statement import", () => {
    const account = makeAccount();
    expect(() =>
      parseStatementCsv(Buffer.from("Date,Description,Amount\n01/01/2026,X,1"), { account, importedAt: NOW }),
    ).toThrow(ValidationError);
  });

  it("parses common QIF records and preserves signed amounts", () => {
    const account = makeAccount({
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const qif = [
      "!Type:CCard",
      "D1/9'26",
      "T-45.67",
      "PExample Merchant",
      "MTeam meal",
      "Nqif-ref",
      "LMeals",
      "^",
    ].join("\n");
    const result = parseQif(Buffer.from(qif, "utf8"), { account, importedAt: NOW });

    expect(result.issues).toEqual([]);
    expect(result.transactions[0]).toMatchObject({
      postedAt: "2026-01-09",
      amount: "-45.67",
      description: "Example Merchant",
      externalId: "qif-ref",
      categoryId: "Meals",
    });
  });
});
