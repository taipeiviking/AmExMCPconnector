import { inflateSync } from "node:zlib";

import { ValidationError } from "../errors";
import { fingerprintBytes } from "./common";
import { parseTabularRows } from "./tabular";
import type { AmountConvention, ImportContext, ParsedTransactionImport } from "./types";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_STREAM_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_STREAM_BYTES = 50 * 1024 * 1024;
const MAX_PDF_STREAMS = 2_000;

const DEFAULT_ROW_PATTERN = /^\s*(?<date>\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}(?:\/|')\d{2,4})\s+(?<description>.+?)\s+(?<amount>[-+]?[$¥￥]?[\d,]+(?:\.\d+)?|\([$¥￥]?[\d,]+(?:\.\d+)?\))\s*$/u;

export interface ParseTextStatementPdfOptions {
  readonly amountConvention?: AmountConvention;
  /**
   * Pattern with required named groups `date`, `description`, and `amount`.
   * Optional groups: `reference`, `category`, `memo`, `merchantCountry`,
   * `businessPurpose`. Category/purpose captures are source text only and are
   * ignored as owner classifications. This is for a reviewed layout, not OCR.
   */
  readonly rowPattern?: RegExp;
}

export interface ExtractedPdfText {
  readonly text: string;
  readonly lines: readonly string[];
  readonly streamCount: number;
}

export function parseTextStatementPdf(
  bytes: Uint8Array,
  context: ImportContext,
  options: ParseTextStatementPdfOptions = {},
): ParsedTransactionImport {
  if (context.account.collectionMethod !== "statement_import") {
    throw new ValidationError("PDF imports are only allowed for import-configured accounts", {
      accountId: context.account.id,
    });
  }
  const extracted = extractTextFromPdf(bytes);
  const pattern = options.rowPattern ?? DEFAULT_ROW_PATTERN;
  validateRowPattern(pattern);
  const rows: string[][] = [[
    "Date",
    "Description",
    "Amount",
    "Reference",
    "Category",
    "Memo",
    "Country",
    "Business Purpose",
  ]];
  const sourceRowNumbers: number[] = [0];
  let dateLikeLines = 0;
  for (let index = 0; index < extracted.lines.length; index += 1) {
    const line = extracted.lines[index] ?? "";
    if (line.length > 1024 * 1024) throw new ValidationError("PDF contains an oversized extracted text line");
    if (/\d{1,4}[-/'\uFF0F]\d{1,2}/u.test(line)) dateLikeLines += 1;
    const match = executeRowPattern(pattern, line);
    if (match?.groups === undefined) continue;
    rows.push([
      match.groups.date ?? "",
      match.groups.description ?? "",
      match.groups.amount ?? "",
      match.groups.reference ?? "",
      match.groups.category ?? "",
      match.groups.memo ?? "",
      match.groups.merchantCountry ?? "",
      match.groups.businessPurpose ?? "",
    ]);
    sourceRowNumbers.push(index + 1);
  }
  if (rows.length === 1) {
    throw new ValidationError(
      "PDF text was extracted, but no transaction rows matched the configured statement layout",
      { textLines: extracted.lines.length, dateLikeLines },
    );
  }

  const parsed = parseTabularRows(rows, context, {
    format: "pdf",
    sourceFingerprint: fingerprintBytes(bytes),
    inputBytes: bytes.length,
    sourceRowNumbers,
    ...(options.amountConvention === undefined ? {} : { amountConvention: options.amountConvention }),
  });
  return {
    ...parsed,
    metadata: { ...parsed.metadata, pdfTextStreamCount: extracted.streamCount },
    issues: [
      ...parsed.issues,
      {
        severity: "warning",
        code: "PDF_TEXT_LAYOUT_REVIEW_REQUIRED",
        message: "Text-based PDF extraction is layout-sensitive; review every parsed row before import",
      },
      ...(dateLikeLines > parsed.metadata.parsedRows
        ? [{
            severity: "error" as const,
            code: "PDF_UNMATCHED_DATE_LINES",
            message: "Some date-like PDF lines did not match the configured transaction layout; import is blocked so no possible transaction is omitted",
          }]
        : []),
    ],
  };
}

export function extractTextFromPdf(input: Uint8Array): ExtractedPdfText {
  if (input.length === 0 || input.length > MAX_PDF_BYTES) {
    throw new ValidationError("PDF must be non-empty and no larger than 25 MiB", { bytes: input.length });
  }
  const bytes = Buffer.from(input);
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new ValidationError("File is not a PDF document");
  const source = bytes.toString("latin1");
  if (/\/Encrypt\b/u.test(source)) throw new ValidationError("Encrypted or password-protected PDFs are not accepted");

  const streams = readPdfStreams(bytes, source);
  const unicodeMap = buildUnicodeMap(streams);
  const lines: string[] = [];
  for (const stream of streams) {
    const content = stream.toString("latin1");
    if (!/\bBT\b/u.test(content) || !/\bET\b/u.test(content)) continue;
    lines.push(...extractContentStreamLines(content, unicodeMap));
  }
  const cleaned = lines
    .map((line) => line.normalize("NFKC").replace(/[\t ]+/gu, " ").trim())
    .filter((line) => line.length > 0);
  if (cleaned.length === 0) {
    throw new ValidationError("PDF has no extractable text; scanned/image-only PDFs require a reviewed manual workflow");
  }
  return { text: cleaned.join("\n"), lines: cleaned, streamCount: streams.length };
}

function readPdfStreams(bytes: Buffer, source: string): readonly Buffer[] {
  const streams: Buffer[] = [];
  const objectPattern = /\d+\s+\d+\s+obj\b/gu;
  let expandedTotal = 0;
  for (const objectMatch of source.matchAll(objectPattern)) {
    const objectStart = (objectMatch.index ?? 0) + objectMatch[0].length;
    const endObject = source.indexOf("endobj", objectStart);
    if (endObject < 0) continue;
    const streamKeyword = source.indexOf("stream", objectStart);
    if (streamKeyword < 0 || streamKeyword > endObject) continue;
    const dictionary = source.slice(objectStart, streamKeyword);
    if (/\/Subtype\s*\/Image\b/u.test(dictionary)) continue;
    const dataStart = pdfStreamDataStart(source, streamKeyword + 6);
    if (dataStart < 0) continue;
    const directLength = /\/Length\s+(\d+)\s*(?=\/|>>|$)/u.exec(dictionary)?.[1];
    let dataEnd = directLength === undefined ? source.indexOf("endstream", dataStart) : dataStart + Number(directLength);
    if (dataEnd < dataStart || dataEnd > bytes.length) throw new ValidationError("PDF stream length is invalid");
    if (directLength === undefined && dataEnd >= 0) {
      while (dataEnd > dataStart && (bytes[dataEnd - 1] === 0x0a || bytes[dataEnd - 1] === 0x0d)) dataEnd -= 1;
    }
    if (directLength !== undefined) {
      let marker = dataEnd;
      if (source.startsWith("\r\n", marker)) marker += 2;
      else if (source[marker] === "\n" || source[marker] === "\r") marker += 1;
      if (!source.startsWith("endstream", marker)) throw new ValidationError("PDF stream length does not end at endstream");
    }
    const encoded = bytes.subarray(dataStart, dataEnd);
    const filters = parsePdfFilters(dictionary);
    let decoded: Buffer;
    if (filters.length === 0) {
      decoded = Buffer.from(encoded);
    } else if (filters.length === 1 && filters[0] === "FlateDecode") {
      try {
        decoded = inflateSync(encoded, { maxOutputLength: MAX_PDF_STREAM_BYTES });
      } catch (caught) {
        throw new ValidationError("A PDF text stream could not be decompressed", {
          cause: caught instanceof Error ? caught.message : "decompression failed",
        });
      }
    } else {
      continue;
    }
    if (decoded.length > MAX_PDF_STREAM_BYTES) throw new ValidationError("PDF stream exceeds the 25 MiB safety limit");
    expandedTotal += decoded.length;
    if (expandedTotal > MAX_TOTAL_STREAM_BYTES) throw new ValidationError("PDF expanded streams exceed the 50 MiB safety limit");
    streams.push(decoded);
    if (streams.length > MAX_PDF_STREAMS) throw new ValidationError("PDF contains too many streams");
  }
  return streams;
}

function pdfStreamDataStart(source: string, afterKeyword: number): number {
  if (source.startsWith("\r\n", afterKeyword)) return afterKeyword + 2;
  if (source[afterKeyword] === "\n" || source[afterKeyword] === "\r") return afterKeyword + 1;
  return -1;
}

function parsePdfFilters(dictionary: string): readonly string[] {
  const array = /\/Filter\s*\[([^\]]*)\]/u.exec(dictionary)?.[1];
  if (array !== undefined) return [...array.matchAll(/\/([A-Za-z0-9]+)/gu)].map((match) => match[1] ?? "");
  const single = /\/Filter\s*\/([A-Za-z0-9]+)/u.exec(dictionary)?.[1];
  return single === undefined ? [] : [single];
}

function buildUnicodeMap(streams: readonly Buffer[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const stream of streams) {
    const text = stream.toString("latin1");
    if (!/begincmap/u.test(text)) continue;
    for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
      for (const match of (block[1] ?? "").matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu)) {
        const source = (match[1] ?? "").toLocaleUpperCase("en-US");
        const target = match[2] ?? "";
        if (source.length > 0 && source.length % 2 === 0) setUnicodeMapping(result, source, decodeUtf16Hex(target));
      }
    }
    for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
      const body = block[1] ?? "";
      for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu)) {
        addSequentialUnicodeRange(result, match[1] ?? "", match[2] ?? "", match[3] ?? "");
      }
      for (const match of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/gu)) {
        addArrayUnicodeRange(result, match[1] ?? "", match[2] ?? "", match[3] ?? "");
      }
    }
    if (result.size > 1_000_000) throw new ValidationError("PDF Unicode character map is too large");
  }
  return result;
}

