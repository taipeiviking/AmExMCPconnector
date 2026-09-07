import { inflateRawSync } from "node:zlib";

import { ValidationError } from "../errors";
import { fingerprintBytes } from "./common";
import { parseTabularRows } from "./tabular";
import type { AmountConvention, CsvColumnMap, ImportContext, ParsedTransactionImport } from "./types";

const MAX_XLSX_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 512;

export interface ParseStatementXlsxOptions {
  readonly sheetName?: string;
  readonly headerRow?: number;
  readonly columns?: CsvColumnMap;
  readonly amountConvention?: AmountConvention;
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

interface WorkbookSheet {
  readonly name: string;
  readonly relationshipId: string;
  readonly hidden: boolean;
}

interface ExtractedWorksheet {
  readonly rows: readonly (readonly string[])[];
  readonly sourceRowNumbers: readonly number[];
}

export function parseStatementXlsx(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseStatementXlsxOptions = {},
): ParsedTransactionImport {
  if (context.account.collectionMethod !== "statement_import") {
    throw new ValidationError("XLSX imports are only allowed for import-configured accounts", {
      accountId: context.account.id,
    });
  }
  const workbook = new SafeZipArchive(bytes);
  if (workbook.entryNames().some((name) => name.toLocaleLowerCase("en-US") === "xl/vbaproject.bin")) {
    throw new ValidationError("Macro-enabled Excel workbooks are not accepted; export an .xlsx file without macros");
  }
  if (workbook.entryNames().some((name) => name.toLocaleLowerCase("en-US").startsWith("xl/externallinks/"))) {
    throw new ValidationError("Excel workbooks with external links are not accepted");
  }

  const workbookXml = workbook.readXml("xl/workbook.xml");
  const relationshipsXml = workbook.readXml("xl/_rels/workbook.xml.rels");
  const sheets = parseWorkbookSheets(workbookXml);
  const selected = selectSheet(sheets, options.sheetName);
  const relationshipTarget = relationshipTargetFor(relationshipsXml, selected.relationshipId);
  const worksheetPath = resolveWorkbookTarget(relationshipTarget);
  if (!worksheetPath.startsWith("xl/worksheets/")) {
    throw new ValidationError("Selected Excel sheet relationship does not target a worksheet");
  }

  const sharedStrings = workbook.hasEntry("xl/sharedStrings.xml")
    ? parseSharedStrings(workbook.readXml("xl/sharedStrings.xml"))
    : [];
  const dateStyles = workbook.hasEntry("xl/styles.xml")
    ? parseDateStyleIndexes(workbook.readXml("xl/styles.xml"))
    : new Set<number>();
  const date1904 = parseBooleanAttribute(firstTagAttributes(workbookXml, "workbookPr"), "date1904");
  const worksheet = extractWorksheetRows(
    workbook.readXml(worksheetPath),
    sharedStrings,
    dateStyles,
    date1904,
  );
  const sourceFingerprint = fingerprintBytes(bytes);
  const parsed = parseTabularRows(worksheet.rows, context, {
    format: "xlsx",
    sourceFingerprint,
    inputBytes: bytes.length,
    sourceRowNumbers: worksheet.sourceRowNumbers,
    ...(options.headerRow === undefined ? {} : { headerRow: options.headerRow }),
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.amountConvention === undefined ? {} : { amountConvention: options.amountConvention }),
  });
  return { ...parsed, metadata: { ...parsed.metadata, worksheetName: selected.name } };
}

class SafeZipArchive {
  readonly #bytes: Buffer;
  readonly #entries = new Map<string, ZipEntry>();

  public constructor(input: Uint8Array) {
    if (input.length === 0 || input.length > MAX_XLSX_BYTES) {
      throw new ValidationError("XLSX must be non-empty and no larger than 25 MiB", { bytes: input.length });
    }
    this.#bytes = Buffer.from(input);
    this.#readDirectory();
    if (!this.hasEntry("[Content_Types].xml") || !this.hasEntry("xl/workbook.xml")) {
      throw new ValidationError("File is not a valid XLSX workbook");
    }
  }

  public hasEntry(name: string): boolean {
    return this.#entries.has(name);
  }

