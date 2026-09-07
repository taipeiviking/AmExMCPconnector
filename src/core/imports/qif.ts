import { ValidationError } from "../errors";
import {
  fingerprintBytes,
  importedTransactionId,
  normalizeImportedAmount,
  parseImportDate,
  sourceFor,
  withImportFingerprint,
} from "./common";
import { decodeImportText } from "./encoding";
import type {
  AmountConvention,
  ImportContext,
  ImportEncodingPreference,
  ImportIssue,
  NormalizedImportTransaction,
  ParsedTransactionImport,
} from "./types";

export interface ParseQifOptions {
  readonly amountConvention?: AmountConvention;
  readonly encoding?: ImportEncodingPreference;
}

interface QifRecord {
  readonly fields: Record<string, string[]>;
  readonly sourceRow: number;
}

export function parseQif(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseQifOptions = {},
): ParsedTransactionImport {
  if (context.account.collectionMethod !== "statement_import") {
    throw new ValidationError("QIF imports are only allowed for import-configured accounts", {
      accountId: context.account.id,
    });
  }
  const sourceFingerprint = fingerprintBytes(bytes);
  const decoded = decodeImportText(bytes, options.encoding ?? "auto");
  const lines = decoded.text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines.length > 1_000_000) throw new ValidationError("QIF contains too many lines");
  if (lines.some((line) => line.length > 1024 * 1024)) throw new ValidationError("QIF contains an oversized line");

  const issues: ImportIssue[] = [];
  const records: QifRecord[] = [];
  let current: Record<string, string[]> = {};
  let currentStart = 1;
  let typeSeen = false;
  let skippingAccountHeader = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "!Account") {
      skippingAccountHeader = true;
      current = {};
      continue;
    }
    if (line.startsWith("!Type:")) {
      skippingAccountHeader = false;
      typeSeen = true;
      const type = line.slice(6).trim().toLocaleLowerCase("en-US");
      if (!["ccard", "bank", "cash"].includes(type)) {
        issues.push({
          severity: "warning",
          code: "QIF_TYPE",
          message: `QIF type '${type}' is unusual for card data`,
          row: index + 1,
        });
      }
      continue;
    }
    if (line === "^") {
      if (skippingAccountHeader) {
        skippingAccountHeader = false;
        current = {};
        currentStart = index + 2;
        continue;
      }
      if (Object.keys(current).length > 0) records.push({ fields: current, sourceRow: currentStart });
      current = {};
      currentStart = index + 2;
      continue;
    }
    if (skippingAccountHeader) continue;
    if (line.length === 0) continue;
    if (Object.keys(current).length === 0) currentStart = index + 1;
    const code = line[0];
    if (code === undefined) continue;
    const value = line.slice(1).trim();
    (current[code] ??= []).push(value);
  }
  if (Object.keys(current).length > 0) {
    records.push({ fields: current, sourceRow: currentStart });
    issues.push({
      severity: "warning",
      code: "QIF_RECORD_UNTERMINATED",
      message: "Final QIF record has no '^' terminator but was parsed",
      row: currentStart,
    });
  }
  if (!typeSeen) {
    issues.push({ severity: "warning", code: "QIF_TYPE_MISSING", message: "QIF file has no !Type header" });
  }
  if (records.length > 100_000) throw new ValidationError("QIF contains more than 100,000 records");

  const normalizedTransactions: NormalizedImportTransaction[] = [];
  const transactions = records.flatMap((record) => {
    try {
      const date = first(record.fields, "D");
      const rawAmount = first(record.fields, "T");
      const description = (optionalFirst(record.fields, "P") ?? optionalFirst(record.fields, "M") ?? "")
        .normalize("NFKC")
        .trim();
      if (description.length === 0) throw new ValidationError("QIF payee/memo is empty");
      const postedAt = parseImportDate(date, context.account.country);
      const amount = normalizeImportedAmount(
        rawAmount,
        context.account.currency,
        options.amountConvention ?? "signed_ledger",
      );
      const externalId = optionalFirst(record.fields, "N");
      if (optionalFirst(record.fields, "L") !== undefined && !issues.some((issue) => issue.code === "IMPORTED_CATEGORY_IGNORED")) {
        issues.push({
          severity: "warning",
          code: "IMPORTED_CATEGORY_IGNORED",
          message: "QIF category values were not trusted as owner classifications; configure a reviewed local category mapping instead",
          row: record.sourceRow,
        });
      }
      const normalized: NormalizedImportTransaction = {
        sourceRow: record.sourceRow,
        ...(externalId === undefined ? {} : { externalId }),
        source: sourceFor(context.account),
        postedAt,
        description,
        amount,
        currency: context.account.currency,
        categoryId: null,
        memo: optionalFirst(record.fields, "M") ?? null,
      };
      normalizedTransactions.push(normalized);
      const rowKey = externalId ?? `${record.sourceRow}|${postedAt}|${amount}|${description}`;
      return [
        withImportFingerprint({
          id: importedTransactionId(context.account.id, sourceFingerprint, rowKey),
          ...(externalId === undefined ? {} : { externalId }),
          source: normalized.source,
          postedAt,
          description,
          amount,
          currency: context.account.currency,
          categoryId: normalized.categoryId,
          memo: normalized.memo,
          importedAt: context.importedAt,
        }),
      ];
    } catch (caught) {
      issues.push({
        severity: "error",
        code: "INVALID_QIF_RECORD",
        message: caught instanceof Error ? caught.message : "Invalid QIF record",
        row: record.sourceRow,
      });
      return [];
    }
  });

  return {
    sourceFingerprint,
    normalizedTransactions,
    transactions,
    issues,
    metadata: {
      format: "qif",
      encoding: decoded.encoding,
      ...(context.sourceFileName === undefined ? {} : { sourceFileName: context.sourceFileName }),
      inputBytes: bytes.length,
      parsedRows: records.length,
    },
  };
}

function first(record: Readonly<Record<string, string[]>>, code: string): string {
  const value = optionalFirst(record, code);
  if (value === undefined) throw new ValidationError(`QIF record is missing '${code}'`);
  return value;
}

function optionalFirst(record: Readonly<Record<string, string[]>>, code: string): string | undefined {
  const value = record[code]?.[0]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
