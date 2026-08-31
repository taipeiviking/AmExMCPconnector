import { parse } from "csv-parse/sync";
import iconv from "iconv-lite";

import type { IsoCountryCode } from "../country-codes";
import { parseIsoCountryCode } from "../country-codes";
import { ValidationError } from "../errors";
import {
  fingerprintBytes,
  importedTransactionId,
  normalizeImportedAmount,
  parseImportDate,
  sourceFor,
  withImportFingerprint,
} from "./common";
import type {
  AmountConvention,
  CsvColumnMap,
  ImportContext,
  ImportEncoding,
  ImportIssue,
  ParsedTransactionImport,
} from "./types";

export interface ParseStatementCsvOptions {
  readonly encoding?: ImportEncoding;
  readonly delimiter?: "," | "\t";
  readonly columns?: CsvColumnMap;
  readonly amountConvention?: AmountConvention;
}

type CsvRecord = Record<string, string>;

const ALIASES: Readonly<Record<keyof CsvColumnMap, readonly string[]>> = {
  date: ["date", "transaction date", "posted date", "ご利用日", "利用日", "日付"],
  description: ["description", "merchant", "appears on your statement as", "ご利用店名", "利用店名", "内容"],
  amount: ["amount", "transaction amount", "ご利用金額", "利用金額", "金額"],
  debit: ["debit", "withdrawal", "出金", "支出"],
  credit: ["credit", "deposit", "入金", "収入"],
  reference: ["reference", "reference number", "transaction id", "照会番号", "受付番号"],
  category: ["category", "カテゴリ", "カテゴリー"],
  memo: ["memo", "extended details", "メモ", "摘要"],
  merchantCountry: ["country", "merchant country", "国", "国名"],
  businessPurpose: ["business purpose", "事業目的", "用途"],
};

export function parseStatementCsv(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseStatementCsvOptions = {},
): ParsedTransactionImport {
  assertImportAccount(context);
  const encoding = options.encoding ?? (context.account.country === "JP" ? "shift_jis" : "utf8");
  const sourceFingerprint = fingerprintBytes(bytes);
  const content = iconv.decode(Buffer.from(bytes), encoding === "shift_jis" ? "shift_jis" : "utf8").replace(/^\uFEFF/u, "");
  let records: CsvRecord[];
  try {
    records = parse(content, {
      bom: true,
      columns: (headers: string[]) => headers.map((header) => header.normalize("NFKC").trim()),
      delimiter: options.delimiter ?? ",",
      skip_empty_lines: true,
      relax_column_count: false,
      trim: true,
    }) as CsvRecord[];
  } catch (caught) {
    throw new ValidationError("CSV statement could not be parsed", {
      cause: caught instanceof Error ? caught.message : "unknown parser error",
    });
  }
  if (records.length === 0) return { sourceFingerprint, transactions: [], issues: [] };

  const first = records[0];
  if (first === undefined) return { sourceFingerprint, transactions: [], issues: [] };
  const resolved = resolveColumns(Object.keys(first), options.columns);
  if (resolved.date === undefined || resolved.description === undefined) {
    throw new ValidationError("CSV must contain date and description columns", { headers: Object.keys(first) });
  }
  if (resolved.amount === undefined && resolved.debit === undefined && resolved.credit === undefined) {
    throw new ValidationError("CSV must contain an amount column or debit/credit columns", { headers: Object.keys(first) });
  }

  const issues: ImportIssue[] = [];
  const transactions = records.flatMap((record, index) => {
    const row = index + 2;
    try {
      const postedAt = parseImportDate(record[resolved.date ?? ""] ?? "", context.account.country);
      const description = (record[resolved.description ?? ""] ?? "").normalize("NFKC").trim();
      if (description.length === 0) throw new ValidationError("Description is empty");
      const rawAmount = resolveAmount(record, resolved);
      const amount = normalizeImportedAmount(
        rawAmount,
        context.account.currency,
        options.amountConvention ?? "amex_charges_positive",
      );
      const externalId = optionalValue(record, resolved.reference);
      const businessPurpose = optionalValue(record, resolved.businessPurpose) ?? context.account.businessPurpose;
      const merchantCountryRaw = optionalValue(record, resolved.merchantCountry);
      const merchantCountry = parseCountry(merchantCountryRaw);
      if (merchantCountryRaw !== undefined && merchantCountry === undefined) {
        issues.push({
          severity: "warning",
          code: "UNKNOWN_MERCHANT_COUNTRY",
          message: `Merchant country '${merchantCountryRaw}' was not recognized and was left unset`,
          row,
        });
      }
      const rowKey = externalId ?? `${row}|${postedAt}|${amount}|${description}`;
      return [
        withImportFingerprint({
          id: importedTransactionId(context.account.id, sourceFingerprint, rowKey),
          ...(externalId === undefined ? {} : { externalId }),
          source: sourceFor(context.account, businessPurpose),
          postedAt,
          description,
          amount,
          currency: context.account.currency,
          categoryId: optionalValue(record, resolved.category) ?? null,
          memo: optionalValue(record, resolved.memo) ?? null,
          ...(merchantCountry === undefined ? {} : { merchantCountry }),
          importedAt: context.importedAt,
        }),
      ];
    } catch (caught) {
      issues.push({
        severity: "error",
        code: "INVALID_CSV_ROW",
        message: caught instanceof Error ? caught.message : "Invalid row",
        row,
      });
      return [];
    }
  });
  return { sourceFingerprint, transactions, issues };
}

