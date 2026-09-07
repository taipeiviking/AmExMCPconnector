import { join } from "node:path";

import type { FinancialTransaction } from "../domain";
import { ExportApprovalError, ValidationError } from "../errors";
import type { HmacExportApprovalAuthority } from "./approval";
import { exportTransactionFingerprint } from "./duplicates";
import { generateExportPackage } from "./generate";
import {
  fingerprintExportApproval,
  type ExportHistoryQuery,
  type ExportWorkflowJournal,
} from "./journal";
import {
  AtomicDirectoryExportMaterializer,
  resolveExportDestination,
  type ExportPackageMaterializer,
} from "./materialize";
import { assertExportPreviewIntegrity, previewExport } from "./preview";
import type {
  ApprovedExportPreview,
  CurrentExportState,
  DurableExportMaterializationResult,
  ExportHistoryRecord,
  ExportMapping,
  ExportPreview,
  MaterializedExportPackage,
} from "./types";

export interface DurableExportWorkflowOptions {
  readonly approvalAuthority: HmacExportApprovalAuthority;
  readonly journal: ExportWorkflowJournal;
  readonly materializer?: ExportPackageMaterializer;
  readonly now?: () => Date;
}

/**
 * End-to-end local export flow. It has no accounting-network client and can
 * only create a user-approved import package at an explicit local destination.
 */
export class DurableExportWorkflow {
  readonly #approvalAuthority: HmacExportApprovalAuthority;
  readonly #journal: ExportWorkflowJournal;
  readonly #materializer: ExportPackageMaterializer;
  readonly #now: () => Date;

  public constructor(options: DurableExportWorkflowOptions) {
    this.#approvalAuthority = options.approvalAuthority;
    this.#journal = options.journal;
    this.#materializer = options.materializer ?? new AtomicDirectoryExportMaterializer();
    this.#now = options.now ?? (() => new Date());
  }

  public async preview(input: {
    readonly mapping: ExportMapping;
    readonly transactions: readonly FinancialTransaction[];
    readonly createdAt?: string;
  }): Promise<ExportPreview> {
    const history = await this.#journal.listHistory({ accountId: input.mapping.accountId });
    return previewExport({
      mapping: input.mapping,
      transactions: input.transactions,
      history,
      createdAt: input.createdAt ?? this.#now().toISOString(),
    });
  }

