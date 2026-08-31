import { describe, expect, it } from "vitest";
import { runLocalTestDrive } from "../../src/main/local-test-drive";

describe("non-technical local test drive", () => {
  it("passes only with encrypted storage, loopback MCP, seven tools, and the synthetic import dry-run", () => {
    const result = runLocalTestDrive({
      storageState: "unlocked",
      mcpState: "running",
      mcpExposure: "loopback-only",
      toolCount: 7
    });
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.find((check) => check.id === "import")).toMatchObject({ passed: true });
  });

  it("reports a stopped MCP endpoint without writing or broadening access", () => {
    const result = runLocalTestDrive({
      storageState: "unlocked",
      mcpState: "stopped",
      mcpExposure: "loopback-only",
      toolCount: 7
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "loopback")).toMatchObject({ passed: false });
  });
});
