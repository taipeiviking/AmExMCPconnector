import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractTextFromPdf, parseTextStatementPdf, ValidationError } from "../../../src/core";
import { NOW } from "../fixtures";
import { makeJapanImportAccount, makeTextPdf } from "./helpers";

describe("reviewed text-based PDF statement imports", () => {
  it("extracts a text row and marks the layout for mandatory review", () => {
    const account = makeJapanImportAccount();
    const bytes = makeTextPdf("(2026/01/08 Sample Merchant 1200) Tj");
    const extracted = extractTextFromPdf(bytes);
    expect(extracted.lines).toEqual(["2026/01/08 Sample Merchant 1200"]);

    const result = parseTextStatementPdf(bytes, { account, importedAt: NOW });
    expect(result.metadata.pdfTextStreamCount).toBe(1);
    expect(result.transactions[0]).toMatchObject({
      postedAt: "2026-01-08",
      description: "Sample Merchant",
      amount: "-1200",
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "PDF_TEXT_LAYOUT_REVIEW_REQUIRED" }));
  });

  it("decompresses bounded Flate text streams", () => {
    const account = makeJapanImportAccount();
    const content = Buffer.from("BT\n(2026/01/08 Rail 750) Tj\nET\n", "ascii");
    const bytes = makePdfStreams([{ bytes: deflateSync(content), dictionary: "/Filter /FlateDecode" }]);
    const result = parseTextStatementPdf(bytes, { account, importedAt: NOW });
    expect(result.transactions[0]).toMatchObject({ description: "Rail", amount: "-750" });
  });

  it("uses an embedded ToUnicode character map for text extraction", () => {
    const cmap = Buffer.from("begincmap\n1 beginbfchar\n<0001> <65E5>\nendbfchar\nendcmap", "ascii");
    const content = Buffer.from("BT\n<0001> Tj\nET", "ascii");
    const bytes = makePdfStreams([{ bytes: cmap }, { bytes: content }]);
    expect(extractTextFromPdf(bytes).lines).toEqual(["日"]);
  });

  it("supports reviewed layout-specific named captures", () => {
    const account = makeJapanImportAccount();
    const bytes = makeTextPdf("(2026/01/08 | Rail Pass | 5000 | receipt-7) Tj");
    const result = parseTextStatementPdf(bytes, { account, importedAt: NOW }, {
      rowPattern: /^(?<date>[^|]+)\|(?<description>[^|]+)\|(?<amount>[^|]+)\|(?<reference>.+)$/u,
    });
    expect(result.transactions[0]).toMatchObject({ description: "Rail Pass", amount: "-5000", externalId: "receipt-7" });
  });

  it("blocks import when a date-like text row is not represented in the preview", () => {
    const account = makeJapanImportAccount();
    const content = Buffer.from([
      "BT",
      "(2026/01/08 Rail 750) Tj",
      "T*",
      "(2026/01/09 amount-missing) Tj",
      "ET",
    ].join("\n"), "ascii");
    const result = parseTextStatementPdf(makePdfStreams([{ bytes: content }]), { account, importedAt: NOW });
    expect(result.transactions).toHaveLength(1);
    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "PDF_UNMATCHED_DATE_LINES",
    }));
  });

  it("fails closed for encrypted, scanned, or unrecognized PDF layouts", () => {
    const account = makeJapanImportAccount();
    const encrypted = Buffer.from("%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF", "ascii");
    expect(() => parseTextStatementPdf(encrypted, { account, importedAt: NOW })).toThrow(/encrypted/iu);
    const noText = Buffer.from("%PDF-1.4\n1 0 obj <<>> endobj\n%%EOF", "ascii");
    expect(() => extractTextFromPdf(noText)).toThrow(/no extractable text/iu);
    expect(() => parseTextStatementPdf(makeTextPdf("(Statement heading only) Tj"), { account, importedAt: NOW })).toThrowError(ValidationError);
  });
});

function makePdfStreams(
  streams: readonly { readonly bytes: Buffer; readonly dictionary?: string }[],
): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "ascii")];
  streams.forEach((stream, index) => {
    parts.push(
      Buffer.from(`${index + 1} 0 obj\n<< /Length ${stream.bytes.length} ${stream.dictionary ?? ""} >>\nstream\n`, "ascii"),
      stream.bytes,
      Buffer.from("\nendstream\nendobj\n", "ascii"),
    );
  });
  parts.push(Buffer.from("%%EOF\n", "ascii"));
  return Buffer.concat(parts);
}
