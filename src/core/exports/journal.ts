import { constants as fsConstants } from "node:fs";
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { DuplicateExportError, ExportApprovalError, ValidationError } from "../errors";
import { assertIsoInstant } from "../validation";
import { validateExportManifest } from "./manifest";
import type { ExportFormat, ExportHistoryRecord, ExportManifest } from "./types";

const JOURNAL_MAGIC = Buffer.from("AMEX-EXPORT-JOURNAL\u0001", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const RECORD_EXTENSION = ".aexj";
const TRANSACTION_CLAIM_EXTENSION = ".aexc";

export interface ExportHistoryQuery {
  readonly accountId: string;
}

/** Read side can be implemented by the app's encrypted database instead. */
export interface ExportHistorySource {
  listHistory(query: ExportHistoryQuery): Promise<readonly ExportHistoryRecord[]>;
}

export interface ExportJournalClaim {
  readonly approvalFingerprint: string;
  readonly planId: string;
  readonly previewFingerprint: string;
  readonly accountId: string;
  readonly legalEntityId: string;
  readonly format: ExportFormat;
  readonly destinationDirectory: string;
  readonly initiatedAt: string;
  readonly historyRecords: readonly ExportHistoryRecord[];
}

export type ExportJournalRecord = ExportJournalClaim & {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: "pending" | "completed" | "failed";
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly failureCode?: string;
  readonly manifestSha256?: string;
  readonly packageSha256?: string;
};

/**
 * Durable claim is the cross-restart publication boundary. Implementations
 * must atomically reject both a repeated approvalFingerprint and transactions
 * already claimed for the same accounting destination family.
 */
export interface ExportWorkflowJournal extends ExportHistorySource {
  claim(input: ExportJournalClaim): Promise<ExportJournalRecord>;
  markCompleted(
    approvalFingerprint: string,
    completion: {
      readonly completedAt: string;
      readonly manifestSha256: string;
      readonly packageSha256: string;
    },
  ): Promise<ExportJournalRecord>;
  markFailed(approvalFingerprint: string, failedAt: string, failureCode: string): Promise<ExportJournalRecord>;
  listRecords(): Promise<readonly ExportJournalRecord[]>;
}

export function fingerprintExportApproval(token: string): string {
  return createHash("sha256").update("amex-export-approval\u0000v1\u0000", "utf8").update(token, "utf8").digest("hex");
}

/**
 * Encrypted, append-by-claim filesystem journal. The 32-byte key should be
 * loaded from the OS-protected local secret store and is never written here.
 */
export class EncryptedDirectoryExportJournal implements ExportWorkflowJournal {
  readonly #directory: string;
  readonly #key: Buffer;
  #closed = false;

  public constructor(directory: string, key: Uint8Array) {
    if (directory.trim().length === 0) throw new ValidationError("Export journal directory is required");
    if (key.byteLength !== 32) throw new ValidationError("Export journal encryption key must contain exactly 32 bytes");
    this.#directory = directory;
    this.#key = Buffer.from(key);
  }

  public async claim(input: ExportJournalClaim): Promise<ExportJournalRecord> {
    this.#assertOpen();
    validateClaim(input);
    const record: ExportJournalRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      status: "pending",
      ...structuredClone(input),
    };
    await mkdir(this.#directory, { mode: 0o700, recursive: true });

    // Revalidate against durable history at the last possible point. This
    // catches previews created before another export completed, including
    // legacy records written before transaction sentinels existed.
    const currentRecords = await this.listRecords();
    if (currentRecords.some((item) => item.approvalFingerprint === input.approvalFingerprint)) {
      throw new ExportApprovalError("Export approval has already been claimed", { planId: input.planId });
    }
    const currentHistory = currentRecords
      .filter((item) => item.accountId === input.accountId && item.status !== "failed")
      .flatMap((item) => item.historyRecords);
    const currentFingerprints = new Set(
      currentHistory
        .filter((item) => destinationFamily(item.format) === destinationFamily(input.format))
        .map((item) => item.transactionFingerprint),
    );
    const alreadyClaimed = input.historyRecords.filter((item) =>
      currentFingerprints.has(item.transactionFingerprint),
    );
    if (alreadyClaimed.length > 0) {
      throw new DuplicateExportError("One or more transactions were claimed after this export was previewed", {
        duplicateCount: alreadyClaimed.length,
        transactionIds: alreadyClaimed.map((item) => item.transactionId),
      });
    }

    // Per-transaction encrypted sentinels prevent two different approvals from
    // publishing an overlapping transaction set. Sort paths so multi-record
    // claims never acquire common locks in opposite orders.
    const transactionClaims = input.historyRecords
      .map((history) => ({ history, path: this.#transactionClaimPath(history) }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const acquiredPaths: string[] = [];
    try {
      for (const transactionClaim of transactionClaims) {
        try {
          await this.#writeRecord(transactionClaim.path, record, "create");
          acquiredPaths.push(transactionClaim.path);
        } catch (caught) {
          if (hasErrorCode(caught, "EEXIST")) {
            throw new DuplicateExportError("A transaction is already claimed by another export", {
              transactionId: transactionClaim.history.transactionId,
            });
          }
          throw caught;
        }
      }

      try {
        await this.#writeRecord(this.#pathFor(input.approvalFingerprint), record, "create");
      } catch (caught) {
        if (hasErrorCode(caught, "EEXIST")) {
          throw new ExportApprovalError("Export approval has already been claimed", {
            planId: input.planId,
          });
        }
        throw caught;
      }
    } catch (caught) {
      const cleanupFailures: unknown[] = [];
      for (const path of acquiredPaths.reverse()) {
        try {
          await unlink(path);
        } catch (cleanupFailure) {
          if (!hasErrorCode(cleanupFailure, "ENOENT")) cleanupFailures.push(cleanupFailure);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [caught, ...cleanupFailures],
          "Export claim failed and partial transaction claims could not be released",
        );
      }
      throw caught;
    }
    return structuredClone(record);
  }

  public async markCompleted(
    approvalFingerprint: string,
    completion: {
      readonly completedAt: string;
      readonly manifestSha256: string;
      readonly packageSha256: string;
    },
  ): Promise<ExportJournalRecord> {
    this.#assertOpen();
    assertIsoInstant(completion.completedAt, "completedAt");
    assertSha256(completion.manifestSha256, "manifestSha256");
    assertSha256(completion.packageSha256, "packageSha256");
    const record = await this.#readRecord(this.#pathFor(approvalFingerprint));
    if (record.status !== "pending") {
      throw new ValidationError("Only a pending export journal claim can be completed", { status: record.status });
    }
    const completed: ExportJournalRecord = {
      ...record,
      status: "completed",
      completedAt: completion.completedAt,
      manifestSha256: completion.manifestSha256,
      packageSha256: completion.packageSha256,
    };
    await this.#writeRecord(this.#pathFor(approvalFingerprint), completed, "replace");
    return structuredClone(completed);
  }

  public async markFailed(
    approvalFingerprint: string,
    failedAt: string,
    failureCode: string,
  ): Promise<ExportJournalRecord> {
    this.#assertOpen();
    assertIsoInstant(failedAt, "failedAt");
    if (!/^[A-Z0-9_]{1,80}$/u.test(failureCode)) {
      throw new ValidationError("Export journal failure code is invalid");
    }
    const record = await this.#readRecord(this.#pathFor(approvalFingerprint));
    if (record.status !== "pending") {
      throw new ValidationError("Only a pending export journal claim can be failed", { status: record.status });
    }
    const failed: ExportJournalRecord = { ...record, status: "failed", failedAt, failureCode };
    await this.#writeRecord(this.#pathFor(approvalFingerprint), failed, "replace");
    await this.#releaseTransactionClaims(failed);
    return structuredClone(failed);
  }

  public async listRecords(): Promise<readonly ExportJournalRecord[]> {
    this.#assertOpen();
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (caught) {
      if (hasErrorCode(caught, "ENOENT")) return [];
      throw caught;
    }
    const records: ExportJournalRecord[] = [];
    for (const name of names.filter((item) => item.endsWith(RECORD_EXTENSION)).sort()) {
      records.push(await this.#readRecord(join(this.#directory, name)));
    }
    return records.sort((left, right) => left.initiatedAt.localeCompare(right.initiatedAt) || left.id.localeCompare(right.id));
  }

  public async listHistory(query: ExportHistoryQuery): Promise<readonly ExportHistoryRecord[]> {
    if (query.accountId.trim().length === 0) throw new ValidationError("Export history account id is required");
    const records = await this.listRecords();
    return records
      .filter((record) => record.accountId === query.accountId && record.status !== "failed")
      .flatMap((record) => structuredClone(record.historyRecords));
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#key.fill(0);
  }

  async #readRecord(path: string): Promise<ExportJournalRecord> {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_RECORD_BYTES) {
      throw new ValidationError("Export journal record must be a bounded regular file");
    }
    const encrypted = await readFile(path);
    const plaintext = this.#decrypt(encrypted);
    try {
      const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
      validateRecord(parsed);
      return parsed;
    } catch (caught) {
      if (caught instanceof ValidationError) throw caught;
      throw new ValidationError("Export journal record is invalid");
    } finally {
      plaintext.fill(0);
    }
  }

  async #writeRecord(path: string, record: ExportJournalRecord, mode: "create" | "replace"): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(record), "utf8");
    try {
      const encrypted = this.#encrypt(plaintext);
      try {
        await writeFileAtomically(path, encrypted, mode);
      } finally {
        encrypted.fill(0);
      }
    } finally {
      plaintext.fill(0);
    }
  }

  #encrypt(plaintext: Uint8Array): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(JOURNAL_MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([JOURNAL_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
  }

  #decrypt(envelope: Uint8Array): Buffer {
    const minimum = JOURNAL_MAGIC.length + NONCE_BYTES + TAG_BYTES;
    const bytes = Buffer.from(envelope);
    if (bytes.length < minimum || !bytes.subarray(0, JOURNAL_MAGIC.length).equals(JOURNAL_MAGIC)) {
      throw new ValidationError("Export journal record has an invalid encrypted envelope");
    }
    const nonceStart = JOURNAL_MAGIC.length;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(nonceStart, tagStart));
      decipher.setAAD(JOURNAL_MAGIC);
      decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
      return Buffer.concat([decipher.update(bytes.subarray(ciphertextStart)), decipher.final()]);
    } catch {
      throw new ValidationError("Export journal authentication failed");
    } finally {
      bytes.fill(0);
    }
  }

  #pathFor(approvalFingerprint: string): string {
    assertSha256(approvalFingerprint, "approvalFingerprint");
    return join(this.#directory, `${approvalFingerprint}${RECORD_EXTENSION}`);
  }

  #transactionClaimPath(history: ExportHistoryRecord): string {
    const digest = createHmac("sha256", this.#key)
      .update("amex-export-transaction-claim\u0000v1\u0000", "utf8")
      .update(history.accountId, "utf8")
      .update("\u0000", "utf8")
      .update(destinationFamily(history.format), "utf8")
      .update("\u0000", "utf8")
      .update(history.transactionFingerprint, "ascii")
      .digest("hex");
    return join(this.#directory, `${digest}${TRANSACTION_CLAIM_EXTENSION}`);
  }

  async #releaseTransactionClaims(record: ExportJournalRecord): Promise<void> {
    const failures: unknown[] = [];
    for (const history of record.historyRecords) {
      const path = this.#transactionClaimPath(history);
      try {
        const owner = await this.#readRecord(path);
        if (owner.approvalFingerprint !== record.approvalFingerprint) {
          throw new ValidationError("Transaction claim is owned by a different export approval");
        }
        await unlink(path);
      } catch (caught) {
        // Journal records created before transaction sentinels are valid and
        // have nothing to release.
        if (!hasErrorCode(caught, "ENOENT")) failures.push(caught);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed export transaction claims could not be released");
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new ValidationError("Export journal is closed");
  }
}

/** Converts immutable manifests into the history input used by duplicate detection. */
export function historyFromExportManifests(manifests: readonly ExportManifest[]): readonly ExportHistoryRecord[] {
  return manifests.flatMap((manifest) => {
    validateExportManifest(manifest);
    return structuredClone(manifest.historyRecords);
  });
}

async function writeFileAtomically(path: string, bytes: Uint8Array, mode: "create" | "replace"): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let handle: FileHandle | undefined;
  try {
    await mkdir(parent, { mode: 0o700, recursive: true });
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (mode === "create") {
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
    await chmod(path, 0o600).catch((caught: unknown) => {
      if (process.platform !== "win32") throw caught;
    });
    await syncDirectoryBestEffort(parent);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (caught) {
    if (
      !hasErrorCode(caught, "EACCES") &&
      !hasErrorCode(caught, "EBADF") &&
      !hasErrorCode(caught, "EINVAL") &&
      !hasErrorCode(caught, "EISDIR") &&
      !hasErrorCode(caught, "ENOTSUP") &&
      !hasErrorCode(caught, "EPERM")
    ) {
      throw caught;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateClaim(value: ExportJournalClaim): void {
  assertSha256(value.approvalFingerprint, "approvalFingerprint");
  assertSha256(value.previewFingerprint, "previewFingerprint");
  assertIsoInstant(value.initiatedAt, "initiatedAt");
  for (const field of [value.planId, value.accountId, value.legalEntityId, value.destinationDirectory]) {
    if (field.trim().length === 0) throw new ValidationError("Export journal claim has an empty required field");
  }
  if (!isExportFormat(value.format)) throw new ValidationError("Export journal claim format is invalid");
  if (!Array.isArray(value.historyRecords) || value.historyRecords.length === 0) {
    throw new ValidationError("Export journal claim requires transaction history records");
  }
  const uniqueClaims = new Set<string>();
  for (const history of value.historyRecords) {
    if (
      !isRecord(history) ||
      history.accountId !== value.accountId ||
      history.format !== value.format ||
      typeof history.transactionId !== "string" ||
      history.transactionId.length === 0 ||
      typeof history.transactionFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(history.transactionFingerprint) ||
      typeof history.exportedAt !== "string"
    ) {
      throw new ValidationError("Export journal transaction history is invalid");
    }
    assertIsoInstant(history.exportedAt, "history.exportedAt");
    const claimKey = `${destinationFamily(value.format)}\u0000${history.transactionFingerprint}`;
    if (uniqueClaims.has(claimKey)) {
      throw new ValidationError("Export journal claim repeats a transaction fingerprint");
    }
    uniqueClaims.add(claimKey);
  }
}

function validateRecord(value: unknown): asserts value is ExportJournalRecord {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== "string" || value.id.length === 0) {
    throw new ValidationError("Export journal record schema is unsupported");
  }
  if (value.status !== "pending" && value.status !== "completed" && value.status !== "failed") {
    throw new ValidationError("Export journal record status is invalid");
  }
  validateClaim(value as unknown as ExportJournalClaim);
  if (value.status === "completed") {
    if (
      typeof value.completedAt !== "string" ||
      typeof value.manifestSha256 !== "string" ||
      typeof value.packageSha256 !== "string"
    ) {
      throw new ValidationError("Completed export journal record is incomplete");
    }
    assertIsoInstant(value.completedAt, "completedAt");
    assertSha256(value.manifestSha256, "manifestSha256");
    assertSha256(value.packageSha256, "packageSha256");
  }
  if (value.status === "failed") {
    if (
      typeof value.failedAt !== "string" ||
      typeof value.failureCode !== "string" ||
      !/^[A-Z0-9_]{1,80}$/u.test(value.failureCode)
    ) {
      throw new ValidationError("Failed export journal record is incomplete");
    }
    assertIsoInstant(value.failedAt, "failedAt");
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new ValidationError(`${field} must be a SHA-256 digest`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExportFormat(value: unknown): value is ExportFormat {
  return (
    value === "quickbooks_csv" ||
    value === "quickbooks_qbo" ||
    value === "quickbooks_qfx" ||
    value === "money_forward_statement_csv" ||
    value === "money_forward_journal_csv" ||
    value === "money_forward_ledger_csv"
  );
}

function destinationFamily(format: ExportFormat): "quickbooks" | "money_forward" {
  return format.startsWith("quickbooks_") ? "quickbooks" : "money_forward";
}

function hasErrorCode(caught: unknown, code: string): boolean {
  return caught !== null && typeof caught === "object" && "code" in caught && caught.code === code;
}
