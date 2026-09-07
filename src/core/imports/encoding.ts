import iconv from "iconv-lite";

import { ValidationError } from "../errors";
import type { ImportEncoding, ImportEncodingPreference } from "./types";

export const MAX_TEXT_IMPORT_BYTES = 25 * 1024 * 1024;

export interface DecodedImportText {
  readonly text: string;
  readonly encoding: ImportEncoding;
  readonly hadBom: boolean;
}

export function decodeImportText(
  bytes: Uint8Array,
  preference: ImportEncodingPreference = "auto",
): DecodedImportText {
  assertTextImportSize(bytes);
  if (containsNul(bytes)) {
    throw new ValidationError("Statement text contains NUL bytes and appears to be binary data");
  }

  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const payload = hasUtf8Bom ? bytes.subarray(3) : bytes;
  if (preference === "utf8" || preference === "auto") {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      validateDecodedText(text);
      return { text, encoding: "utf8", hadBom: hasUtf8Bom };
    } catch (caught) {
      if (preference === "utf8" || hasUtf8Bom) {
        throw new ValidationError("Statement is not valid UTF-8 text", {
          cause: caught instanceof Error ? caught.message : "invalid byte sequence",
        });
      }
    }
  }

  const candidates: readonly ImportEncoding[] = preference === "auto" ? ["cp932", "shift_jis"] : [preference];
  for (const encoding of candidates) {
    const codec = encoding === "cp932" ? "cp932" : "shift_jis";
    const decoded = iconv.decode(Buffer.from(payload), codec);
    if (!roundTrips(payload, decoded, codec)) continue;
    try {
      validateDecodedText(decoded);
      return { text: decoded, encoding, hadBom: false };
    } catch {
      // Try the next explicitly supported Japanese encoding.
    }
  }

  throw new ValidationError("Statement encoding is invalid or unsupported", {
    supportedEncodings: ["UTF-8", "Shift-JIS", "CP932"],
  });
}

function assertTextImportSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new ValidationError("Statement file is empty");
  if (bytes.length > MAX_TEXT_IMPORT_BYTES) {
    throw new ValidationError("Statement text exceeds the 25 MiB safety limit", { bytes: bytes.length });
  }
}

function containsNul(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte === 0) return true;
  return false;
}

function roundTrips(bytes: Uint8Array, decoded: string, encoding: string): boolean {
  const encoded = iconv.encode(decoded, encoding);
  return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index]);
}

function validateDecodedText(text: string): void {
  if (text.includes("\uFFFD")) throw new ValidationError("Statement contains undecodable characters");
  let suspiciousControls = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && character !== "\r" && character !== "\n" && character !== "\t") {
      suspiciousControls += 1;
    }
  }
  if (suspiciousControls > 0) {
    throw new ValidationError("Statement contains unsupported control characters", { suspiciousControls });
  }
}
