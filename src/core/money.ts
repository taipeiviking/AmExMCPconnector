import Decimal from "decimal.js";

import type { CurrencyCode } from "./domain";
import { ValidationError } from "./errors";

const MINOR_UNITS: Readonly<Record<CurrencyCode, number>> = {
  USD: 2,
  JPY: 0,
};

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/u;

export function currencyMinorUnits(currency: CurrencyCode): number {
  return MINOR_UNITS[currency];
}

/** Parses without rounding and rejects precision the currency cannot represent. */
export function parseCurrencyAmount(value: string, currency: CurrencyCode, field = "amount"): Decimal {
  if (typeof value !== "string" || !PLAIN_DECIMAL.test(value.trim())) {
    throw new ValidationError(`${field} must be a plain decimal string`, { field, value, currency });
  }
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    throw new ValidationError(`${field} is not a valid decimal amount`, { field, value, currency });
  }
  if (!amount.isFinite()) {
    throw new ValidationError(`${field} must be finite`, { field, value, currency });
  }
  const minorUnits = currencyMinorUnits(currency);
  if (amount.decimalPlaces() > minorUnits) {
    throw new ValidationError(`${field} exceeds ${currency} minor-unit precision`, {
      field,
      value,
      currency,
      allowedDecimalPlaces: minorUnits,
    });
  }
  return amount;
}

/** Canonical fixed-minor-unit representation; input is validated before formatting. */
export function canonicalCurrencyAmount(value: string | Decimal, currency: CurrencyCode, field = "amount"): string {
  const amount = typeof value === "string" ? parseCurrencyAmount(value, currency, field) : value;
  const minorUnits = currencyMinorUnits(currency);
  if (!amount.isFinite() || amount.decimalPlaces() > minorUnits) {
    throw new ValidationError(`${field} exceeds ${currency} minor-unit precision`, {
      field,
      value: amount.toString(),
      currency,
      allowedDecimalPlaces: minorUnits,
    });
  }
  return amount.isZero() ? new Decimal(0).toFixed(minorUnits) : amount.toFixed(minorUnits);
}
