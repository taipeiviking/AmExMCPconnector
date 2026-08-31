import iconv from "iconv-lite";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import {
  DuplicateExportError,
  exportTransactionFingerprint,
  ExportApprovalError,
  generateExportPackage,
  HmacExportApprovalAuthority,
  HUMAN_EXPORT_CONFIRMATION_PHRASE,
  planExport,
  ValidationError,
  type ExportMapping,
} from "../../src/core";
import { makeAccount, makeTransaction, NOW } from "./fixtures";

const APPROVAL_KEY = Buffer.alloc(32, 0x5a);

describe("human-approved export packages", () => {
  it("detects prior and in-selection duplicates before approval", () => {
    const account = makeAccount();
    const first = makeTransaction(account, { id: "first" });
    const selectedDuplicate = makeTransaction(account, { id: "selected-duplicate" });
    const alreadyExported = makeTransaction(account, { id: "past", postedAt: "2026-01-11" });
    const mapping = quickBooksMapping(account.id, account.legalEntityId);
    const firstPlan = planExport({
      mapping,
      transactions: [first, selectedDuplicate, alreadyExported],
      history: [
        {
          format: "quickbooks_csv",
          accountId: account.id,
          transactionId: "past-original",
          transactionFingerprint: fingerprintForPlan(alreadyExported, mapping),
          exportedAt: NOW,
        },
      ],
      createdAt: NOW,
    });

    expect(firstPlan.eligibleTransactions.map((transaction) => transaction.id)).toEqual(["first"]);
    expect(firstPlan.duplicates.map((duplicate) => duplicate.reason).sort()).toEqual([
      "already_exported",
      "duplicate_in_selection",
    ]);
    expect("bytes" in firstPlan).toBe(false);
  });

  it("rejects selections where every transaction was previously exported", () => {
    const account = makeAccount();
    const transaction = makeTransaction(account);
    const mapping = quickBooksMapping(account.id, account.legalEntityId);
    expect(() =>
      planExport({
        mapping,
        transactions: [transaction],
        history: [
          {
            format: mapping.format,
            accountId: account.id,
            transactionId: transaction.id,
            transactionFingerprint: fingerprintForPlan(transaction, mapping),
            exportedAt: NOW,
          },
        ],
        createdAt: NOW,
      }),
    ).toThrow(DuplicateExportError);
  });

  it("rejects cross-account and cross-entity export plans", () => {
    const account = makeAccount();
    const other = makeAccount({ id: "other", legalEntityId: "other-entity" });
    expect(() =>
      planExport({
        mapping: quickBooksMapping(account.id, account.legalEntityId),
        transactions: [makeTransaction(other)],
        createdAt: NOW,
      }),
    ).toThrow(ValidationError);
  });

  it("rejects duplicate fingerprints that would require silent monetary rounding", () => {
    const account = makeAccount({
      id: "jp-company",
      legalEntityId: "jp-entity",
      country: "JP",
      currency: "JPY",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const mapping: ExportMapping = {
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      currency: "JPY",
      format: "money_forward_ledger_csv",
      moneyForward: { liabilityAccount: "未払金", expenseAccount: "旅費交通費" },
    };
    expect(() =>
      planExport({ mapping, transactions: [makeTransaction(account, { amount: "-10.5" })], createdAt: NOW }),
    ).toThrowError(/minor-unit precision/iu);
  });

  it("requires the exact human confirmation and a valid plan-bound HMAC token", () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    expect(() => authority.approve({ plan, approvedBy: "owner", confirmation: "yes" })).toThrow(ExportApprovalError);
    const approval = authority.approve({
      plan,
      approvedBy: "local-owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    expect(() => authority.assertApproved(plan, { ...approval, token: `${approval.token}x` })).toThrow(ExportApprovalError);
    expect(() => authority.assertApproved({ ...plan, requestDigest: "different" }, approval)).toThrow(ExportApprovalError);
  });

  it("rejects mapping mutation after human approval", () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({
      plan,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const mutablePlan = plan as unknown as { mapping: { quickBooks: { accountName: string } } };
    mutablePlan.mapping.quickBooks.accountName = "Changed After Approval";

    expect(() =>
      generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW }),
    ).toThrowError(/changed after planning/iu);
  });

  it("rejects eligible transaction mutation after human approval", () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({
      plan,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const mutablePlan = plan as unknown as { eligibleTransactions: Array<{ amount: string }> };
    const transaction = mutablePlan.eligibleTransactions[0];
    if (transaction === undefined) throw new Error("Test plan unexpectedly has no eligible transaction");
    transaction.amount = "-999999.00";

    expect(() =>
      generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW }),
    ).toThrow(ExportApprovalError);
  });

  it("expires short-lived approvals", () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    let clock = new Date(NOW);
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => clock, ttlMs: 1000 });
    const approval = authority.approve({
      plan,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    clock = new Date(clock.getTime() + 1001);
    expect(() => authority.assertApproved(plan, approval)).toThrow(ExportApprovalError);
  });

  it("consumes an approval exactly once across sequential generation attempts", () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });

    expect(generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW }).files).toHaveLength(1);
    expect(() => generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW })).toThrowError(
      /already been used/iu,
    );
  });

  it("atomically permits only one concurrent replay attempt", async () => {
    const account = makeAccount();
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [makeTransaction(account)],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
    const generate = () => generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });

    const results = await Promise.allSettled([
      Promise.resolve().then(generate),
      Promise.resolve().then(generate),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "EXPORT_APPROVAL_REQUIRED" }),
    });
  });

  it("generates a UTF-8 BOM QuickBooks CSV only after approval and neutralizes formula cells", () => {
    const account = makeAccount();
    const transaction = makeTransaction(account, { description: "=DANGEROUS()" });
    const plan = planExport({
      mapping: quickBooksMapping(account.id, account.legalEntityId),
      transactions: [transaction],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({
      plan,
      approvedBy: "owner",
      confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE,
    });
    const packageResult = generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });

    const bytes = Buffer.from(packageResult.files[0]?.bytes ?? []);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toContain("'=DANGEROUS()");
    expect(packageResult.automaticPosting).toBe(false);
    expect(packageResult.historyRecords).toHaveLength(1);
  });

  it.each(["quickbooks_qbo", "quickbooks_qfx"] as const)("generates %s OFX import files", (format) => {
    const account = makeAccount();
    const mapping: ExportMapping = { ...quickBooksMapping(account.id, account.legalEntityId), format };
    const plan = planExport({ mapping, transactions: [makeTransaction(account)], createdAt: NOW });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
    const result = generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });
    expect(Buffer.from(result.files[0]?.bytes ?? []).toString("ascii")).toContain("<CCSTMTRS>");
    expect(result.files[0]?.fileName.endsWith(`.${format === "quickbooks_qbo" ? "qbo" : "qfx"}`)).toBe(true);
  });

  it("uses reviewed OFX mapping values and escapes SGML text", () => {
    const account = makeAccount();
    const mapping: ExportMapping = {
      ...quickBooksMapping(account.id, account.legalEntityId),
      format: "quickbooks_qbo",
      quickBooks: {
        accountReference: "LOCAL-REF-9",
        accountName: "Test Card",
        bankId: "9876",
        ledgerBalance: "123.45",
      },
    };
    const transaction = makeTransaction(account, {
      description: "A&B <Cafe>",
      memo: "Memo > reviewed",
    });
    const plan = planExport({ mapping, transactions: [transaction], createdAt: NOW });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
    const result = generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });
    const text = Buffer.from(result.files[0]?.bytes ?? []).toString("ascii");

    expect(text).toContain("<INTU.BID>9876");
    expect(text).not.toContain("<INTU.BID>3000");
    expect(text).toContain("<BALAMT>123.45");
    expect(text).toContain("<NAME>A&amp;B &lt;Cafe&gt;");
    expect(text).toContain("<MEMO>Memo &gt; reviewed");
  });

  it("rejects malicious OFX identifiers, balances, and dates before approval", () => {
    const account = makeAccount();
    const base = quickBooksMapping(account.id, account.legalEntityId);
    const transaction = makeTransaction(account);
    const invalidMappings: ExportMapping[] = [
      {
        ...base,
        format: "quickbooks_qbo",
        quickBooks: { accountReference: "LOCAL-REF", accountName: "Test Card" },
      },
      {
        ...base,
        format: "quickbooks_qbo",
        quickBooks: { ...base.quickBooks!, accountReference: "X</ACCTID><EVIL>" },
      },
      {
        ...base,
        format: "quickbooks_qbo",
        quickBooks: { ...base.quickBooks!, ledgerBalance: "0</BALAMT><EVIL>" },
      },
      {
        ...base,
        format: "quickbooks_qbo",
        quickBooks: { ...base.quickBooks!, bankId: "3000<EVIL>" },
      },
    ];
    for (const mapping of invalidMappings) {
      expect(() => planExport({ mapping, transactions: [transaction], createdAt: NOW })).toThrow(ValidationError);
    }
    expect(() =>
      planExport({
        mapping: { ...base, format: "quickbooks_qbo" },
        transactions: [makeTransaction(account, { postedAt: "2026-01-01<EVIL>" })],
        createdAt: NOW,
      }),
    ).toThrowError(/ISO date/iu);
  });

  it("fails closed instead of replacing non-ASCII OFX transaction text", () => {
    const account = makeAccount();
    const mapping: ExportMapping = {
      ...quickBooksMapping(account.id, account.legalEntityId),
      format: "quickbooks_qbo",
    };
    const plan = planExport({
      mapping,
      transactions: [makeTransaction(account, { description: "東京の店舗" })],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
    expect(() => generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW })).toThrowError(
      /cannot be represented losslessly in OFX US-ASCII/iu,
    );
  });

  it("generates Money Forward statement, journal, and ledger CSV encodings without posting", () => {
    const account = makeAccount({
      id: "jp-company",
      legalEntityId: "jp-entity",
      legalEntityName: "テスト株式会社",
      country: "JP",
      currency: "JPY",
      accountClass: "company",
      businessPurpose: "出張費",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    for (const format of [
      "money_forward_statement_csv",
      "money_forward_journal_csv",
      "money_forward_ledger_csv",
    ] as const) {
      const mapping: ExportMapping = {
        accountId: account.id,
        legalEntityId: account.legalEntityId,
        currency: "JPY",
        format,
        moneyForward: {
          liabilityAccount: "未払金",
          expenseAccount: "旅費交通費",
          department: "営業部",
          ...(format === "money_forward_statement_csv" ? { encoding: "utf8_bom" as const } : {}),
        },
      };
      const plan = planExport({ mapping, transactions: [makeTransaction(account, { amount: "-1500" })], createdAt: NOW });
      const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
      const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
      const result = generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });
      expect(result.files[0]?.encoding).toBe(format === "money_forward_statement_csv" ? "utf8_bom" : "shift_jis");
      if (format === "money_forward_ledger_csv") {
        const text = iconv.decode(Buffer.from(result.files[0]?.bytes ?? []), "shift_jis");
        expect(text).toContain("相手勘定科目");
        expect(text).toContain("未払金");
        expect(result.files[0]?.fileName).toContain("money-forward-ledger");
      }
      expect(result.automaticPosting).toBe(false);
    }
  });

  it("fails closed when Shift-JIS cannot represent export text", () => {
    const account = makeAccount({
      id: "jp-company",
      legalEntityId: "jp-entity",
      country: "JP",
      currency: "JPY",
      accountClass: "company",
      businessPurpose: "出張費",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const mapping: ExportMapping = {
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      currency: "JPY",
      format: "money_forward_ledger_csv",
      moneyForward: {
        liabilityAccount: "未払金",
        expenseAccount: "旅費交通費",
        encoding: "shift_jis",
      },
    };
    const plan = planExport({
      mapping,
      transactions: [makeTransaction(account, { description: "Unrepresentable emoji 😀", amount: "-1000" })],
      createdAt: NOW,
    });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });

    expect(() => generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW })).toThrowError(
      /cannot be represented losslessly/iu,
    );
  });

  it("writes Money Forward ledger charge and credit directions without rounding", () => {
    const account = makeAccount({
      id: "jp-company",
      legalEntityId: "jp-entity",
      country: "JP",
      currency: "JPY",
      accountClass: "company",
      businessPurpose: "出張費",
      collectionMethod: "statement_import",
      authorization: { state: "import_only", checkedAt: NOW },
    });
    const mapping: ExportMapping = {
      accountId: account.id,
      legalEntityId: account.legalEntityId,
      currency: "JPY",
      format: "money_forward_ledger_csv",
      moneyForward: { liabilityAccount: "未払金", expenseAccount: "旅費交通費", encoding: "shift_jis" },
    };
    const transactions = [
      makeTransaction(account, { id: "charge", description: "出張", amount: "-1500" }),
      makeTransaction(account, { id: "credit", postedAt: "2026-01-11", description: "返金", amount: "500" }),
    ];
    const plan = planExport({ mapping, transactions, createdAt: NOW });
    const authority = new HmacExportApprovalAuthority(APPROVAL_KEY, { now: () => new Date(NOW) });
    const approval = authority.approve({ plan, approvedBy: "owner", confirmation: HUMAN_EXPORT_CONFIRMATION_PHRASE });
    const result = generateExportPackage({ plan, approval, approvalAuthority: authority, generatedAt: NOW });
    const text = iconv.decode(Buffer.from(result.files[0]?.bytes ?? []), "shift_jis");
    const rows = parse(text, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;

    expect(rows[0]).toMatchObject({ "借方金額(円)": "", "貸方金額(円)": "1500" });
    expect(rows[1]).toMatchObject({ "借方金額(円)": "500", "貸方金額(円)": "" });
  });
});

function quickBooksMapping(accountId: string, legalEntityId: string): ExportMapping {
  return {
    accountId,
    legalEntityId,
    format: "quickbooks_csv",
    currency: "USD",
    quickBooks: { accountReference: "LOCAL-ACCOUNT-REF", accountName: "Test Card", bankId: "3000" },
  };
}

function fingerprintForPlan(transaction: ReturnType<typeof makeTransaction>, mapping: ExportMapping): string {
  void mapping;
  return exportTransactionFingerprint(transaction);
}