function assertImportAccount(context: ImportContext): void {
  if (context.account.collectionMethod !== "statement_import") {
    throw new ValidationError("Statement imports are only allowed for import-configured accounts", {
      accountId: context.account.id,
    });
  }
}

function resolveColumns(headers: readonly string[], configured: CsvColumnMap | undefined): CsvColumnMap {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const result: Partial<Record<keyof CsvColumnMap, string>> = {};
  for (const key of Object.keys(ALIASES) as Array<keyof CsvColumnMap>) {
    const configuredName = configured?.[key];
    if (configuredName !== undefined) {
      const exact = normalizedHeaders.get(normalizeHeader(configuredName));
      if (exact === undefined) throw new ValidationError(`Configured CSV column '${configuredName}' is missing`, { key });
      result[key] = exact;
      continue;
    }
    const alias = ALIASES[key].map(normalizeHeader).find((candidate) => normalizedHeaders.has(candidate));
    if (alias !== undefined) {
      const header = normalizedHeaders.get(alias);
      if (header !== undefined) result[key] = header;
    }
  }
  return result;
}

function resolveAmount(record: CsvRecord, columns: CsvColumnMap): string {
  if (columns.amount !== undefined) return record[columns.amount] ?? "";
  const debit = optionalValue(record, columns.debit);
  const credit = optionalValue(record, columns.credit);
  if (debit !== undefined && credit !== undefined) {
    throw new ValidationError("Both debit and credit are populated");
  }
  if (debit !== undefined) return debit;
  if (credit !== undefined) return `-${credit}`;
  throw new ValidationError("Amount is empty");
}

function optionalValue(record: CsvRecord, column: string | undefined): string | undefined {
  if (column === undefined) return undefined;
  const value = record[column]?.normalize("NFKC").trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function parseCountry(value: string | undefined): IsoCountryCode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize("NFKC").trim().toLocaleUpperCase("en-US");
  if (["US", "USA", "UNITED STATES", "アメリカ", "米国"].includes(normalized)) return "US";
  if (["JP", "JPN", "JAPAN", "日本"].includes(normalized)) return "JP";
  if (["UK", "UNITED KINGDOM", "英国", "イギリス"].includes(normalized)) return "GB";
  if (["FRANCE", "フランス"].includes(normalized)) return "FR";
  return parseIsoCountryCode(normalized);
}
