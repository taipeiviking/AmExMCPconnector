import { parse } from "csv-parse/sync";

import { ValidationError } from "../errors";
import { fingerprintBytes } from "./common";
import { decodeImportText } from "./encoding";
import { parseTabularRows } from "./tabular";
import type {
  AmountConvention,
  CsvColumnMap,
  ImportContext,
  ImportEncodingPreference,
  ParsedTransactionImport,
} from "./types";

export interface ParseStatementCsvOptions {
  readonly encoding?: ImportEncodingPreference;
  readonly delimiter?: "," | "\t" | "auto";
  readonly columns?: CsvColumnMap;
  readonly amountConvention?: AmountConvention;
  /** One-based row containing column names. Earlier rows are ignored. */
  readonly headerRow?: number;
}

export function parseStatementCsv(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseStatementCsvOptions = {},
): ParsedTransactionImport {
  const decoded = decodeImportText(bytes, options.encoding ?? "auto");
  const content = decoded.text.replace(/^\uFEFF/u, "");
  const delimiter = options.delimiter === undefined || options.delimiter === "auto"
    ? detectDelimiter(content)
    : options.delimiter;
  let rows: string[][];
  try {
    rows = parse(content, {
      bom: true,
      delimiter,
      skip_empty_lines: false,
      relax_column_count: false,
      trim: true,
      max_record_size: 1024 * 1024,
    }) as string[][];
  } catch (caught) {
    throw new ValidationError("CSV statement could not be parsed", {
      cause: caught instanceof Error ? caught.message : "unknown parser error",
    });
  }

  const sourceFingerprint = fingerprintBytes(bytes);
  return parseTabularRows(rows, context, {
    format: "csv",
    sourceFingerprint,
    inputBytes: bytes.length,
    encoding: decoded.encoding,
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.amountConvention === undefined ? {} : { amountConvention: options.amountConvention }),
    ...(options.headerRow === undefined ? {} : { headerRow: options.headerRow }),
  });
}

function detectDelimiter(content: string): "," | "\t" {
  const firstUsefulLine = content.split(/\r?\n/gu).find((line) => line.trim().length > 0) ?? "";
  const commas = countOutsideQuotes(firstUsefulLine, ",");
  const tabs = countOutsideQuotes(firstUsefulLine, "\t");
  return tabs > commas ? "\t" : ",";
}

function countOutsideQuotes(line: string, needle: string): number {
  let inQuotes = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && character === needle) {
      count += 1;
    }
  }
  return count;
}
