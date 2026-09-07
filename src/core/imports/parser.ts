import { ValidationError } from "../errors";
import { parseStatementCsv, type ParseStatementCsvOptions } from "./csv";
import { parseTextStatementPdf, type ParseTextStatementPdfOptions } from "./pdf";
import { parseQif, type ParseQifOptions } from "./qif";
import type { ImportContext, ParsedTransactionImport, StatementImportFormat } from "./types";
import { parseStatementXlsx, type ParseStatementXlsxOptions } from "./xlsx";

export interface ParseStatementFileOptions {
  readonly format?: StatementImportFormat | "auto";
  readonly csv?: ParseStatementCsvOptions;
  readonly qif?: ParseQifOptions;
  readonly xlsx?: ParseStatementXlsxOptions;
  readonly pdf?: ParseTextStatementPdfOptions;
}

export function parseStatementFile(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseStatementFileOptions = {},
): ParsedTransactionImport {
  const format = options.format === undefined || options.format === "auto"
    ? detectStatementImportFormat(bytes, context.sourceFileName)
    : options.format;
  switch (format) {
    case "csv": {
      const csvOptions = context.sourceFileName?.toLocaleLowerCase("en-US").endsWith(".tsv") === true
        ? { delimiter: "\t" as const, ...options.csv }
        : options.csv;
      return parseStatementCsv(bytes, context, csvOptions);
    }
    case "qif":
      return parseQif(bytes, context, options.qif);
    case "xlsx":
      return parseStatementXlsx(bytes, context, options.xlsx);
    case "pdf":
      return parseTextStatementPdf(bytes, context, options.pdf);
  }
}

export function detectStatementImportFormat(
  bytes: Uint8Array,
  sourceFileName?: string,
): StatementImportFormat {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "xlsx";
  }
  if (
    bytes.length >= 8 &&
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => bytes[index] === byte)
  ) {
    throw new ValidationError("Legacy binary .xls files are not supported; save the official export as .xlsx or CSV");
  }
  const extension = sourceFileName?.split(".").pop()?.toLocaleLowerCase("en-US");
  if (extension === "pdf") throw new ValidationError("File name says PDF but PDF signature is missing");
  if (extension === "xlsx" || extension === "xlsm") {
    throw new ValidationError("File name says Excel workbook but ZIP/XLSX signature is missing");
  }
  if (extension === "qif") return "qif";
  if (extension === "csv" || extension === "tsv" || extension === "txt") return "csv";

  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1");
  if (/^(?:\u00ef\u00bb\u00bf)?!Type:/u.test(sample)) return "qif";
  if (sample.includes(",") || sample.includes("\t")) return "csv";
  throw new ValidationError("Statement format could not be detected", {
    supportedFormats: ["CSV/TSV", "QIF", "XLSX", "text-based PDF"],
  });
}
