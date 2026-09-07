import { createHash } from "node:crypto";

import { ValidationError } from "../errors";
import { assertIsoInstant } from "../validation";
import { assertExportPreviewIntegrity } from "./preview";
import type {
  ExportDuplicateReport,
  ExportFile,
  ExportManifest,
  ExportManifestFile,
  ExportPackage,
  ExportPreview,
  HumanExportApproval,
} from "./types";

export const EXPORT_MANIFEST_FILE_NAME = "export-manifest.json";

export function buildExportManifest(input: {
  readonly preview: ExportPreview;
  readonly approval: HumanExportApproval;
  readonly package: ExportPackage;
}): ExportManifest {
  assertExportPreviewIntegrity(input.preview);
  assertPackageMatchesPreview(input.package, input.preview);
  if (
    input.approval.approved !== true ||
    input.approval.planId !== input.preview.plan.id ||
    input.approval.requestDigest !== input.preview.plan.requestDigest
  ) {
    throw new ValidationError("Export approval does not match the materialized preview");
  }
  assertIsoInstant(input.approval.approvedAt, "approval.approvedAt");
  if (input.approval.approvedBy.trim().length === 0) {
    throw new ValidationError("Export approval actor is required in the manifest");
  }

  const files = input.package.files.map(fileManifestEntry);
  return {
    schemaVersion: 1,
    planId: input.preview.plan.id,
    previewFingerprint: input.preview.previewFingerprint,
    requestDigest: input.preview.plan.requestDigest,
    format: input.package.format,
    accountId: input.package.accountId,
    legalEntityId: input.package.legalEntityId,
    generatedAt: input.package.createdAt,
    approvedAt: input.approval.approvedAt,
    approvedBy: input.approval.approvedBy,
    files,
    packageSha256: computePackageSha256(files),
    duplicateReport: structuredClone(input.preview.duplicateReport),
    historyRecords: structuredClone(input.package.historyRecords),
    warnings: [...input.package.warnings],
    automaticPosting: false,
  };
}

export function encodeExportManifest(manifest: ExportManifest): Uint8Array {
  validateExportManifest(manifest);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function parseExportManifest(bytes: Uint8Array): ExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ValidationError("Export manifest is not valid UTF-8 JSON");
  }
  validateExportManifest(parsed);
  return structuredClone(parsed);
}

export function validateExportManifest(value: unknown): asserts value is ExportManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.automaticPosting !== false) {
    throw new ValidationError("Export manifest has an unsupported schema or posting boundary");
  }
  for (const field of ["planId", "previewFingerprint", "requestDigest", "accountId", "legalEntityId"] as const) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new ValidationError(`Export manifest ${field} is missing`);
    }
  }
  const previewFingerprint = value.previewFingerprint as string;
  const requestDigest = value.requestDigest as string;
  if (!isSha256(previewFingerprint) || !isSha256(requestDigest)) {
    throw new ValidationError("Export manifest fingerprints are invalid");
  }
  if (typeof value.generatedAt !== "string" || typeof value.approvedAt !== "string") {
    throw new ValidationError("Export manifest timestamps are missing");
  }
  assertIsoInstant(value.generatedAt, "manifest.generatedAt");
  assertIsoInstant(value.approvedAt, "manifest.approvedAt");
  if (typeof value.approvedBy !== "string" || value.approvedBy.trim().length === 0) {
    throw new ValidationError("Export manifest approval actor is missing");
  }
  if (!isExportFormat(value.format)) throw new ValidationError("Export manifest format is unsupported");
  if (!Array.isArray(value.files) || value.files.length === 0 || !value.files.every(isManifestFile)) {
    throw new ValidationError("Export manifest file inventory is invalid");
  }
  const names = new Set<string>();
  for (const file of value.files) {
    const key = file.fileName.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new ValidationError("Export manifest repeats a file name", { fileName: file.fileName });
    names.add(key);
  }
  if (typeof value.packageSha256 !== "string" || value.packageSha256 !== computePackageSha256(value.files)) {
    throw new ValidationError("Export manifest package checksum is invalid");
  }
  validateDuplicateReport(value.duplicateReport);
  if (!Array.isArray(value.historyRecords) || !value.historyRecords.every(isHistoryRecord)) {
    throw new ValidationError("Export manifest history records are invalid");
  }
  if (value.historyRecords.length !== (value.duplicateReport as ExportDuplicateReport).eligibleTransactionCount) {
    throw new ValidationError("Export manifest history does not reconcile with its eligible transaction total");
  }
  for (const record of value.historyRecords) {
    if (record.accountId !== value.accountId || record.format !== value.format || record.exportedAt !== value.generatedAt) {
      throw new ValidationError("Export manifest history is outside the approved account, format, or generation time");
    }
    assertIsoInstant(record.exportedAt, "manifest.historyRecords.exportedAt");
  }
  if (!Array.isArray(value.warnings) || !value.warnings.every((item) => typeof item === "string")) {
    throw new ValidationError("Export manifest warnings are invalid");
  }
}

