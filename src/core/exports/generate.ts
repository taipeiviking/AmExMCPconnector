import type { HmacExportApprovalAuthority } from "./approval";
import { exportTransactionFingerprint } from "./duplicates";
import {
  buildMoneyForwardJournalCsv,
  buildMoneyForwardLedgerCsv,
  buildMoneyForwardStatementCsv,
} from "./money-forward";
import { buildQuickBooksCsv, buildQuickBooksOfx } from "./quickbooks";
import { assertExportPlanIntegrity } from "./plan";
import type { ExportFile, ExportPackage, ExportPlan, HumanExportApproval } from "./types";

export function generateExportPackage(input: {
  readonly plan: ExportPlan;
  readonly approval: HumanExportApproval;
  readonly approvalAuthority: HmacExportApprovalAuthority;
  readonly generatedAt: string;
}): ExportPackage {
  // ExportPlan is readonly at compile time, but callers can still mutate plain
  // JavaScript objects. Recompute before rendering so approval cannot be reused
  // for altered mappings, transactions, or duplicate reports.
  assertExportPlanIntegrity(input.plan);
  input.approvalAuthority.consumeApproval(input.plan, input.approval);

  let file: ExportFile;
  const warnings: string[] = [];
  switch (input.plan.mapping.format) {
    case "quickbooks_csv":
      file = buildQuickBooksCsv(input.plan.eligibleTransactions, input.plan.mapping);
      break;
    case "quickbooks_qbo":
      file = buildQuickBooksOfx(input.plan.eligibleTransactions, input.plan.mapping, "qbo", input.generatedAt);
      break;
    case "quickbooks_qfx":
      file = buildQuickBooksOfx(input.plan.eligibleTransactions, input.plan.mapping, "qfx", input.generatedAt);
      break;
    case "money_forward_statement_csv": {
      const built = buildMoneyForwardStatementCsv(input.plan.eligibleTransactions, input.plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
    case "money_forward_journal_csv": {
      const built = buildMoneyForwardJournalCsv(input.plan.eligibleTransactions, input.plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
    case "money_forward_ledger_csv": {
      const built = buildMoneyForwardLedgerCsv(input.plan.eligibleTransactions, input.plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
  }

  return {
    planId: input.plan.id,
    format: input.plan.mapping.format,
    accountId: input.plan.mapping.accountId,
    legalEntityId: input.plan.mapping.legalEntityId,
    createdAt: input.generatedAt,
    files: [file],
    duplicateReport: structuredClone(input.plan.duplicates),
    historyRecords: input.plan.eligibleTransactions.map((transaction) => ({
      format: input.plan.mapping.format,
      accountId: input.plan.mapping.accountId,
      transactionId: transaction.id,
      transactionFingerprint: exportTransactionFingerprint(transaction),
      exportedAt: input.generatedAt,
    })),
    warnings,
    automaticPosting: false,
  };
}
