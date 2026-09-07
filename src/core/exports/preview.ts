import { createHash, timingSafeEqual } from "node:crypto";

import type { FinancialTransaction } from "../domain";
import { ExportApprovalError } from "../errors";
import { previewExportFiles } from "./generate";
import { assertExportPlanIntegrity, planExport } from "./plan";
import type {
  ExportDuplicateReport,
  ExportHistoryRecord,
  ExportMapping,
  ExportPlan,
  ExportPreview,
  ExportPreviewFile,
} from "./types";

export function previewExport(input: {
  readonly mapping: ExportMapping;
  readonly transactions: readonly FinancialTransaction[];
  readonly history?: readonly ExportHistoryRecord[];
  readonly createdAt: string;
}): ExportPreview {
  const plan = planExport(input);
  return createExportPreview(plan);
}

export function createExportPreview(plan: ExportPlan): ExportPreview {
  assertExportPlanIntegrity(plan);
  const rendered = previewExportFiles(plan);
  const duplicateReport = buildDuplicateReport(plan);
  const fingerprint = computePreviewFingerprint({
    plan,
    duplicateReport,
    files: rendered.files,
    warnings: rendered.warnings,
  });
  return {
    schemaVersion: 1,
    previewFingerprint: fingerprint,
    createdAt: plan.createdAt,
    plan: structuredClone(plan),
    duplicateReport,
    files: structuredClone(rendered.files),
    warnings: [...rendered.warnings],
    automaticPosting: false,
  };
}

export function assertExportPreviewIntegrity(preview: ExportPreview): void {
  if (preview.schemaVersion !== 1 || preview.automaticPosting !== false) {
    throw new ExportApprovalError("Export preview metadata is invalid");
  }
  assertExportPlanIntegrity(preview.plan);
  const rendered = previewExportFiles(preview.plan);
  const duplicateReport = buildDuplicateReport(preview.plan);
  const actual = computePreviewFingerprint({
    plan: preview.plan,
    duplicateReport,
    files: rendered.files,
    warnings: rendered.warnings,
  });
  if (
    preview.createdAt !== preview.plan.createdAt ||
    !safeDigestEqual(actual, preview.previewFingerprint) ||
    !sameJson(preview.duplicateReport, duplicateReport) ||
    !sameJson(preview.files, rendered.files) ||
    !sameJson(preview.warnings, rendered.warnings)
  ) {
    throw new ExportApprovalError("Export preview changed and requires fresh human review", {
      planId: preview.plan.id,
    });
  }
}

export function buildDuplicateReport(plan: ExportPlan): ExportDuplicateReport {
  const alreadyExportedCount = plan.duplicates.filter((item) => item.reason === "already_exported").length;
  const duplicateInSelectionCount = plan.duplicates.length - alreadyExportedCount;
  return {
    selectedTransactionCount: plan.eligibleTransactions.length + plan.duplicates.length,
    eligibleTransactionCount: plan.eligibleTransactions.length,
    excludedTransactionCount: plan.duplicates.length,
    alreadyExportedCount,
    duplicateInSelectionCount,
    candidates: structuredClone(plan.duplicates),
  };
}

export function computePreviewFingerprint(input: {
  readonly plan: ExportPlan;
  readonly duplicateReport: ExportDuplicateReport;
  readonly files: readonly ExportPreviewFile[];
  readonly warnings: readonly string[];
}): string {
  return createHash("sha256")
    .update("amex-local-export-preview\u0000v1\u0000", "utf8")
    .update(
      JSON.stringify({
        requestDigest: input.plan.requestDigest,
        duplicateReport: input.duplicateReport,
        files: input.files,
        warnings: input.warnings,
        automaticPosting: false,
      }),
      "utf8",
    )
    .digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
