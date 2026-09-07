import type { IsoCountryCode } from "../country-codes";
import { parseIsoCountryCode } from "../country-codes";
import { ValidationError } from "../errors";
import {
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
  ImportIssue,
  NormalizedImportTransaction,
  ParsedTransactionImport,
  StatementImportFormat,
} from "./types";

const MAX_TABULAR_ROWS = 100_000;
const MAX_TABULAR_COLUMNS = 256;

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

export interface ParseTabularRowsOptions {
  readonly format: Extract<StatementImportFormat, "csv" | "xlsx" | "pdf">;
  readonly sourceFingerprint: string;
  readonly inputBytes: number;
  readonly encoding?: "utf8" | "shift_jis" | "cp932";
  readonly columns?: CsvColumnMap;
  readonly amountConvention?: AmountConvention;
  readonly headerRow?: number;
  readonly sourceRowNumbers?: readonly number[];
}

export function parseTabularRows(
  rows: readonly (readonly string[])[],
  context: ImportContext,
  options: ParseTabularRowsOptions,
): ParsedTransactionImport {
  assertImportAccount(context);
  if (rows.length > MAX_TABULAR_ROWS + 1) {
    throw new ValidationError("Statement contains more than 100,000 rows");
  }
  if (rows.some((row) => row.length > MAX_TABULAR_COLUMNS)) {
    throw new ValidationError("Statement contains more than 256 columns");
  }

  const headerIndex = options.headerRow === undefined
    ? firstNonEmptyRow(rows)
    : options.sourceRowNumbers === undefined
      ? options.headerRow - 1
      : options.sourceRowNumbers.findIndex((row) => row === options.headerRow);
  if (headerIndex < 0 || headerIndex >= rows.length) {
    if (options.headerRow !== undefined) {
      throw new ValidationError(`Configured header row ${options.headerRow} is missing`);
    }
    return emptyParsedImport(context, options);
  }
  const header = rows[headerIndex] ?? [];
  const headers = header.map((value) => value.normalize("NFKC").trim());
  assertUniqueHeaders(headers);
  const resolved = resolveColumns(headers, options.columns);
  if (resolved.date === undefined || resolved.description === undefined) {
    throw new ValidationError("Statement table must contain date and description columns", { headers });
  }
  if (resolved.amount === undefined && resolved.debit === undefined && resolved.credit === undefined) {
    throw new ValidationError("Statement table must contain an amount column or debit/credit columns", { headers });
  }

  const issues: ImportIssue[] = [];
  const normalizedTransactions: NormalizedImportTransaction[] = [];
  const transactions = rows.slice(headerIndex + 1).flatMap((cells, relativeIndex) => {
    if (cells.every((cell) => cell.trim().length === 0)) return [];
    const physicalIndex = headerIndex + 1 + relativeIndex;
    const sourceRow = options.sourceRowNumbers?.[physicalIndex] ?? physicalIndex + 1;
    const record = Object.fromEntries(headers.map((name, index) => [name, cells[index] ?? ""]));
    try {
      const normalized = normalizeTabularRecord(
        record,
        resolved,
        context,
        sourceRow,
        options.amountConvention,
        issues,
      );
      normalizedTransactions.push(normalized);
      const rowKey = normalized.externalId ??
        `${sourceRow}|${normalized.postedAt}|${normalized.amount}|${normalized.description}`;
      return [
        withImportFingerprint({
          id: importedTransactionId(context.account.id, options.sourceFingerprint, rowKey),
          ...(normalized.externalId === undefined ? {} : { externalId: normalized.externalId }),
          source: normalized.source,
          postedAt: normalized.postedAt,
          description: normalized.description,
          amount: normalized.amount,
          currency: normalized.currency,
          categoryId: normalized.categoryId,
          memo: normalized.memo,
          ...(normalized.merchantCountry === undefined ? {} : { merchantCountry: normalized.merchantCountry }),
          importedAt: context.importedAt,
        }),
      ];
    } catch (caught) {
      issues.push({
        severity: "error",
        code: `INVALID_${options.format.toLocaleUpperCase("en-US")}_ROW`,
        message: caught instanceof Error ? caught.message : "Invalid row",
        row: sourceRow,
      });
      return [];
    }
  });

  return {
    sourceFingerprint: options.sourceFingerprint,
    normalizedTransactions,
    transactions,
    issues,
    metadata: {
      format: options.format,
      ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
      ...(context.sourceFileName === undefined ? {} : { sourceFileName: context.sourceFileName }),
      inputBytes: options.inputBytes,
      parsedRows: rows.length - headerIndex - 1,
    },
  };
}

