import { describe, expect, it } from "vitest";
import { environmentForRuntime, loadConfiguration } from "../../src/config/environment";

const baseEnvironment: NodeJS.ProcessEnv = {
  LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"
};

describe("loadConfiguration", () => {
  it("forces packaged binaries through production security invariants", () => {
    const packaged = environmentForRuntime(
      { AMEX_APP_ENV: "development", AMEX_DEMO_MODE: "true", LOCALAPPDATA: "C:\\runtime" },
      true
    );
    expect(packaged.AMEX_APP_ENV).toBe("production");
    expect(() => loadConfiguration({ environment: packaged })).toThrow(/Demo data is forbidden in production/u);

    const development = environmentForRuntime({ AMEX_APP_ENV: "test" }, false);
    expect(development.AMEX_APP_ENV).toBe("test");
  });

  it("uses a loopback-only local configuration by default", () => {
    const configuration = loadConfiguration({ environment: baseEnvironment });

    expect(configuration.mcp.host).toBe("127.0.0.1");
    expect(configuration.mcp.mode).toBe("local");
    expect(configuration.telemetryEnabled).toBe(false);
    expect(configuration.storage.databasePath).toContain("AmexLocalFinanceConnector");
  });

  it("parses false-like strings without treating them as truthy", () => {
    const configuration = loadConfiguration({
      environment: { ...baseEnvironment, AMEX_DEMO_MODE: "false", AMEX_START_MINIMIZED: "0" }
    });

    expect(configuration.demoMode).toBe(false);
    expect(configuration.startMinimized).toBe(false);
  });

  it("requires a token reference for bearer mode", () => {
    expect(() =>
      loadConfiguration({
        environment: { ...baseEnvironment, AMEX_MCP_AUTH_MODE: "bearer", AMEX_MCP_BEARER_TOKEN_REF: "" }
      })
    ).toThrow(/TOKEN_REF/);
  });

  it.each([
    ["AMEX_DATABASE_FILE", "..\\outside.db.enc"],
    ["AMEX_IMPORT_STAGING_DIR", "C:\\outside\\imports"],
    ["AMEX_EXPORT_DIR", "..\\..\\cloud-exports"],
    ["AMEX_LOG_DIR", "C:\\outside\\logs"]
  ])("rejects %s paths that escape the protected data directory", (variable, value) => {
    expect(() => loadConfiguration({ environment: { ...baseEnvironment, [variable]: value } })).toThrow(
      /inside AMEX_DATA_DIR/u
    );
  });

  it("rejects security policy bypasses in production", () => {
    expect(() =>
      loadConfiguration({
        environment: { ...baseEnvironment, AMEX_APP_ENV: "production", AMEX_DEMO_MODE: "true" }
      })
    ).toThrow(/Demo data/);

    expect(() =>
      loadConfiguration({
        environment: {
          ...baseEnvironment,
          AMEX_APP_ENV: "production",
          AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL: "false"
        }
      })
    ).toThrow(/approval/);
  });

  it("requires conditional tunnel and provider settings", () => {
    expect(() =>
      loadConfiguration({ environment: { ...baseEnvironment, OPENAI_TUNNEL_ENABLED: "true" } })
    ).toThrow(/TUNNEL_ID/);

    expect(() =>
      loadConfiguration({ environment: { ...baseEnvironment, AMEX_US_AGGREGATOR: "approved-provider" } })
    ).toThrow(/aggregation/);
  });
});