  public approve(input: {
    readonly preview: ExportPreview;
    readonly approvedBy: string;
    readonly confirmation: string;
  }): ApprovedExportPreview {
    assertExportPreviewIntegrity(input.preview);
    const approval = this.#approvalAuthority.approve({
      plan: input.preview.plan,
      approvedBy: input.approvedBy,
      confirmation: input.confirmation,
    });
    return {
      ...approval,
      previewFingerprint: input.preview.previewFingerprint,
      singleUse: true,
    };
  }

  public async materialize(input: {
    readonly preview: ExportPreview;
    readonly approval: ApprovedExportPreview;
    readonly destinationDirectory: string;
    /** Required for callers whose account or transaction store can change after preview. */
    readonly currentState?: CurrentExportState;
  }): Promise<DurableExportMaterializationResult> {
    assertExportPreviewIntegrity(input.preview);
    if (
      input.approval.singleUse !== true ||
      input.approval.previewFingerprint !== input.preview.previewFingerprint
    ) {
      throw new ValidationError("Human approval is not bound to this exact export preview");
    }
    this.#approvalAuthority.assertApproved(input.preview.plan, input.approval);
    if (input.currentState !== undefined) {
      await this.assertCurrentPreview({ preview: input.preview, currentState: input.currentState });
    }
    const destinationDirectory = resolveExportDestination(input.destinationDirectory);
    const approvalFingerprint = fingerprintExportApproval(input.approval.token);
    const exportedAt = input.preview.createdAt;
    const historyRecords: readonly ExportHistoryRecord[] = input.preview.plan.eligibleTransactions.map(
      (transaction) => ({
        format: input.preview.plan.mapping.format,
        accountId: input.preview.plan.mapping.accountId,
        transactionId: transaction.id,
        transactionFingerprint: exportTransactionFingerprint(transaction),
        exportedAt,
      }),
    );
    const initiatedAt = this.#now().toISOString();
    await this.#journal.claim({
      approvalFingerprint,
      planId: input.preview.plan.id,
      previewFingerprint: input.preview.previewFingerprint,
      accountId: input.preview.plan.mapping.accountId,
      legalEntityId: input.preview.plan.mapping.legalEntityId,
      format: input.preview.plan.mapping.format,
      destinationDirectory,
      initiatedAt,
      historyRecords,
    });

    let packageResult: ReturnType<typeof generateExportPackage> | undefined;
    let materialized: MaterializedExportPackage;
    try {
      packageResult = generateExportPackage({
        plan: input.preview.plan,
        approval: input.approval,
        approvalAuthority: this.#approvalAuthority,
        generatedAt: input.preview.createdAt,
      });
      materialized = await this.#materializer.materialize({
        destinationDirectory,
        preview: input.preview,
        approval: input.approval,
        package: packageResult,
      });
    } catch (caught) {
      try {
        await this.#journal.markFailed(
          approvalFingerprint,
          this.#now().toISOString(),
          failureCode(caught, "EXPORT_MATERIALIZATION_FAILED"),
        );
      } catch (journalFailure) {
        throw new AggregateError([caught, journalFailure], "Export failed and its durable journal could not be finalized");
      }
      throw caught;
    } finally {
      if (packageResult !== undefined) {
        for (const file of packageResult.files) file.bytes.fill(0);
      }
    }

    const committedPaths = [
      ...materialized.manifest.files.map((file) => join(materialized.destinationDirectory, file.fileName)),
      materialized.manifestPath,
    ];
    try {
      await this.#journal.markCompleted(approvalFingerprint, {
        completedAt: this.#now().toISOString(),
        manifestSha256: materialized.manifestSha256,
        packageSha256: materialized.manifest.packageSha256,
      });
      return {
        ...materialized,
        publicationStatus: "published",
        journalStatus: "completed",
        committedPaths,
      };
    } catch (journalFailure) {
      // Publication is irreversible at this point. Keep the pending transaction
      // claims (which conservatively prevent a duplicate) and report exact
      // committed paths plus the recovery state instead of throwing a generic
      // error that could be mistaken for "no files were created".
      return {
        ...materialized,
        publicationStatus: "published",
        journalStatus: "completion_unconfirmed",
        committedPaths,
        journalFailureCode: failureCode(journalFailure, "EXPORT_JOURNAL_COMPLETION_FAILED"),
      };
    }
  }

  public listHistory(query: ExportHistoryQuery): Promise<readonly ExportHistoryRecord[]> {
    return this.#journal.listHistory(query);
  }

  /**
   * Rebuilds the exact reviewed preview against current account/transaction
   * state and current durable history. Controllers should invoke this through
   * materialize.currentState while holding their local store write queue.
   */
  public async assertCurrentPreview(input: {
    readonly preview: ExportPreview;
    readonly currentState: CurrentExportState;
  }): Promise<void> {
    assertExportPreviewIntegrity(input.preview);
    const history = await this.#journal.listHistory({ accountId: input.currentState.mapping.accountId });
    const currentPreview = previewExport({
      mapping: input.currentState.mapping,
      transactions: input.currentState.transactions,
      history,
      createdAt: input.preview.createdAt,
    });
    if (currentPreview.previewFingerprint !== input.preview.previewFingerprint) {
      throw new ExportApprovalError("Account or transaction data changed after preview and requires fresh review", {
        planId: input.preview.plan.id,
      });
    }
  }
}

function failureCode(caught: unknown, fallback: string): string {
  if (
    caught !== null &&
    typeof caught === "object" &&
    "code" in caught &&
    typeof caught.code === "string" &&
    /^[A-Z0-9_]{1,80}$/u.test(caught.code)
  ) {
    return caught.code;
  }
  if (caught instanceof ValidationError) return "VALIDATION_ERROR";
  return fallback;
}