export function computePackageSha256(files: readonly ExportManifestFile[]): string {
  const hash = createHash("sha256").update("amex-local-export-package\u0000v1\u0000", "utf8");
  for (const file of files) {
    hash
      .update(file.fileName, "utf8")
      .update("\u0000", "utf8")
      .update(file.sha256, "ascii")
      .update("\u0000", "utf8")
      .update(String(file.byteLength), "ascii")
      .update("\u0000", "utf8");
  }
  return hash.digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPackageMatchesPreview(packageResult: ExportPackage, preview: ExportPreview): void {
  if (
    packageResult.automaticPosting !== false ||
    packageResult.planId !== preview.plan.id ||
    packageResult.format !== preview.plan.mapping.format ||
    packageResult.accountId !== preview.plan.mapping.accountId ||
    packageResult.legalEntityId !== preview.plan.mapping.legalEntityId ||
    packageResult.createdAt !== preview.createdAt
  ) {
    throw new ValidationError("Generated export package does not match its approved preview");
  }
  const actualFiles = packageResult.files.map(fileManifestEntry);
  if (JSON.stringify(actualFiles) !== JSON.stringify(preview.files)) {
    throw new ValidationError("Generated export bytes differ from the approved preview");
  }
  if (
    JSON.stringify(packageResult.duplicateReport) !== JSON.stringify(preview.duplicateReport.candidates) ||
    JSON.stringify(packageResult.warnings) !== JSON.stringify(preview.warnings)
  ) {
    throw new ValidationError("Generated export review metadata differs from the approved preview");
  }
}

function fileManifestEntry(file: ExportFile): ExportManifestFile {
  return {
    fileName: file.fileName,
    mediaType: file.mediaType,
    encoding: file.encoding,
    byteLength: file.bytes.byteLength,
    sha256: sha256Bytes(file.bytes),
  };
}

function validateDuplicateReport(value: unknown): asserts value is ExportDuplicateReport {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new ValidationError("Export manifest duplicate report is invalid");
  }
  for (const field of [
    "selectedTransactionCount",
    "eligibleTransactionCount",
    "excludedTransactionCount",
    "alreadyExportedCount",
    "duplicateInSelectionCount",
  ] as const) {
    if (!Number.isInteger(value[field]) || (value[field] as number) < 0) {
      throw new ValidationError("Export manifest duplicate totals are invalid");
    }
  }
  const selected = value.selectedTransactionCount as number;
  const eligible = value.eligibleTransactionCount as number;
  const excluded = value.excludedTransactionCount as number;
  const alreadyExported = value.alreadyExportedCount as number;
  const duplicateInSelection = value.duplicateInSelectionCount as number;
  let actualAlreadyExported = 0;
  let actualInSelection = 0;
  for (const candidate of value.candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.transactionId !== "string" ||
      candidate.transactionId.length === 0 ||
      typeof candidate.fingerprint !== "string" ||
      !isSha256(candidate.fingerprint) ||
      (candidate.reason !== "already_exported" && candidate.reason !== "duplicate_in_selection") ||
      (candidate.matchingTransactionId !== undefined && typeof candidate.matchingTransactionId !== "string")
    ) {
      throw new ValidationError("Export manifest duplicate candidate is invalid");
    }
    if (candidate.reason === "already_exported") actualAlreadyExported += 1;
    else actualInSelection += 1;
  }
  if (
    excluded !== value.candidates.length ||
    selected !== eligible + excluded ||
    excluded !== alreadyExported + duplicateInSelection ||
    alreadyExported !== actualAlreadyExported ||
    duplicateInSelection !== actualInSelection
  ) {
    throw new ValidationError("Export manifest duplicate totals do not reconcile");
  }
}

function isManifestFile(value: unknown): value is ExportManifestFile {
  return (
    isRecord(value) &&
    typeof value.fileName === "string" &&
    value.fileName.length > 0 &&
    typeof value.mediaType === "string" &&
    value.mediaType.length > 0 &&
    (value.encoding === "binary" || value.encoding === "utf8_bom" || value.encoding === "shift_jis") &&
    Number.isSafeInteger(value.byteLength) &&
    (value.byteLength as number) >= 0 &&
    typeof value.sha256 === "string" &&
    isSha256(value.sha256)
  );
}

function isHistoryRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    isExportFormat(value.format) &&
    typeof value.accountId === "string" &&
    value.accountId.length > 0 &&
    typeof value.transactionId === "string" &&
    value.transactionId.length > 0 &&
    typeof value.transactionFingerprint === "string" &&
    isSha256(value.transactionFingerprint) &&
    typeof value.exportedAt === "string"
  );
}

function isExportFormat(value: unknown): value is ExportManifest["format"] {
  return (
    value === "quickbooks_csv" ||
    value === "quickbooks_qbo" ||
    value === "quickbooks_qfx" ||
    value === "money_forward_statement_csv" ||
    value === "money_forward_journal_csv" ||
    value === "money_forward_ledger_csv"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
