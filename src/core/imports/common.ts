import { createHash } from "node:crypto";

import Decimal from "decimal.js";

import type { AmexAccount, CurrencyCode, FinancialTransaction, TransactionSource } from "../domain";
import { ValidationError } from "../errors";
import { canonicalCurrencyAmount, parseCurrencyAmount } from "../money";
import type { AmountConvention } from "./types";

export function sourceFor(account: AmexAccount, businessPurpose?: string | null): TransactionSource {
  return {
    accountId: account.id,
    legalEntityId: account.legalEntityId,
    legalEntityName: account.legalEntityName,
    country: account.country,
    accountClass: account.accountClass,
    accountCurrency: account.currency,
    businessPurpose: businessPurpose === undefined ? account.businessPurpose : businessPurpose,
  };
}

export function normalizeImportedAmount(raw: string, currency: CurrencyCode, convention: AmountConvention): string {
  const normalized = raw
    .normalize("NFKC")
    .trim()
    .replace(/[,$¥￥\s]/gu, "")
    .replace(/^\((.*)\)$/u, "-$1");
  if (normalized.length === 0) throw new ValidationError("Amount is empty");
  let amount: Decimal;
  try {
    amount = new Decimal(normalized);
  } catch {
    throw new ValidationError("Amount is not a valid decimal", { value: raw });
  }
  if (!amount.isFinite()) throw new ValidationError("Amount is not finite", { value: raw });
  if (convention === "amex_charges_positive") amount = amount.negated();
  parseCurrencyAmount(amount.toString(), currency, "import amount");
  return canonicalCurrencyAmount(amount, currency, "import amount");
}

export function parseImportDate(raw: string, country: AmexAccount["country"]): string {
  const value = raw.normalize("NFKC").trim();
  let year: number;
  let month: number;
  let day: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/u.exec(value);
  if (match !== null) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{1,2})\/(\d{1,2})(?:\/|')(\d{2}|\d{4})$/u.exec(value);
    if (match === null) throw new ValidationError("Unsupported transaction date", { value: raw });
    const first = Number(match[1]);
    const second = Number(match[2]);
    const shortYear = Number(match[3]);
    year = shortYear < 100 ? 2000 + shortYear : shortYear;
    if (country === "US") {
      month = first;
      day = second;
    } else {
      month = second;
      day = first;
    }
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ValidationError("Invalid transaction date", { value: raw });
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function importedTransactionId(accountId: string, sourceFingerprint: string, rowKey: string): string {
  return `txn_${createHash("sha256")
    .update([accountId, sourceFingerprint, rowKey].join("\u0000"))
    .digest("hex")
    .slice(0, 24)}`;
}

export function transactionFingerprint(input: {
  readonly accountId: string;
  readonly externalId?: string;
  readonly postedAt: string;
  readonly amount: string;
  readonly currency: CurrencyCode;
  readonly description: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.accountId,
        input.externalId ?? "",
        input.postedAt,
        canonicalCurrencyAmount(input.amount, input.currency),
        input.currency,
        input.description.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"),
      ].join("\u0000"),
    )
    .digest("hex");
}

export function withImportFingerprint(
  transaction: Omit<FinancialTransaction, "importFingerprint">,
): FinancialTransaction {
  return {
    ...transaction,
    importFingerprint: transactionFingerprint({
      accountId: transaction.source.accountId,
      ...(transaction.externalId === undefined ? {} : { externalId: transaction.externalId }),
      postedAt: transaction.postedAt,
      amount: transaction.amount,
      currency: transaction.currency,
      description: transaction.description,
    }),
  };
}
