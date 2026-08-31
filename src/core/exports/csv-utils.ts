import iconv from "iconv-lite";

import { ValidationError } from "../errors";
import type { TextExportEncoding } from "./types";

export function csvRow(values: readonly (string | number)[]): string {
  return values.map((value) => csvCell(String(value))).join(",");
}

export function safeTextCell(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  return /^[=+\-@\t\r]/u.test(normalized) ? `'${normalized}` : normalized;
}

export function csvCell(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export function encodeText(text: string, encoding: TextExportEncoding): {
  readonly bytes: Uint8Array;
  readonly lossy: boolean;
} {
  if (encoding === "utf8_bom") {
    return { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]), lossy: false };
  }
  const bytes = iconv.encode(text, "shift_jis");
  const decoded = iconv.decode(bytes, "shift_jis");
  if (decoded !== text) {
    bytes.fill(0);
    const mismatchIndex = firstMismatchIndex(text, decoded);
    throw new ValidationError("Shift-JIS export contains text that cannot be represented losslessly", {
      mismatchIndex,
    });
  }
  return { bytes, lossy: false };
}

export function fileSafe(value: string): string {
  const safe = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/gu, "_").replace(/^\.+/u, "").slice(0, 80);
  return safe.length === 0 ? "account" : safe;
}

function firstMismatchIndex(left: string, right: string): number {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  const length = Math.max(leftCharacters.length, rightCharacters.length);
  for (let index = 0; index < length; index += 1) {
    if (leftCharacters[index] !== rightCharacters[index]) return index;
  }
  return -1;
}
