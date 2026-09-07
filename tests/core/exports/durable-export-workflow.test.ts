import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DuplicateExportError,
  DurableExportWorkflow,
  EncryptedDirectoryExportJournal,
  ExportApprovalError,
  exportTransactionFingerprint,
  fingerprintExportApproval,
  HmacExportApprovalAuthority,
  HUMAN_EXPORT_CONFIRMATION_PHRASE,
  previewExport,
  verifyMaterializedExport,
  type ExportFormat,
  type ExportJournalClaim,
  type ExportJournalRecord,
  type ExportMapping,
  type ExportWorkflowJournal,
} from "../../../src/core";
import { makeAccount, makeTransaction, NOW } from "../fixtures";

const APPROVAL_KEY = Buffer.alloc(32, 0x51);
const JOURNAL_KEY = Buffer.alloc(32, 0x72);
const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true, maxRetries: 3 })));
});

describe("durable accounting export workflow", () => {
  it("creates a byte-bound preview with a reconciled duplicate report", () => {
    const account = makeAccount();
    const first = makeTransaction(account, { id: "selected" });
    const inSelectionDuplicate = makeTransaction(account, { id: "selected-copy" });
    const prior = makeTransaction(account, { id: "prior", postedAt: "2026-01-11" });
    const mapping = quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv");
    const preview = previewExport({
      mapping,
      transactions: [first, inSelectionDuplicate, prior],
      history: [
        {
          format: "quickbooks_qbo",
          accountId: account.id,
          transactionId: "prior-export",
          transactionFingerprint: exportTransactionFingerprint(prior),
          exportedAt: NOW,
        },
      ],
      createdAt: NOW,
    });

    expect(preview.previewFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.duplicateReport).toMatchObject({
      selectedTransactionCount: 3,
      eligibleTransactionCount: 1,
      excludedTransactionCount: 2,
      alreadyExportedCount: 1,
      duplicateInSelectionCount: 1,
    });
    expect(preview.files).toEqual([
      expect.objectContaining({ fileName: "Test_Card-quickbooks.csv", byteLength: expect.any(Number) }),
    ]);
    expect(preview.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.automaticPosting).toBe(false);
    expect("bytes" in preview.files[0]!).toBe(false);
  });

  it("rejects a changed preview checksum before issuing human approval", async () => {
    const root = await temporaryRoot();
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const changed = structuredClone(preview) as unknown as { files: Array<{ sha256: string }> };
    changed.files[0]!.sha256 = "0".repeat(64);

    expect(() =>
      workflow.approve({
        preview: changed as unknown as typeof preview,
        approvedBy: "owner",
        confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
      }),
    ).toThrow(ExportApprovalError);
    expect(await journal.listRecords()).toEqual([]);
    journal.close();
  });

  it("atomically publishes files and an auditable manifest, then reloads encrypted history", async () => {
    const root = await temporaryRoot();
    const journalDirectory = join(root, "private-journal");
    const destination = join(root, "approved-packages", "export-one");
    const journal = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const transaction = makeTransaction(account, { id: "durable-txn" });
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [transaction],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "local owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });

    const materialized = await workflow.materialize({ preview, approval, destinationDirectory: destination });
    const verified = await verifyMaterializedExport(destination);
    expect(materialized).toMatchObject({
      publicationStatus: "published",
      journalStatus: "completed",
      committedPaths: [
        join(destination, "Test_Card-quickbooks.csv"),
        join(destination, "export-manifest.json"),
      ],
    });
    expect(verified.manifestSha256).toBe(materialized.manifestSha256);
    expect(verified.manifest).toMatchObject({
      previewFingerprint: preview.previewFingerprint,
      approvedBy: "local owner",
      format: "quickbooks_csv",
      automaticPosting: false,
    });
    expect(verified.manifest.files[0]?.sha256).toBe(preview.files[0]?.sha256);
    expect(await readFile(materialized.manifestPath, "utf8")).not.toContain(approval.token);

    const encryptedJournal = await readFile(join(journalDirectory, `${fingerprintExportApproval(approval.token)}.aexj`));
    expect(encryptedJournal.toString("utf8")).not.toContain(transaction.id);
    expect(encryptedJournal.toString("utf8")).not.toContain(account.id);
    journal.close();

    const reopened = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    const restartedWorkflow = createWorkflow(reopened);
    expect(await restartedWorkflow.listHistory({ accountId: account.id })).toEqual([
      expect.objectContaining({ transactionId: transaction.id, format: "quickbooks_csv" }),
    ]);
    await expect(
      restartedWorkflow.materialize({
        preview,
        approval,
        destinationDirectory: join(root, "approved-packages", "replay"),
      }),
    ).rejects.toThrow(ExportApprovalError);
    await expect(
      restartedWorkflow.preview({
        mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_qfx"),
        transactions: [transaction],
        createdAt: NOW,
      }),
    ).rejects.toThrow(DuplicateExportError);
    reopened.close();
  });

  it("atomically prevents two different approvals from publishing the same transaction family", async () => {
    const root = await temporaryRoot();
    const journalDirectory = join(root, "shared-journal");
    const firstJournal = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    const secondJournal = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    const firstWorkflow = createWorkflow(firstJournal);
    const secondWorkflow = createWorkflow(secondJournal);
    const account = makeAccount();
    const transaction = makeTransaction(account, { id: "concurrent-transaction" });

    // Both reviews deliberately happen before either materialization. They use
    // different QuickBooks formats and different approval tokens, but belong to
    // the same duplicate-detection destination family.
    const [firstPreview, secondPreview] = await Promise.all([
      firstWorkflow.preview({
        mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
        transactions: [transaction],
        createdAt: NOW,
      }),
      secondWorkflow.preview({
        mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_qfx"),
        transactions: [transaction],
        createdAt: NOW,
      }),
    ]);
    const firstApproval = firstWorkflow.approve({
      preview: firstPreview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const secondApproval = secondWorkflow.approve({
      preview: secondPreview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });

    const destinations = [join(root, "first-package"), join(root, "second-package")] as const;
    const outcomes = await Promise.allSettled([
      firstWorkflow.materialize({
        preview: firstPreview,
        approval: firstApproval,
        destinationDirectory: destinations[0],
      }),
      secondWorkflow.materialize({
        preview: secondPreview,
        approval: secondApproval,
        destinationDirectory: destinations[1],
      }),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof firstWorkflow.materialize>>> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value).toMatchObject({ publicationStatus: "published", journalStatus: "completed" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(DuplicateExportError);
    expect(await Promise.all(destinations.map((destination) => pathExists(destination)))).toEqual(
      fulfilled[0]!.value.destinationDirectory === destinations[0] ? [true, false] : [false, true],
    );
    expect(await firstJournal.listRecords()).toEqual([expect.objectContaining({ status: "completed" })]);

    firstJournal.close();
    secondJournal.close();
  });

  it("rejects approval when current account-backed transaction data changed after preview", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "must-not-publish");
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const mapping = quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv");
    const reviewedTransaction = makeTransaction(account, { id: "changed-after-review" });
    const preview = await workflow.preview({ mapping, transactions: [reviewedTransaction], createdAt: NOW });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });

    await expect(
      workflow.materialize({
        preview,
        approval,
        destinationDirectory: destination,
        currentState: {
          mapping,
          transactions: [{ ...reviewedTransaction, description: "Description changed after approval" }],
        },
      }),
    ).rejects.toThrow(/changed after preview/iu);
    expect(await pathExists(destination)).toBe(false);
    expect(await journal.listRecords()).toEqual([]);
    journal.close();
  });

  it("reports committed file paths when journal completion fails after publication", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "published-with-pending-journal");
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const failingJournal = completionFailingJournal(journal);
    const workflow = createWorkflow(failingJournal);
    const account = makeAccount();
    const transaction = makeTransaction(account, { id: "post-publication-journal-failure" });
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [transaction],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });

    const result = await workflow.materialize({ preview, approval, destinationDirectory: destination });

    expect(result).toMatchObject({
      publicationStatus: "published",
      journalStatus: "completion_unconfirmed",
      journalFailureCode: "SIMULATED_JOURNAL_FAILURE",
      destinationDirectory: destination,
      committedPaths: [
        join(destination, "Test_Card-quickbooks.csv"),
        join(destination, "export-manifest.json"),
      ],
    });
    await expect(Promise.all(result.committedPaths.map((path) => readFile(path)))).resolves.toHaveLength(2);
    expect(await journal.listRecords()).toEqual([expect.objectContaining({ status: "pending" })]);
    await expect(
      workflow.preview({
        mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_qfx"),
        transactions: [transaction],
        createdAt: NOW,
      }),
    ).rejects.toThrow(DuplicateExportError);
    journal.close();
  });

  it("never overwrites an existing destination and permanently consumes the failed approval", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "existing-package");
    await mkdir(destination);
    const sentinel = join(destination, "keep.txt");
    await writeFile(sentinel, "owner data", "utf8");
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });

    await expect(workflow.materialize({ preview, approval, destinationDirectory: destination })).rejects.toThrow(
      /already exists/iu,
    );
    expect(await readFile(sentinel, "utf8")).toBe("owner data");
    expect(await journal.listRecords()).toEqual([expect.objectContaining({ status: "failed" })]);
    await expect(
      workflow.materialize({ preview, approval, destinationDirectory: join(root, "retry") }),
    ).rejects.toThrow(/already been claimed/iu);

    const replacementApproval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    await expect(
      workflow.materialize({
        preview,
        approval: replacementApproval,
        destinationDirectory: join(root, "approved-retry"),
      }),
    ).resolves.toMatchObject({ manifest: { automaticPosting: false } });
    journal.close();
  });

  it("detects a materialized file changed after publication", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "tamper-test");
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const result = await workflow.materialize({ preview, approval, destinationDirectory: destination });
    await writeFile(join(destination, result.manifest.files[0]!.fileName), "changed", "utf8");
    await expect(verifyMaterializedExport(destination)).rejects.toThrow(/size|checksum/iu);
    journal.close();
  });

  it("rejects unexpected files added to a materialized package", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "extra-file-test");
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    await workflow.materialize({ preview, approval, destinationDirectory: destination });
    await writeFile(join(destination, "unlisted.csv"), "untrusted", "utf8");

    await expect(verifyMaterializedExport(destination)).rejects.toThrow(/unexpected file/iu);
    journal.close();
  });

  it("keeps an interrupted pending claim in duplicate history and authenticates it after restart", async () => {
    const root = await temporaryRoot();
    const journalDirectory = join(root, "journal");
    const journal = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    const account = makeAccount();
    const transaction = makeTransaction(account, { id: "pending-txn" });
    const tokenFingerprint = "a".repeat(64);
    await journal.claim({
      approvalFingerprint: tokenFingerprint,
      planId: "pending-plan",
      previewFingerprint: "b".repeat(64),
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      format: "quickbooks_csv",
      destinationDirectory: join(root, "pending-destination"),
      initiatedAt: NOW,
      historyRecords: [
        {
          format: "quickbooks_csv",
          accountId: account.id,
          transactionId: transaction.id,
          transactionFingerprint: exportTransactionFingerprint(transaction),
          exportedAt: NOW,
        },
      ],
    });
    journal.close();

    const reopened = new EncryptedDirectoryExportJournal(journalDirectory, JOURNAL_KEY);
    expect(await reopened.listHistory({ accountId: account.id })).toEqual([
      expect.objectContaining({ transactionId: transaction.id }),
    ]);
    await expect(
      reopened.claim({
        approvalFingerprint: tokenFingerprint,
        planId: "different-plan",
        previewFingerprint: "c".repeat(64),
        accountId: account.id,
        legalEntityId: account.legalEntityId,
        format: "quickbooks_csv",
        destinationDirectory: join(root, "another-destination"),
        initiatedAt: NOW,
        historyRecords: [
          {
            format: "quickbooks_csv",
            accountId: account.id,
            transactionId: transaction.id,
            transactionFingerprint: exportTransactionFingerprint(transaction),
            exportedAt: NOW,
          },
        ],
      }),
    ).rejects.toThrow(ExportApprovalError);
    reopened.close();

    const wrongKey = new EncryptedDirectoryExportJournal(journalDirectory, Buffer.alloc(32, 0x33));
    await expect(wrongKey.listRecords()).rejects.toThrow(/authentication failed/iu);
    wrongKey.close();
  });

  it("rejects a relative destination before claiming the approval", async () => {
    const root = await temporaryRoot();
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const account = makeAccount();
    const preview = await workflow.preview({
      mapping: quickBooksMapping(account.id, account.legalEntityId, "quickbooks_csv"),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    await expect(
      workflow.materialize({ preview, approval, destinationDirectory: "relative-export" }),
    ).rejects.toThrow(/absolute directory path/iu);
    expect(await journal.listRecords()).toEqual([]);
    journal.close();
  });

  it.each([
    "quickbooks_csv",
    "quickbooks_qbo",
    "quickbooks_qfx",
    "money_forward_statement_csv",
    "money_forward_journal_csv",
    "money_forward_ledger_csv",
  ] as const)("durably materializes %s without any posting capability", async (format) => {
    const root = await temporaryRoot();
    const journal = new EncryptedDirectoryExportJournal(join(root, "journal"), JOURNAL_KEY);
    const workflow = createWorkflow(journal);
    const isJapan = format.startsWith("money_forward_");
    const account = isJapan
      ? makeAccount({
          id: `jp-${format}`,
          legalEntityId: "jp-entity",
          legalEntityName: "テスト株式会社",
          country: "JP",
          currency: "JPY",
          accountClass: "company",
          businessPurpose: "出張費",
          collectionMethod: "statement_import",
          authorization: { state: "import_only", checkedAt: NOW },
        })
      : makeAccount({ id: `us-${format}` });
    const mapping = isJapan
      ? moneyForwardMapping(account.id, account.legalEntityId, format)
      : quickBooksMapping(account.id, account.legalEntityId, format);
    const preview = await workflow.preview({
      mapping,
      transactions: [
        makeTransaction(account, {
          id: `txn-${format}`,
          amount: isJapan ? "-1500" : "-12.34",
          description: isJapan ? "出張" : "Business trip",
        }),
      ],
      createdAt: NOW,
    });
    const approval = workflow.approve({
      preview,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const result = await workflow.materialize({
      preview,
      approval,
      destinationDirectory: join(root, `package-${format}`),
    });

    expect(result.manifest.format).toBe(format);
    expect(result.manifest.files).toHaveLength(1);
    expect(result.manifest.automaticPosting).toBe(false);
    expect(await journal.listRecords()).toEqual([expect.objectContaining({ status: "completed" })]);
    journal.close();
  });
});

function createWorkflow(journal: ExportWorkflowJournal): DurableExportWorkflow {
  return new DurableExportWorkflow({
    approvalAuthority: new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) }),
    journal,
    now: () => new Date(NOW),
  });
}

