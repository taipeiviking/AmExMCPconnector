import {
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";

import { StorageError } from "./storage-error";

const MAGIC = Buffer.from("ALFCDBE1", "ascii");
const FORMAT_VERSION = 1;
const CIPHER_AES_256_GCM = 1;
const FIXED_HEADER_BYTES = 26;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PROTECTOR_ID_BYTES = 128;
const MAX_PROTECTED_KEY_BYTES = 1024 * 1024;

export interface ParsedEncryptedEnvelope {
  readonly protectorId: string;
  /** Caller owns this buffer and must zero it after transferring ownership. */
  readonly dataKey: Uint8Array;
  readonly plaintext: Uint8Array;
}

export function encryptDatabaseEnvelope(input: {
  plaintext: Uint8Array;
  dataKey: Uint8Array;
  protectorId: string;
  protectedKey: Uint8Array;
  iv: Uint8Array;
}): Uint8Array {
  assertKey(input.dataKey);
  if (input.iv.byteLength !== IV_BYTES) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      `AES-GCM IVs must be exactly ${IV_BYTES} bytes.`,
    );
  }

  const protectorId = Buffer.from(input.protectorId, "utf8");
  if (
    protectorId.byteLength === 0 ||
    protectorId.byteLength > MAX_PROTECTOR_ID_BYTES
  ) {
    throw new StorageError(
      "INVALID_CONFIGURATION",
      "The KeyProtector id is empty or too long for the encrypted file format.",
    );
  }
  if (
    input.protectedKey.byteLength === 0 ||
    input.protectedKey.byteLength > MAX_PROTECTED_KEY_BYTES
  ) {
    throw new StorageError(
      "KEY_PROTECTION_UNAVAILABLE",
      "The protected database key is empty or exceeds the safe envelope limit.",
    );
  }

  const fixedHeader = Buffer.alloc(FIXED_HEADER_BYTES);
  MAGIC.copy(fixedHeader, 0);
  fixedHeader.writeUInt8(FORMAT_VERSION, 8);
  fixedHeader.writeUInt8(CIPHER_AES_256_GCM, 9);
  fixedHeader.writeUInt16BE(protectorId.byteLength, 10);
  fixedHeader.writeUInt32BE(input.protectedKey.byteLength, 12);
  fixedHeader.writeUInt8(IV_BYTES, 16);
  fixedHeader.writeUInt8(AUTH_TAG_BYTES, 17);
  fixedHeader.writeBigUInt64BE(BigInt(input.plaintext.byteLength), 18);

  const authenticatedPrefix = Buffer.concat([
    fixedHeader,
    protectorId,
    Buffer.from(input.protectedKey),
    Buffer.from(input.iv),
  ]);

  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(input.dataKey),
    Buffer.from(input.iv),
    { authTagLength: AUTH_TAG_BYTES },
  );
  cipher.setAAD(authenticatedPrefix);
  const ciphertext = Buffer.concat([
    cipher.update(input.plaintext),
    cipher.final(),
  ]);
  const authenticationTag = cipher.getAuthTag();

  return Buffer.concat([authenticatedPrefix, ciphertext, authenticationTag]);
}

export function decryptDatabaseEnvelope(
  envelope: Uint8Array,
  expectedProtectorId: string,
  unwrapKey: (protectedKey: Uint8Array) => Promise<Uint8Array>,
): Promise<ParsedEncryptedEnvelope> {
  return decryptDatabaseEnvelopeInternal(
    Buffer.from(envelope.buffer, envelope.byteOffset, envelope.byteLength),
    expectedProtectorId,
    unwrapKey,
  );
}

