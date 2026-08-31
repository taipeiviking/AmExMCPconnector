import {
  fingerprintBytes,
  importedTransactionId,
  normalizeImportedAmount,
  parseImportDate,
  sourceFor,
  withImportFingerprint,
} from "./common";
import type { AmountConvention, ImportContext, ImportIssue, ParsedTransactionImport } from "./types";
import { ValidationError } from "../errors";

export interface ParseQifOptions {
  readonly amountConvention?: AmountConvention;
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
  const content = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const lines = content.split("\n");
  const issues: ImportIssue[] = [];
  const records: Array<Record<string, string[]>> = [];
  let current: Record<string, string[]> = {};
  let typeSeen = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("!Type:")) {
      typeSeen = true;
      const type = line.slice(6).trim().toLocaleLowerCase("en-US");
      if (!["ccard", "bank", "cash"].includes(type)) {
        issues.push({ severity: "warning", code: "QIF_TYPE", message: `QIF type '${type}' is unusual for card data`, row: index + 1 });
      }
      continue;
    }
    if (line === "^") {
      if (Object.keys(current).length > 0) records.push(current);
      current = {};
      continue;
    }
    if (line.length === 0) continue;
    const code = line[0];
    if (code === undefined) continue;
    const value = line.slice(1).trim();
    (current[code] ??= []).push(value);
  }
  if (Object.keys(current).length > 0) records.push(current);
  if (!typeSeen) issues.push({ severity: "warning", code: "QIF_TYPE_MISSING", message: "QIF file has no !Type header" });

  const transactions = records.flatMap((record, index) => {
    const row = index + 1;
    try {
      const date = first(record, "D");
      const rawAmount = first(record, "T");
      const description = (optionalFirst(record, "P") ?? optionalFirst(record, "M") ?? "").normalize("NFKC").trim();
      if (description.length === 0) throw new ValidationError("QIF payee/memo is empty");
      const postedAt = parseImportDate(date, context.account.country);
      const amount = normalizeImportedAmount(
        rawAmount,
        context.account.currency,
        options.amountConvention ?? "signed_ledger",
      );
      const externalId = optionalFirst(record, "N");
      const rowKey = externalId ?? `${row}|${postedAt}|${amount}|${description}`;
      return [
        withImportFingerprint({
          id: importedTransactionId(context.account.id, sourceFingerprint, rowKey),
          ...(externalId === undefined ? {} : { externalId }),
          source: sourceFor(context.account),
          postedAt,
          description,
          amount,
          currency: context.account.currency,
          categoryId: optionalFirst(record, "L") ?? null,
          memo: optionalFirst(record, "M") ?? null,
          importedAt: context.importedAt,
        }),
      ];
    } catch (caught) {
      issues.push({
        severity: "error",
        code: "INVALID_QIF_RECORD",
        message: caught instanceof Error ? caught.message : "Invalid QIF record",
        row,
      });
      return [];
    }
  });
  return { sourceFingerprint, transactions, issues };
}

function first(record: Record<string, string[]>, code: string): string {
  const value = optionalFirst(record, code);
  if (value === undefined) throw new ValidationError(`QIF record is missing '${code}'`);
  return value;
}

function optionalFirst(record: Record<string, string[]>, code: string): string | undefined {
  const value = record[code]?.[0]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