function completionFailingJournal(delegate: EncryptedDirectoryExportJournal): ExportWorkflowJournal {
  return {
    claim: (input: ExportJournalClaim): Promise<ExportJournalRecord> => delegate.claim(input),
    markCompleted: async (): Promise<ExportJournalRecord> => {
      throw Object.assign(new Error("simulated journal completion failure"), {
        code: "SIMULATED_JOURNAL_FAILURE",
      });
    },
    markFailed: (approvalFingerprint, failedAt, failureCode): Promise<ExportJournalRecord> =>
      delegate.markFailed(approvalFingerprint, failedAt, failureCode),
    listRecords: (): Promise<readonly ExportJournalRecord[]> => delegate.listRecords(),
    listHistory: (query) => delegate.listHistory(query),
  };
}

function quickBooksMapping(accountId: string, legalEntityId: string, format: ExportFormat): ExportMapping {
  return {
    accountId,
    legalEntityId,
    format,
    currency: "USD",
    quickBooks: { accountReference: "LOCAL-ACCOUNT-REF", accountName: "Test Card", bankId: "3000" },
  };
}

function moneyForwardMapping(accountId: string, legalEntityId: string, format: ExportFormat): ExportMapping {
  return {
    accountId,
    legalEntityId,
    format,
    currency: "JPY",
    moneyForward: {
      liabilityAccount: "未払金",
      expenseAccount: "旅費交通費",
      department: "営業部",
      encoding: format === "money_forward_statement_csv" ? "utf8_bom" : "shift_jis",
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "amex-durable-export-"));
  temporaryRoots.push(root);
  return root;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(join(path, "export-manifest.json"));
    return true;
  } catch (caught) {
    return !(caught !== null && typeof caught === "object" && "code" in caught && caught.code === "ENOENT");
  }
}
