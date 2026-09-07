import { describe, expect, it } from "vitest";
import { packagedSmokeExitDelay, startupFailureDetail } from "../../src/main/startup-policy";

describe("startup policy", () => {
  it("never reflects exception detail in a packaged startup error", () => {
    const detail = startupFailureDetail(true, new Error("secret-token at C:\\sensitive\\ledger.db.enc"));
    expect(detail).not.toContain("secret-token");
    expect(detail).not.toContain("sensitive");
    expect(detail).toContain("could not start safely");
  });

  it("includes useful exception detail only for development", () => {
    expect(startupFailureDetail(false, new Error("test failure"))).toContain("Development detail: test failure");
  });

  it("accepts only bounded packaged smoke exit delays", () => {
    expect(packagedSmokeExitDelay(["app.exe", "--amex-packaged-smoke-exit-after-ms=15000"], true)).toBe(15_000);
    expect(packagedSmokeExitDelay(["app.exe", "--amex-packaged-smoke-exit-after-ms=4999"], true)).toBeUndefined();
    expect(packagedSmokeExitDelay(["app.exe", "--amex-packaged-smoke-exit-after-ms=15000"], false)).toBeUndefined();
  });
});
