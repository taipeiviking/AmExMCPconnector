import Decimal from "decimal.js";

import type { FinancialTransaction } from "../domain";
import { ValidationError } from "../errors";
import { csvRow, encodeText, fileSafe, safeTextCell } from "./csv-utils";
import type { ExportFile, ExportMapping, TextExportEncoding } from "./types";

export function buildMoneyForwardStatementCsv(
  transactions: readonly FinancialTransaction[],
  mapping: ExportMapping,
): { readonly file: ExportFile; readonly warning?: string } {
  const moneyForward = requireMapping(mapping);
  const encoding = moneyForward.encoding ?? "utf8_bom";
  const rows = [
    csvRow(["日付", "内容", "出金", "入金", "残高", "メモ"]),
    ...transactions.map((transaction) => {
      const amount = jpyAmount(transaction, "statement");
      return csvRow([
        slashDate(transaction.postedAt),
        safeTextCell(transaction.description),
        amount.isNegative() ? amount.abs().toFixed(0) : "",
        amount.isPositive() ? amount.toFixed(0) : "",
        "",
        safeTextCell(buildMemo(transaction)),
      ]);
    }),
  ];
  const encoded = encodeText(`${rows.join("\r\n")}\r\n`, encoding);
  return {
    file: {
      fileName: `${fileSafe(mapping.accountId)}-money-forward-statement.csv`,
      mediaType: "text/csv",
      encoding,
      bytes: encoded.bytes,
    },
    ...(encoded.lossy ? { warning: "Shift-JIS encoding replaced one or more unsupported characters; review the file." } : {}),
  };
}

export function buildMoneyForwardJournalCsv(
  transactions: readonly FinancialTransaction[],
  mapping: ExportMapping,
): { readonly file: ExportFile; readonly warning?: string } {
  const moneyForward = requireMapping(mapping);
  const encoding: TextExportEncoding = moneyForward.encoding ?? "shift_jis";
  const rows = [
    csvRow([
      "取引No",
      "取引日",
      "借方勘定科目",
      "借方補助科目",
      "借方部門",
      "借方税区分",
      "借方金額(円)",
      "貸方勘定科目",
      "貸方補助科目",
      "貸方部門",
      "貸方税区分",
      "貸方金額(円)",
      "摘要",
    ]),
    ...transactions.map((transaction, index) => {
      const amount = jpyAmount(transaction, "journal");
      const charge = amount.isNegative();
      const absolute = amount.abs().toFixed(0);
      return csvRow([
        index + 1,
        slashDate(transaction.postedAt),
        safeTextCell(charge ? moneyForward.expenseAccount : moneyForward.liabilityAccount),
        "",
        safeTextCell(moneyForward.department ?? ""),
        safeTextCell(moneyForward.taxCategory ?? "対象外"),
        absolute,
        safeTextCell(charge ? moneyForward.liabilityAccount : moneyForward.expenseAccount),
        "",
        safeTextCell(moneyForward.department ?? ""),
        safeTextCell(moneyForward.taxCategory ?? "対象外"),
        absolute,
        safeTextCell(buildMemo(transaction)),
      ]);
    }),
  ];
  const encoded = encodeText(`${rows.join("\r\n")}\r\n`, encoding);
  return {
    file: {
      fileName: `${fileSafe(mapping.accountId)}-money-forward-journal.csv`,
      mediaType: "text/csv",
      encoding,
      bytes: encoded.bytes,
    },
    ...(encoded.lossy ? { warning: "Shift-JIS encoding replaced one or more unsupported characters; review the file." } : {}),
  };
}

/**
 * Produces a liability-account ledger import view. Charges are credits to the
 * mapped card liability account; payments/credits are debits. The counterparty
 * account remains explicit for human review before Money Forward import.
 */
export function buildMoneyForwardLedgerCsv(
  transactions: readonly FinancialTransaction[],
  mapping: ExportMapping,
): { readonly file: ExportFile; readonly warning?: string } {
  const moneyForward = requireMapping(mapping);
  const encoding: TextExportEncoding = moneyForward.encoding ?? "shift_jis";
  const rows = [
    csvRow([
      "取引No",
      "取引日",
      "勘定科目",
      "補助科目",
      "部門",
      "相手勘定科目",
      "税区分",
      "借方金額(円)",
      "貸方金額(円)",
      "摘要",
    ]),
    ...transactions.map((transaction, index) => {
      const amount = jpyAmount(transaction, "ledger");
      const charge = amount.isNegative();
      return csvRow([
        index + 1,
        slashDate(transaction.postedAt),
        safeTextCell(moneyForward.liabilityAccount),
        "",
        safeTextCell(moneyForward.department ?? ""),
        safeTextCell(moneyForward.expenseAccount),
        safeTextCell(moneyForward.taxCategory ?? "対象外"),
        charge ? "" : amount.abs().toFixed(0),
        charge ? amount.abs().toFixed(0) : "",
        safeTextCell(buildMemo(transaction)),
      ]);
    }),
  ];
  const encoded = encodeText(`${rows.join("\r\n")}\r\n`, encoding);
  return {
    file: {
      fileName: `${fileSafe(mapping.accountId)}-money-forward-ledger.csv`,
      mediaType: "text/csv",
      encoding,
      bytes: encoded.bytes,
    },
  };
}

function requireMapping(mapping: ExportMapping) {
  if (mapping.moneyForward === undefined) throw new ValidationError("Money Forward mapping is missing");
  return mapping.moneyForward;
}

function slashDate(value: string): string {
  return value.replace(/-/gu, "/");
}

function buildMemo(transaction: FinancialTransaction): string {
  return [
    transaction.description,
    transaction.source.businessPurpose === null ? "" : `用途:${transaction.source.businessPurpose}`,
    `source:${transaction.source.accountId}`,
  ]
    .filter((part) => part.length > 0)
    .join(" | ");
}

function jpyAmount(transaction: FinancialTransaction, format: "statement" | "journal" | "ledger"): Decimal {
  if (transaction.currency !== "JPY") {
    throw new ValidationError(`Money Forward ${format} CSV requires JPY transactions`, {
      transactionId: transaction.id,
      currency: transaction.currency,
    });
  }
  const amount = new Decimal(transaction.amount);
  if (!amount.isInteger()) {
    throw new ValidationError(`Money Forward ${format} CSV cannot round fractional JPY amounts`, {
      transactionId: transaction.id,
      amount: transaction.amount,
    });
  }
  return amount;
}
