import type { AmexAccount } from "../../../src/core";
import { makeAccount, NOW } from "../fixtures";

export function makeJapanImportAccount(overrides: Partial<AmexAccount> = {}): AmexAccount {
  return makeAccount({
    id: "jp-import",
    displayName: "Japan test card",
    country: "JP",
    currency: "JPY",
    accountClass: "personal",
    collectionMethod: "statement_import",
    authorization: { state: "import_only", checkedAt: NOW },
    ...overrides,
  });
}

export function makeStoredZip(entries: Readonly<Record<string, string | Buffer>>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function makeStatementXlsx(options: { readonly includeMacro?: boolean; readonly includeFormula?: boolean } = {}): Buffer {
  const serial = Math.round((Date.UTC(2026, 0, 8) - Date.UTC(1899, 11, 30)) / 86_400_000);
  return makeStoredZip({
    "[Content_Types].xml": "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
    "xl/workbook.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
      "<sheets><sheet name=\"利用明細\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>",
    ].join(""),
    "xl/_rels/workbook.xml.rels": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<Relationships><Relationship Id=\"rId1\" Type=\"worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>",
    ].join(""),
    "xl/styles.xml": "<styleSheet><cellXfs count=\"2\"><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>",
    "xl/sharedStrings.xml": [
      "<sst>",
      "<si><t>ご利用日</t></si><si><t>ご利用店名</t></si><si><t>ご利用金額</t></si>",
      "<si><t>受付番号</t></si><si><t>サンプル店舗</t></si><si><t>jp-ref-1</t></si>",
      "</sst>",
    ].join(""),
    "xl/worksheets/sheet1.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<worksheet><sheetData>",
      "<row r=\"1\">",
      sharedCell("A1", 0),
      sharedCell("B1", 1),
      sharedCell("C1", 2),
      sharedCell("D1", 3),
      "</row>",
      "<row r=\"2\">",
      `<c r="A2" s="1"><v>${serial}</v></c>`,
      sharedCell("B2", 4),
      options.includeFormula
        ? "<c r=\"C2\"><f>1+1199</f><v>1200</v></c>"
        : "<c r=\"C2\"><v>1200</v></c>",
      sharedCell("D2", 5),
      "</row>",
      "</sheetData></worksheet>",
    ].join(""),
    ...(options.includeMacro ? { "xl/vbaProject.bin": Buffer.from([1, 2, 3]) } : {}),
  });
}

export function makeTextPdf(textOperator: string, extraDictionary = ""): Buffer {
  const stream = Buffer.from(`BT\n${textOperator}\nET\n`, "utf8");
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} ${extraDictionary} >>\nstream\n`, "ascii"),
    stream,
    Buffer.from("endstream\nendobj\n%%EOF\n", "ascii"),
  ]);
}

function sharedCell(reference: string, index: number): string {
  return `<c r="${reference}" t="s"><v>${index}</v></c>`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