function addSequentialUnicodeRange(
  map: Map<string, string>,
  startHex: string,
  endHex: string,
  targetHex: string,
): void {
  const start = Number.parseInt(startHex, 16);
  const end = Number.parseInt(endHex, 16);
  const targetText = decodeUtf16Hex(targetHex);
  const target = targetText.codePointAt(0);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    target === undefined ||
    [...targetText].length !== 1 ||
    end < start ||
    end - start > 4096 ||
    target + end - start > 0x10ffff
  ) return;
  const width = startHex.length;
  for (let value = start; value <= end; value += 1) {
    setUnicodeMapping(
      map,
      value.toString(16).padStart(width, "0").toLocaleUpperCase("en-US"),
      String.fromCodePoint(target + value - start),
    );
  }
}

function addArrayUnicodeRange(
  map: Map<string, string>,
  startHex: string,
  endHex: string,
  targetsSource: string,
): void {
  const start = Number.parseInt(startHex, 16);
  const end = Number.parseInt(endHex, 16);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 4096) return;
  const targets = [...targetsSource.matchAll(/<([0-9A-Fa-f]+)>/gu)].map((match) => decodeUtf16Hex(match[1] ?? ""));
  const width = startHex.length;
  for (let value = start; value <= end && value - start < targets.length; value += 1) {
    setUnicodeMapping(
      map,
      value.toString(16).padStart(width, "0").toLocaleUpperCase("en-US"),
      targets[value - start] ?? "",
    );
  }
}

