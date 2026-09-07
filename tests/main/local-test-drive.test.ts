import { describe, expect, it } from "vitest";
import { runLocalTestDrive } from "../../src/main/local-test-drive";

describe("non-technical local test drive", () => {
  it("passes only when the local boundary and all synthetic finance workflows pass", () => {
    const result = runLocalTestDrive({
      storageState: "unlocked",
      mcpMode: "local",
      mcpState: "running",
      mcpExposure: "loopback-only",
      toolCount: 7
    });
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(7);
    expect(result.checks.find((check) => check.id === "import")).toMatchObject({ passed: true });
    expect(result.checks.find((check) => check.id === "reconciliation")).toMatchObject({ passed: true });
    expect(result.checks.find((check) => check.id === "alerts")).toMatchObject({ passed: true });
    expect(result.checks.find((check) => check.id === "exports")).toMatchObject({ passed: true });
  });

  it("reports a stopped MCP endpoint without writing or broadening access", () => {
    const result = runLocalTestDrive({
      storageState: "unlocked",
      mcpMode: "local",
      mcpState: "stopped",
      mcpExposure: "loopback-only",
      toolCount: 7
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "loopback")).toMatchObject({ passed: false });
  });

  it("accepts the packaged local-only posture only when no MCP listener is running", () => {
    const result = runLocalTestDrive({
      storageState: "unlocked",
      mcpMode: "disabled",
      mcpState: "stopped",
      mcpExposure: "loopback-only",
      toolCount: 7
    });
    expect(result.passed).toBe(true);
    expect(result.checks.find((check) => check.id === "loopback")?.detail).toMatch(/no listener is open/u);
  });
});
