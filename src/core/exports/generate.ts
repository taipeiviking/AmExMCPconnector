import { createHash } from "node:crypto";

import { ExportApprovalError } from "../errors";
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
  if (input.generatedAt !== input.plan.createdAt) {
    throw new ExportApprovalError("The generated timestamp differs from the approved export preview", {
      planId: input.plan.id,
    });
  }

  // Render before burning the one-time approval. A format/encoding validation
  // failure therefore cannot consume an approval without producing a package.
  const packageResult = renderExportPackage(input.plan, input.generatedAt);
  input.approvalAuthority.consumeApproval(input.plan, input.approval);
  return packageResult;
}

/**
 * Computes byte metadata for the review screen without returning export bytes.
 * Materialization still requires a valid one-time human approval.
 */
export function previewExportFiles(plan: ExportPlan): {
  readonly files: readonly {
    readonly fileName: string;
    readonly mediaType: string;
    readonly encoding: ExportFile["encoding"];
    readonly byteLength: number;
    readonly sha256: string;
  }[];
  readonly warnings: readonly string[];
} {
  assertExportPlanIntegrity(plan);
  const packageResult = renderExportPackage(plan, plan.createdAt);
  const files = packageResult.files.map((file) => ({
    fileName: file.fileName,
    mediaType: file.mediaType,
    encoding: file.encoding,
    byteLength: file.bytes.byteLength,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }));
  for (const file of packageResult.files) file.bytes.fill(0);
  return { files, warnings: packageResult.warnings };
}

function renderExportPackage(plan: ExportPlan, generatedAt: string): ExportPackage {
  let file: ExportFile;
  const warnings: string[] = [];
  switch (plan.mapping.format) {
    case "quickbooks_csv":
      file = buildQuickBooksCsv(plan.eligibleTransactions, plan.mapping);
      break;
    case "quickbooks_qbo":
      file = buildQuickBooksOfx(plan.eligibleTransactions, plan.mapping, "qbo", generatedAt);
      break;
    case "quickbooks_qfx":
      file = buildQuickBooksOfx(plan.eligibleTransactions, plan.mapping, "qfx", generatedAt);
      break;
    case "money_forward_statement_csv": {
      const built = buildMoneyForwardStatementCsv(plan.eligibleTransactions, plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
    case "money_forward_journal_csv": {
      const built = buildMoneyForwardJournalCsv(plan.eligibleTransactions, plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
    case "money_forward_ledger_csv": {
      const built = buildMoneyForwardLedgerCsv(plan.eligibleTransactions, plan.mapping);
      file = built.file;
      if (built.warning !== undefined) warnings.push(built.warning);
      break;
    }
  }

  return {
    planId: plan.id,
    format: plan.mapping.format,
    accountId: plan.mapping.accountId,
    legalEntityId: plan.mapping.legalEntityId,
    createdAt: generatedAt,
    files: [file],
    duplicateReport: structuredClone(plan.duplicates),
    historyRecords: plan.eligibleTransactions.map((transaction) => ({
      format: plan.mapping.format,
      accountId: plan.mapping.accountId,
      transactionId: transaction.id,
      transactionFingerprint: exportTransactionFingerprint(transaction),
      exportedAt: generatedAt,
    })),
    warnings,
    automaticPosting: false,
  };
}