function setUnicodeMapping(map: Map<string, string>, source: string, target: string): void {
  const existing = map.get(source);
  if (existing !== undefined && existing !== target) {
    throw new ValidationError("PDF contains ambiguous Unicode mappings and cannot be decoded safely", { source });
  }
  map.set(source, target);
}

type PdfOperand =
  | { readonly kind: "bytes"; readonly value: Buffer }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "array"; readonly value: readonly PdfOperand[] }
  | { readonly kind: "word"; readonly value: string };

function extractContentStreamLines(content: string, unicodeMap: ReadonlyMap<string, string>): readonly string[] {
  const tokens = tokenizePdfContent(content);
  const lines: string[] = [];
  let current = "";
  let operands: PdfOperand[] = [];
  let inText = false;
  let previousMatrixY: number | undefined;
  const newline = (): void => {
    if (current.trim().length > 0) lines.push(current);
    current = "";
  };
  for (const token of tokens) {
    if (token.kind !== "word") {
      operands.push(token);
      continue;
    }
    const operator = token.value;
    if (operator === "BT") {
      inText = true;
      newline();
      operands = [];
      previousMatrixY = undefined;
      continue;
    }
    if (operator === "ET") {
      if (inText) newline();
      inText = false;
      operands = [];
      continue;
    }
    if (!inText) {
      operands = [];
      continue;
    }
    if (operator === "Tj") {
      current += decodeOperand(lastOperand(operands), unicodeMap);
    } else if (operator === "TJ") {
      const array = lastOperand(operands);
      if (array?.kind === "array") current += decodeTextArray(array.value, unicodeMap);
    } else if (operator === "'" || operator === '"') {
      newline();
      const text = [...operands].reverse().find((operand) => operand.kind === "bytes");
      current += decodeOperand(text, unicodeMap);
    } else if (operator === "T*" || operator === "Td" || operator === "TD") {
      newline();
    } else if (operator === "Tm") {
      const numbers = operands.filter((operand): operand is Extract<PdfOperand, { kind: "number" }> => operand.kind === "number");
      const nextY = numbers[5]?.value;
      if (previousMatrixY !== undefined && nextY !== undefined && Math.abs(nextY - previousMatrixY) > 0.01) newline();
      previousMatrixY = nextY;
    }
    operands = [];
  }
  newline();
  return lines;
}

