import { createHash } from "node:crypto";

import type { FinancialTransaction } from "../domain";
import { ValidationError } from "../errors";
import { canonicalCurrencyAmount } from "../money";
import { assertIsoDate, assertIsoInstant } from "../validation";
import { csvRow, encodeText, fileSafe, safeTextCell } from "./csv-utils";
import type { ExportFile, ExportMapping } from "./types";

export function buildQuickBooksCsv(
  transactions: readonly FinancialTransaction[],
  mapping: ExportMapping,
): ExportFile {
  const quickBooks = requireMapping(mapping);
  const rows = [
    csvRow(["Date", "Description", "Amount", "Account", "Reference"]),
    ...transactions.map((transaction) =>
      csvRow([
        usDate(transaction.postedAt),
        safeTextCell(transaction.description),
        transaction.amount,
        safeTextCell(quickBooks.accountName),
        safeTextCell(transaction.externalId ?? transaction.id),
      ]),
    ),
  ];
  const encoded = encodeText(`${rows.join("\r\n")}\r\n`, "utf8_bom");
  return {
    fileName: `${fileSafe(quickBooks.accountName)}-quickbooks.csv`,
    mediaType: "text/csv",
    encoding: "utf8_bom",
    bytes: encoded.bytes,
  };
}

export function buildQuickBooksOfx(
  transactions: readonly FinancialTransaction[],
  mapping: ExportMapping,
  flavor: "qbo" | "qfx",
  generatedAt: string,
): ExportFile {
  const quickBooks = requireMapping(mapping);
  assertIsoInstant(generatedAt, "generatedAt");
  for (const transaction of transactions) assertIsoDate(transaction.postedAt, "transaction.postedAt");
  const dates = transactions.map((transaction) => transaction.postedAt).sort();
  const start = dates[0];
  const end = dates.at(-1);
  if (start === undefined || end === undefined) throw new ValidationError("Cannot create an empty OFX file");
  const transactionsSgml = transactions
    .map(
      (transaction) => `<STMTTRN>
<TRNTYPE>${transaction.amount.startsWith("-") ? "DEBIT" : "CREDIT"}
<DTPOSTED>${ofxDate(transaction.postedAt)}
<TRNAMT>${transaction.amount}
<FITID>${fitId(transaction)}
<NAME>${ofxText(transaction.description, 64)}
<MEMO>${ofxText(transaction.memo ?? transaction.description, 255)}
</STMTTRN>`,
    )
    .join("\n");
  if (flavor === "qbo" && quickBooks.bankId === undefined) {
    throw new ValidationError("QBO export requires a reviewed QuickBooks bankId/Intuit BID");
  }
  const intu = quickBooks.bankId === undefined ? "" : `\n<INTU.BID>${ofxIdentifier(quickBooks.bankId, "bankId", 12)}`;
  const ledgerBalance = quickBooks.ledgerBalance === undefined
    ? ""
    : `\n<LEDGERBAL><BALAMT>${canonicalCurrencyAmount(
        quickBooks.ledgerBalance,
        mapping.currency,
        "QuickBooks ledger balance",
      )}<DTASOF>${ofxDate(end)}</LEDGERBAL>`;
  const text = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>${ofxInstant(generatedAt)}
<LANGUAGE>ENG${intu}
</SONRS>
</SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>${createHash("sha256").update(`${mapping.accountId}|${generatedAt}`).digest("hex").slice(0, 32)}
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS>
<CURDEF>${mapping.currency}
<CCACCTFROM><ACCTID>${ofxIdentifier(quickBooks.accountReference, "accountReference", 22)}</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>${ofxDate(start)}
<DTEND>${ofxDate(end)}
${transactionsSgml}
</BANKTRANLIST>
${ledgerBalance}
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;
  assertUsAscii(text, "OFX document");
  const bytes = Buffer.from(text, "ascii");
  return {
    fileName: `${fileSafe(quickBooks.accountName)}.${flavor}`,
    mediaType: "application/x-ofx",
    encoding: "binary",
    bytes,
  };
}

function requireMapping(mapping: ExportMapping) {
  if (mapping.quickBooks === undefined) throw new ValidationError("QuickBooks mapping is missing");
  return mapping.quickBooks;
}

function usDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${month ?? ""}/${day ?? ""}/${year ?? ""}`;
}

function ofxDate(isoDate: string): string {
  return isoDate.replace(/-/gu, "");
}

function ofxInstant(instant: string): string {
  return instant.replace(/[-:TZ.]/gu, "").slice(0, 14);
}

function fitId(transaction: FinancialTransaction): string {
  const source = transaction.externalId ?? transaction.id;
  return createHash("sha256").update(`${transaction.source.accountId}|${source}`).digest("hex").slice(0, 32);
}

function ofxText(value: string, limit: number): string {
  assertUsAscii(value, "OFX transaction text");
  const limited = value.replace(/\s+/gu, " ").trim().slice(0, limit);
  return limited.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function ofxIdentifier(value: string, field: string, limit: number): string {
  if (value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new ValidationError(`OFX ${field} is not a valid reviewed ASCII identifier`, { field });
  }
  return value;
}

function assertUsAscii(value: string, field: string): void {
  if (/[^\x09\x0A\x0D\x20-\x7E]/u.test(value)) {
    throw new ValidationError(`${field} contains text that cannot be represented losslessly in OFX US-ASCII`, {
      field,
    });
  }
}
