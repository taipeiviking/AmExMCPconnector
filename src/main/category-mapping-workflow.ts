import { mapTransactionCategory, type ParsedTransactionImport } from "../core";
import { loadCategoryRules } from "./category-rule-loader";

export interface AppliedCategoryMapping {
  readonly parsed: ParsedTransactionImport;
  readonly sourceFingerprint?: string;
  readonly matchedTransactionCount: number;
}

/** Applies one immutable snapshot of the owner-authored mapping file to an
 * import preview. The mapping file fingerprint must be checked again at the
 * human-approved commit boundary. */
export async function applyConfiguredCategoryMapping(
  parsed: ParsedTransactionImport,
  mappingFilePath: string | undefined,
): Promise<AppliedCategoryMapping> {
  if (mappingFilePath === undefined) {
    return { parsed, matchedTransactionCount: 0 };
  }

  const loaded = await loadCategoryRules(mappingFilePath);
  let matchedTransactionCount = 0;
  const transactions = parsed.transactions.map((transaction) => {
    const mapping = mapTransactionCategory(transaction, loaded.rules);
    if (mapping.matchedRuleId === null) return transaction;
    matchedTransactionCount += 1;
    return {
      ...transaction,
      categoryId: mapping.categoryId,
      source: {
        ...transaction.source,
        businessPurpose: mapping.businessPurpose,
      },
    };
  });
  const normalizedTransactions = parsed.normalizedTransactions.map((transaction, index) => {
    const mapped = transactions[index];
    if (mapped === undefined || mapped === parsed.transactions[index]) return transaction;
    return {
      ...transaction,
      categoryId: mapped.categoryId,
      source: {
        ...transaction.source,
        businessPurpose: mapped.source.businessPurpose,
      },
    };
  });

  return {
    parsed: { ...parsed, transactions, normalizedTransactions },
    sourceFingerprint: loaded.sourceFingerprint,
    matchedTransactionCount,
  };
}

export async function assertCategoryMappingUnchanged(
  mappingFilePath: string | undefined,
  expectedFingerprint: string | undefined,
): Promise<void> {
  if (mappingFilePath === undefined && expectedFingerprint === undefined) return;
  if (mappingFilePath === undefined || expectedFingerprint === undefined) {
    throw new Error("The category mapping configuration changed after preview. Preview the statement again.");
  }
  const current = await loadCategoryRules(mappingFilePath);
  if (current.sourceFingerprint !== expectedFingerprint) {
    throw new Error("The category mapping file changed after preview. Preview the statement again.");
  }
}