function tokenizePdfContent(content: string): readonly PdfOperand[] {
  const tokens: PdfOperand[] = [];
  const arrayStack: PdfOperand[][] = [];
  let index = 0;
  const add = (token: PdfOperand): void => {
    const array = arrayStack[arrayStack.length - 1];
    if (array === undefined) tokens.push(token);
    else array.push(token);
  };
  while (index < content.length) {
    const character = content[index] ?? "";
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "%") {
      const newline = content.indexOf("\n", index + 1);
      index = newline < 0 ? content.length : newline + 1;
      continue;
    }
    if (character === "(") {
      const parsed = readPdfLiteralString(content, index);
      add({ kind: "bytes", value: parsed.bytes });
      index = parsed.next;
      continue;
    }
    if (character === "<" && content[index + 1] !== "<") {
      const parsed = readPdfHexString(content, index);
      add({ kind: "bytes", value: parsed.bytes });
      index = parsed.next;
      continue;
    }
    if (character === "[") {
      arrayStack.push([]);
      index += 1;
      continue;
    }
    if (character === "]") {
      const array = arrayStack.pop();
      if (array === undefined) throw new ValidationError("PDF text stream contains an unmatched array terminator");
      add({ kind: "array", value: array });
      index += 1;
      continue;
    }
    if (content.startsWith("<<", index) || content.startsWith(">>", index)) {
      index += 2;
      continue;
    }
    const end = nextPdfDelimiter(content, index);
    const word = content.slice(index, end);
    const numeric = Number(word);
    add(word.length > 0 && Number.isFinite(numeric)
      ? { kind: "number", value: numeric }
      : { kind: "word", value: word });
    index = Math.max(end, index + 1);
  }
  if (arrayStack.length > 0) throw new ValidationError("PDF text stream contains an unterminated array");
  return tokens;
}

function readPdfLiteralString(content: string, start: number): { readonly bytes: Buffer; readonly next: number } {
  const output: number[] = [];
  let depth = 1;
  let index = start + 1;
  while (index < content.length && depth > 0) {
    const code = content.charCodeAt(index);
    const character = content[index] ?? "";
    if (character === "\\") {
      index += 1;
      const escaped = content[index] ?? "";
      const escapes: Readonly<Record<string, number>> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (escaped === "\r" || escaped === "\n") {
        if (escaped === "\r" && content[index + 1] === "\n") index += 1;
      } else if (/[0-7]/u.test(escaped)) {
        const octal = /^[0-7]{1,3}/u.exec(content.slice(index))?.[0] ?? "0";
        output.push(Number.parseInt(octal, 8) & 0xff);
        index += octal.length - 1;
      } else {
        output.push(escapes[escaped] ?? content.charCodeAt(index) & 0xff);
      }
    } else if (character === "(") {
      depth += 1;
      output.push(code & 0xff);
    } else if (character === ")") {
      depth -= 1;
      if (depth > 0) output.push(code & 0xff);
    } else {
      output.push(code & 0xff);
    }
    index += 1;
    if (output.length > MAX_PDF_STREAM_BYTES) throw new ValidationError("PDF text string exceeds the safety limit");
  }
  if (depth !== 0) throw new ValidationError("PDF text stream contains an unterminated string");
  return { bytes: Buffer.from(output), next: index };
}