  public entryNames(): readonly string[] {
    return [...this.#entries.keys()];
  }

  public readXml(name: string): string {
    const bytes = this.#readEntry(name);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
    } catch (caught) {
      throw new ValidationError("XLSX XML is not valid UTF-8", {
        entry: name,
        cause: caught instanceof Error ? caught.message : "invalid byte sequence",
      });
    }
    if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
      throw new ValidationError("XLSX XML declarations and external entities are not accepted", { entry: name });
    }
    return text;
  }

  #readDirectory(): void {
    const eocd = findEndOfCentralDirectory(this.#bytes);
    const diskNumber = readUInt16(this.#bytes, eocd + 4);
    const directoryDisk = readUInt16(this.#bytes, eocd + 6);
    const entriesOnDisk = readUInt16(this.#bytes, eocd + 8);
    const entryCount = readUInt16(this.#bytes, eocd + 10);
    const directorySize = readUInt32(this.#bytes, eocd + 12);
    const directoryOffset = readUInt32(this.#bytes, eocd + 16);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ValidationError("Multi-volume XLSX archives are not supported");
    }
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      throw new ValidationError("ZIP64 XLSX archives are not supported");
    }
    if (entryCount > MAX_ZIP_ENTRIES) throw new ValidationError("XLSX archive contains too many entries");
    assertRange(this.#bytes, directoryOffset, directorySize, "XLSX central directory");

    let cursor = directoryOffset;
    let declaredTotal = 0;
    for (let index = 0; index < entryCount; index += 1) {
      assertSignature(this.#bytes, cursor, 0x02014b50, "XLSX central directory entry");
      const flags = readUInt16(this.#bytes, cursor + 8);
      const method = readUInt16(this.#bytes, cursor + 10);
      const crc32 = readUInt32(this.#bytes, cursor + 16);
      const compressedSize = readUInt32(this.#bytes, cursor + 20);
      const uncompressedSize = readUInt32(this.#bytes, cursor + 24);
      const nameLength = readUInt16(this.#bytes, cursor + 28);
      const extraLength = readUInt16(this.#bytes, cursor + 30);
      const commentLength = readUInt16(this.#bytes, cursor + 32);
      const diskStart = readUInt16(this.#bytes, cursor + 34);
      const localHeaderOffset = readUInt32(this.#bytes, cursor + 42);
      const fixedSize = 46;
      assertRange(this.#bytes, cursor + fixedSize, nameLength + extraLength + commentLength, "XLSX entry name");
      const rawName = this.#bytes.subarray(cursor + fixedSize, cursor + fixedSize + nameLength);
      const name = decodeZipName(rawName, flags);
      validateZipPath(name);
      if ((flags & 0x0001) !== 0) throw new ValidationError("Encrypted XLSX entries are not accepted", { entry: name });
      if (diskStart !== 0) throw new ValidationError("Multi-volume XLSX entries are not supported", { entry: name });
      if (method !== 0 && method !== 8) {
        throw new ValidationError("XLSX uses an unsupported ZIP compression method", { entry: name, method });
      }
      if (uncompressedSize > MAX_ENTRY_BYTES) {
        throw new ValidationError("XLSX entry exceeds the 25 MiB safety limit", { entry: name });
      }
      declaredTotal += uncompressedSize;
      if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new ValidationError("XLSX expanded content exceeds the 50 MiB safety limit");
      }
      if (this.#entries.has(name)) throw new ValidationError("XLSX repeats an archive entry", { entry: name });
      this.#entries.set(name, {
        name,
        flags,
        method,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor += fixedSize + nameLength + extraLength + commentLength;
    }
    if (cursor !== directoryOffset + directorySize) {
      throw new ValidationError("XLSX central directory size is inconsistent");
    }
  }

  #readEntry(name: string): Buffer {
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new ValidationError("XLSX is missing a required entry", { entry: name });
    const offset = entry.localHeaderOffset;
    assertSignature(this.#bytes, offset, 0x04034b50, "XLSX local file header");
    const localFlags = readUInt16(this.#bytes, offset + 6);
    const localMethod = readUInt16(this.#bytes, offset + 8);
    const nameLength = readUInt16(this.#bytes, offset + 26);
    const extraLength = readUInt16(this.#bytes, offset + 28);
    assertRange(this.#bytes, offset + 30, nameLength, "XLSX local entry name");
    const localName = decodeZipName(this.#bytes.subarray(offset + 30, offset + 30 + nameLength), localFlags);
    if (localName !== entry.name || localMethod !== entry.method || localFlags !== entry.flags) {
      throw new ValidationError("XLSX local and central ZIP headers disagree", { entry: entry.name });
    }
    const dataOffset = offset + 30 + nameLength + extraLength;
    assertRange(this.#bytes, dataOffset, entry.compressedSize, "XLSX compressed entry");
    const compressed = this.#bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
    let result: Buffer;
    try {
      result = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (caught) {
      throw new ValidationError("XLSX entry could not be decompressed", {
        entry: name,
        cause: caught instanceof Error ? caught.message : "decompression failed",
      });
    }
    if (result.length !== entry.uncompressedSize) {
      throw new ValidationError("XLSX entry expanded to an unexpected size", { entry: name });
    }
    if (crc32(result) !== entry.crc32) throw new ValidationError("XLSX entry failed its CRC integrity check", { entry: name });
    return result;
  }
}

function parseWorkbookSheets(xml: string): readonly WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [];
  const pattern = /<sheet\b([^>]*)\/?\s*>/giu;
  for (const match of xml.matchAll(pattern)) {
    const attributes = parseAttributes(match[1] ?? "");
    const name = attributes.get("name");
    const relationshipId = attributes.get("r:id");
    if (name === undefined || relationshipId === undefined) continue;
    sheets.push({ name, relationshipId, hidden: (attributes.get("state") ?? "visible") !== "visible" });
  }
  if (sheets.length === 0) throw new ValidationError("XLSX workbook contains no worksheets");
  return sheets;
}

function selectSheet(sheets: readonly WorkbookSheet[], requested: string | undefined): WorkbookSheet {
  if (requested !== undefined) {
    const match = sheets.find((sheet) => sheet.name === requested);
    if (match === undefined) throw new ValidationError(`XLSX worksheet '${requested}' was not found`);
    if (match.hidden) throw new ValidationError(`XLSX worksheet '${requested}' is hidden`);
    return match;
  }
  const visible = sheets.find((sheet) => !sheet.hidden);
  if (visible === undefined) throw new ValidationError("XLSX workbook has no visible worksheet");
  return visible;
}

function relationshipTargetFor(xml: string, id: string): string {
  const pattern = /<Relationship\b([^>]*)\/?\s*>/giu;
  for (const match of xml.matchAll(pattern)) {
    const attributes = parseAttributes(match[1] ?? "");
    if (attributes.get("Id") !== id) continue;
    if ((attributes.get("TargetMode") ?? "Internal") !== "Internal") {
      throw new ValidationError("External XLSX relationships are not accepted");
    }
    const target = attributes.get("Target");
    if (target === undefined) break;
    return target;
  }
  throw new ValidationError("XLSX worksheet relationship is missing", { relationshipId: id });
}

function resolveWorkbookTarget(target: string): string {
  const combined = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of combined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new ValidationError("XLSX relationship escapes the archive root");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function parseSharedStrings(xml: string): readonly string[] {
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)) {
    const fragments = [...(match[1] ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)];
    strings.push(fragments.map((fragment) => decodeXmlText(fragment[1] ?? "")).join(""));
    if (strings.length > 1_000_000) throw new ValidationError("XLSX contains too many shared strings");
  }
  return strings;
}

function parseDateStyleIndexes(xml: string): ReadonlySet<number> {
  const customFormats = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?\s*>/giu)) {
    const attributes = parseAttributes(match[1] ?? "");
    const id = Number(attributes.get("numFmtId"));
    const code = attributes.get("formatCode");
    if (Number.isInteger(id) && code !== undefined) customFormats.set(id, code);
  }
  const cellXfsBody = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/iu.exec(xml)?.[1] ?? "";
  const result = new Set<number>();
  let index = 0;
  for (const match of cellXfsBody.matchAll(/<xf\b([^>]*)\/?\s*>/giu)) {
    const id = Number(parseAttributes(match[1] ?? "").get("numFmtId") ?? 0);
    if (isDateFormat(id, customFormats.get(id))) result.add(index);
    index += 1;
  }
  return result;
}

function extractWorksheetRows(
  xml: string,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
  date1904: boolean,
): ExtractedWorksheet {
  const rows: string[][] = [];
  const sourceRowNumbers: number[] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/giu)) {
    const rowAttributes = parseAttributes(rowMatch[1] ?? "");
    const declaredRow = Number(rowAttributes.get("r"));
    const sourceRow = Number.isSafeInteger(declaredRow) && declaredRow > 0 ? declaredRow : rows.length + 1;
    const cells: string[] = [];
    let sequentialColumn = 0;
    const body = rowMatch[2] ?? "";
    const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/giu;
    for (const cellMatch of body.matchAll(cellPattern)) {
      const attributes = parseAttributes(cellMatch[1] ?? cellMatch[3] ?? "");
      const reference = attributes.get("r");
      const column = reference === undefined ? sequentialColumn : columnIndex(reference);
      if (column >= 256) throw new ValidationError("XLSX worksheet exceeds 256 columns", { cell: reference });
      sequentialColumn = column + 1;
      const style = Number(attributes.get("s") ?? -1);
      cells[column] = parseCellValue(
        cellMatch[2] ?? "",
        attributes.get("t"),
        Number.isInteger(style) ? style : -1,
        sharedStrings,
        dateStyles,
        date1904,
      );
    }
    while (cells.length > 0 && (cells[cells.length - 1] ?? "") === "") cells.pop();
    rows.push(Array.from({ length: cells.length }, (_, index) => cells[index] ?? ""));
    sourceRowNumbers.push(sourceRow);
    if (rows.length > 100_001) throw new ValidationError("XLSX worksheet contains more than 100,000 data rows");
  }
  return { rows, sourceRowNumbers };
}

function parseCellValue(
  body: string,
  type: string | undefined,
  style: number,
  sharedStrings: readonly string[],
  dateStyles: ReadonlySet<number>,
  date1904: boolean,
): string {
  if (/<f\b/iu.test(body)) {
    throw new ValidationError("Excel formula cells are not accepted; use the official values-only statement export");
  }
  if (type === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/giu)]
      .map((match) => decodeXmlText(match[1] ?? ""))
      .join("");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/iu.exec(body)?.[1];
  if (raw === undefined) return "";
  const value = decodeXmlText(raw).trim();
  if (type === "s") {
    const index = Number(value);
    const shared = Number.isSafeInteger(index) ? sharedStrings[index] : undefined;
    if (shared === undefined) throw new ValidationError("XLSX cell references an invalid shared string", { index: value });
    return shared;
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  if ((type === undefined || type === "n") && dateStyles.has(style)) return excelSerialToIsoDate(value, date1904);
  return value;
}

function excelSerialToIsoDate(value: string, date1904: boolean): string {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) {
    throw new ValidationError("XLSX date serial is invalid", { value });
  }
  const wholeDays = Math.floor(serial);
  let timestamp: number;
  if (date1904) {
    timestamp = Date.UTC(1904, 0, 1) + wholeDays * 86_400_000;
  } else {
    if (wholeDays === 60) throw new ValidationError("XLSX uses Excel's non-existent 1900-02-29 date");
    const adjustedDays = wholeDays > 60 ? wholeDays - 1 : wholeDays;
    timestamp = Date.UTC(1900, 0, 1) + (adjustedDays - 1) * 86_400_000;
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new ValidationError("XLSX date serial is outside the supported range");
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1)
    .toString()
    .padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}

function columnIndex(reference: string): number {
  const match = /^([A-Z]+)\d+$/iu.exec(reference);
  if (match === null) throw new ValidationError("XLSX cell reference is invalid", { reference });
  let result = 0;
  for (const character of (match[1] ?? "").toLocaleUpperCase("en-US")) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function isDateFormat(id: number, custom: string | undefined): boolean {
  if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
  if (custom === undefined) return false;
  const withoutLiterals = custom.replace(/"[^"]*"|\\.|\[[^\]]*\]/gu, "").toLocaleLowerCase("en-US");
  return /(?:y+|d{1,4})/u.test(withoutLiterals) && /m{1,4}/u.test(withoutLiterals);
}

function firstTagAttributes(xml: string, tag: string): ReadonlyMap<string, string> {
  const match = new RegExp(`<${tag}\\b([^>]*)/?>`, "iu").exec(xml);
  return parseAttributes(match?.[1] ?? "");
}

function parseBooleanAttribute(attributes: ReadonlyMap<string, string>, name: string): boolean {
  return ["1", "true", "yes"].includes((attributes.get(name) ?? "").toLocaleLowerCase("en-US"));
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(pattern)) {
    const key = match[1];
    if (key !== undefined) result.set(key, decodeXmlText(match[2] ?? match[3] ?? ""));
  }
  return result;
}

function decodeXmlText(value: string): string {
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (entity, body: string) => {
    const normalized = body.toLocaleLowerCase("en-US");
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new ValidationError("XLSX contains an invalid XML character reference", { entity });
    }
    return String.fromCodePoint(codePoint);
  });
  if (/&[\w#]+;/u.test(decoded)) throw new ValidationError("XLSX contains an unsupported XML entity");
  return decoded.replace(/_x([0-9a-f]{4})_/giu, (_whole, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = readUInt16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new ValidationError("XLSX ZIP central directory is missing");
}

function decodeZipName(bytes: Buffer, flags: number): string {
  if ((flags & 0x0800) === 0 && bytes.some((byte) => byte > 0x7f)) {
    throw new ValidationError("XLSX contains a non-UTF-8 archive path");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("XLSX contains an invalid archive path");
  }
}

function validateZipPath(name: string): void {
  if (
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === ".." || part === ".")
  ) {
    throw new ValidationError("XLSX contains an unsafe archive path", { entry: name });
  }
}

function assertSignature(bytes: Buffer, offset: number, expected: number, label: string): void {
  assertRange(bytes, offset, 4, label);
  if (bytes.readUInt32LE(offset) !== expected) throw new ValidationError(`${label} is invalid`);
}

function assertRange(bytes: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new ValidationError(`${label} points outside the file`);
  }
}

function readUInt16(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 2, "XLSX numeric field");
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 4, "XLSX numeric field");
  return bytes.readUInt32LE(offset);
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
