import type { FinancialTransaction } from "./domain";

export type CategoryMatch =
  | { readonly kind: "description_contains"; readonly value: string }
  | { readonly kind: "description_prefix"; readonly value: string }
  | { readonly kind: "merchant_equals"; readonly value: string };

export interface CategoryRule {
  readonly id: string;
  readonly priority: number;
  readonly match: CategoryMatch;
  readonly categoryId: string;
  readonly businessPurpose?: string;
}

export interface CategoryMappingResult {
  readonly transactionId: string;
  readonly categoryId: string | null;
  readonly businessPurpose: string | null;
  readonly matchedRuleId: string | null;
}

export function mapTransactionCategory(
  transaction: FinancialTransaction,
  rules: readonly CategoryRule[],
): CategoryMappingResult {
  const ordered = [...rules].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const matched = ordered.find((rule) => matches(transaction, rule.match));
  if (matched === undefined) {
    return {
      transactionId: transaction.id,
      categoryId: transaction.categoryId,
      businessPurpose: transaction.source.businessPurpose,
      matchedRuleId: null,
    };
  }
  return {
    transactionId: transaction.id,
    categoryId: matched.categoryId,
    businessPurpose: matched.businessPurpose ?? transaction.source.businessPurpose,
    matchedRuleId: matched.id,
  };
}

function matches(transaction: FinancialTransaction, match: CategoryMatch): boolean {
  const expected = match.value.trim().toLocaleLowerCase("en-US");
  if (expected.length === 0) return false;
  const description = transaction.description.toLocaleLowerCase("en-US");
  const merchant = transaction.merchantName?.toLocaleLowerCase("en-US") ?? "";
  switch (match.kind) {
    case "description_contains":
      return description.includes(expected);
    case "description_prefix":
      return description.startsWith(expected);
    case "merchant_equals":
      return merchant === expected;
  }
}
