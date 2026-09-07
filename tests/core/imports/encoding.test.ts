import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";

import { decodeImportText, ValidationError } from "../../../src/core";

describe("statement text encoding", () => {
  it("detects UTF-8 with BOM and strips the marker", () => {
    const decoded = decodeImportText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("利用日", "utf8")]));
    expect(decoded).toEqual({ text: "利用日", encoding: "utf8", hadBom: true });
  });

  it("detects a round-trippable CP932 Japanese export", () => {
    const decoded = decodeImportText(iconv.encode("利用日,店舗\r\n", "cp932"));
    expect(decoded.encoding).toBe("cp932");
    expect(decoded.text).toContain("店舗");
  });

  it("rejects mismatched explicit UTF-8 and binary input", () => {
    expect(() => decodeImportText(iconv.encode("店舗", "cp932"), "utf8")).toThrow(ValidationError);
    expect(() => decodeImportText(Buffer.from([0x41, 0, 0x42]))).toThrow(/binary/iu);
  });
});