async function decryptDatabaseEnvelopeInternal(
  envelope: Buffer,
  expectedProtectorId: string,
  unwrapKey: (protectedKey: Uint8Array) => Promise<Uint8Array>,
): Promise<ParsedEncryptedEnvelope> {
  const parsed = parseEnvelope(envelope);
  if (parsed.protectorId !== expectedProtectorId) {
    throw new StorageError(
      "KEY_PROTECTOR_MISMATCH",
      `The database requires KeyProtector '${parsed.protectorId}', but '${expectedProtectorId}' was supplied.`,
    );
  }

  let unwrappedKey: Uint8Array | undefined;
  try {
    unwrappedKey = await unwrapKey(Buffer.from(parsed.protectedKey));
    assertKey(unwrappedKey);
  } catch (error) {
    unwrappedKey?.fill(0);
    throw new StorageError(
      "DECRYPTION_FAILED",
      "The database key could not be unlocked. The file was not opened.",
      error,
    );
  }

  // The length assertion above also proves assignment for runtime purposes.
  if (unwrappedKey === undefined) {
    throw new StorageError(
      "DECRYPTION_FAILED",
      "The database key could not be unlocked. The file was not opened.",
    );
  }
  const dataKey = Buffer.from(unwrappedKey);
  unwrappedKey.fill(0);

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      dataKey,
      parsed.iv,
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(parsed.authenticatedPrefix);
    decipher.setAuthTag(parsed.authenticationTag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);

    return { dataKey, plaintext, protectorId: parsed.protectorId };
  } catch (error) {
    dataKey.fill(0);
    throw new StorageError(
      "DECRYPTION_FAILED",
      "Database authentication failed. The file may be corrupt, tampered with, or protected by a different OS user.",
      error,
    );
  }
}

interface ParsedEnvelopeParts {
  readonly protectorId: string;
  readonly protectedKey: Buffer;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authenticationTag: Buffer;
  readonly authenticatedPrefix: Buffer;
}

function parseEnvelope(envelope: Buffer): ParsedEnvelopeParts {
  if (envelope.byteLength < FIXED_HEADER_BYTES + IV_BYTES + AUTH_TAG_BYTES) {
    throw invalidEnvelope();
  }
  if (!timingSafeEqual(envelope.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw invalidEnvelope();
  }
  if (
    envelope.readUInt8(8) !== FORMAT_VERSION ||
    envelope.readUInt8(9) !== CIPHER_AES_256_GCM
  ) {
    throw new StorageError(
      "INVALID_DATABASE_FILE",
      "The encrypted database format or cipher version is unsupported.",
    );
  }

  const protectorIdLength = envelope.readUInt16BE(10);
  const protectedKeyLength = envelope.readUInt32BE(12);
  const ivLength = envelope.readUInt8(16);
  const tagLength = envelope.readUInt8(17);
  const ciphertextLengthBigInt = envelope.readBigUInt64BE(18);

  if (
    protectorIdLength === 0 ||
    protectorIdLength > MAX_PROTECTOR_ID_BYTES ||
    protectedKeyLength === 0 ||
    protectedKeyLength > MAX_PROTECTED_KEY_BYTES ||
    ivLength !== IV_BYTES ||
    tagLength !== AUTH_TAG_BYTES ||
    ciphertextLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw invalidEnvelope();
  }

  const ciphertextLength = Number(ciphertextLengthBigInt);
  const prefixLength =
    FIXED_HEADER_BYTES + protectorIdLength + protectedKeyLength + ivLength;
  const expectedLength = prefixLength + ciphertextLength + tagLength;
  if (expectedLength !== envelope.byteLength) {
    throw invalidEnvelope();
  }

  const protectorStart = FIXED_HEADER_BYTES;
  const protectedKeyStart = protectorStart + protectorIdLength;
  const ivStart = protectedKeyStart + protectedKeyLength;
  const ciphertextStart = ivStart + ivLength;
  const tagStart = ciphertextStart + ciphertextLength;
  const protectorId = envelope
    .subarray(protectorStart, protectedKeyStart)
    .toString("utf8");

  if (Buffer.from(protectorId, "utf8").byteLength !== protectorIdLength) {
    throw invalidEnvelope();
  }

  return {
    authenticationTag: envelope.subarray(tagStart, expectedLength),
    authenticatedPrefix: envelope.subarray(0, ciphertextStart),
    ciphertext: envelope.subarray(ciphertextStart, tagStart),
    iv: envelope.subarray(ivStart, ciphertextStart),
    protectedKey: envelope.subarray(protectedKeyStart, ivStart),
    protectorId,
  };
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new StorageError(
      "DECRYPTION_FAILED",
      `Database data-encryption keys must be exactly ${KEY_BYTES} bytes.`,
    );
  }
}

function invalidEnvelope(): StorageError {
  return new StorageError(
    "INVALID_DATABASE_FILE",
    "The file is not a valid encrypted database envelope.",
  );
}