function readPdfHexString(content: string, start: number): { readonly bytes: Buffer; readonly next: number } {
  const end = content.indexOf(">", start + 1);
  if (end < 0) throw new ValidationError("PDF text stream contains an unterminated hex string");
  let hex = content.slice(start + 1, end).replace(/\s+/gu, "");
  if (!/^[0-9A-Fa-f]*$/u.test(hex)) throw new ValidationError("PDF text stream contains an invalid hex string");
  if (hex.length % 2 !== 0) hex += "0";
  return { bytes: Buffer.from(hex, "hex"), next: end + 1 };
}

function nextPdfDelimiter(content: string, start: number): number {
  let index = start;
  while (index < content.length && !/[\s()[\]<>%]/u.test(content[index] ?? "")) index += 1;
  return index;
}

function lastOperand(operands: readonly PdfOperand[]): PdfOperand | undefined {
  return operands[operands.length - 1];
}

function decodeOperand(operand: PdfOperand | undefined, unicodeMap: ReadonlyMap<string, string>): string {
  return operand?.kind === "bytes" ? decodePdfBytes(operand.value, unicodeMap) : "";
}

function decodeTextArray(operands: readonly PdfOperand[], unicodeMap: ReadonlyMap<string, string>): string {
  let result = "";
  for (const operand of operands) {
    if (operand.kind === "bytes") result += decodePdfBytes(operand.value, unicodeMap);
    else if (operand.kind === "number" && operand.value < -200 && !result.endsWith(" ")) result += " ";
  }
  return result;
}

function decodePdfBytes(bytes: Buffer, unicodeMap: ReadonlyMap<string, string>): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16Be(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (unicodeMap.size > 0) {
    const widths = [...new Set([...unicodeMap.keys()].map((key) => key.length / 2))].sort((left, right) => right - left);
    let result = "";
    let offset = 0;
    while (offset < bytes.length) {
      let matched = false;
      for (const width of widths) {
        if (offset + width > bytes.length) continue;
        const key = bytes.subarray(offset, offset + width).toString("hex").toLocaleUpperCase("en-US");
        const value = unicodeMap.get(key);
        if (value === undefined) continue;
        result += value;
        offset += width;
        matched = true;
        break;
      }
      if (!matched) {
        result += String.fromCharCode(bytes[offset] ?? 0);
        offset += 1;
      }
    }
    return result;
  }
  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    const zeroHighBytes = bytes.filter((byte, index) => index % 2 === 0 && byte === 0).length;
    if (zeroHighBytes >= bytes.length / 4) return decodeUtf16Be(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function decodeUtf16Hex(hex: string): string {
  if (hex.length % 4 !== 0 || !/^[0-9A-Fa-f]*$/u.test(hex)) return "";
  return decodeUtf16Be(Buffer.from(hex, "hex"));
}

function decodeUtf16Be(bytes: Buffer): string {
  if (bytes.length % 2 !== 0) throw new ValidationError("PDF contains malformed UTF-16 text");
  const swapped = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

function validateRowPattern(pattern: RegExp): void {
  const probe = executeRowPattern(pattern, "2000/01/01 Example 1");
  const source = pattern.source;
  for (const name of ["date", "description", "amount"]) {
    if (!source.includes(`?<${name}>`) && probe?.groups?.[name] === undefined) {
      throw new ValidationError(`PDF row pattern must define a '${name}' named capture group`);
    }
  }
}

function executeRowPattern(pattern: RegExp, value: string): RegExpExecArray | null {
  const flags = pattern.flags.replace(/[gy]/gu, "");
  return new RegExp(pattern.source, flags).exec(value);
}