function normalizeTabularRecord(
  record: Readonly<Record<string, string>>,
  columns: CsvColumnMap,
  context: ImportContext,
  sourceRow: number,
  convention: AmountConvention | undefined,
  issues: ImportIssue[],
): NormalizedImportTransaction {
  const postedAt = parseImportDate(record[columns.date ?? ""] ?? "", context.account.country);
  const description = (record[columns.description ?? ""] ?? "").normalize("NFKC").trim();
  if (description.length === 0) throw new ValidationError("Description is empty");
  const amount = normalizeImportedAmount(
    resolveAmount(record, columns),
    context.account.currency,
    convention ?? "amex_charges_positive",
  );
  const externalId = optionalValue(record, columns.reference);
  const importedCategory = optionalValue(record, columns.category);
  const importedBusinessPurpose = optionalValue(record, columns.businessPurpose);
  if (importedCategory !== undefined) {
    addIssueOnce(issues, {
      severity: "warning",
      code: "IMPORTED_CATEGORY_IGNORED",
      message: "Statement category values are issuer/source text and were not trusted as owner classifications; configure a reviewed local category mapping instead",
      row: sourceRow,
    });
  }
  if (importedBusinessPurpose !== undefined) {
    addIssueOnce(issues, {
      severity: "warning",
      code: "IMPORTED_BUSINESS_PURPOSE_IGNORED",
      message: "Statement business-purpose values were ignored; only the owner-controlled account default or reviewed local mapping is applied",
      row: sourceRow,
    });
  }
  const merchantCountryRaw = optionalValue(record, columns.merchantCountry);
  const merchantCountry = parseCountry(merchantCountryRaw);
  if (merchantCountryRaw !== undefined && merchantCountry === undefined) {
    issues.push({
      severity: "warning",
      code: "UNKNOWN_MERCHANT_COUNTRY",
      message: `Merchant country '${merchantCountryRaw}' was not recognized and was left unset`,
      row: sourceRow,
    });
  }
  return {
    sourceRow,
    ...(externalId === undefined ? {} : { externalId }),
    source: sourceFor(context.account),
    postedAt,
    description,
    amount,
    currency: context.account.currency,
    categoryId: null,
    memo: optionalValue(record, columns.memo) ?? null,
    ...(merchantCountry === undefined ? {} : { merchantCountry }),
  };
}

function addIssueOnce(issues: ImportIssue[], issue: ImportIssue): void {
  if (!issues.some((candidate) => candidate.code === issue.code)) issues.push(issue);
}

function emptyParsedImport(context: ImportContext, options: ParseTabularRowsOptions): ParsedTransactionImport {
  return {
    sourceFingerprint: options.sourceFingerprint,
    normalizedTransactions: [],
    transactions: [],
    issues: [],
    metadata: {
      format: options.format,
      ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
      ...(context.sourceFileName === undefined ? {} : { sourceFileName: context.sourceFileName }),
      inputBytes: options.inputBytes,
      parsedRows: 0,
    },
  };
}

function firstNonEmptyRow(rows: readonly (readonly string[])[]): number {
  return rows.findIndex((row) => row.some((cell) => cell.trim().length > 0));
}

function assertUniqueHeaders(headers: readonly string[]): void {
  const seen = new Set<string>();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) throw new ValidationError(`Statement repeats column '${header}'`);
    seen.add(normalized);
  }
}

function resolveColumns(headers: readonly string[], configured: CsvColumnMap | undefined): CsvColumnMap {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const result: Partial<Record<keyof CsvColumnMap, string>> = {};
  for (const key of Object.keys(ALIASES) as Array<keyof CsvColumnMap>) {
    const configuredName = configured?.[key];
    if (configuredName !== undefined) {
      const exact = normalizedHeaders.get(normalizeHeader(configuredName));
      if (exact === undefined) throw new ValidationError(`Configured column '${configuredName}' is missing`, { key });
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

function resolveAmount(record: Readonly<Record<string, string>>, columns: CsvColumnMap): string {
  if (columns.amount !== undefined) return record[columns.amount] ?? "";
  const debit = optionalValue(record, columns.debit);
  const credit = optionalValue(record, columns.credit);
  if (debit !== undefined && credit !== undefined) throw new ValidationError("Both debit and credit are populated");
  if (debit !== undefined) return debit;
  if (credit !== undefined) return `-${credit}`;
  throw new ValidationError("Amount is empty");
}

function optionalValue(record: Readonly<Record<string, string>>, column: string | undefined): string | undefined {
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

function assertImportAccount(context: ImportContext): void {
  if (context.account.collectionMethod !== "statement_import") {
    throw new ValidationError("Statement imports are only allowed for import-configured accounts", {
      accountId: context.account.id,
    });
  }
}
