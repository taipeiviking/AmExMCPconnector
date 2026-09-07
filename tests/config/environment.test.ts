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
    expect(packaged.AMEX_MCP_MODE).toBe("disabled");
    expect(packaged.AMEX_SCREENSHOT_PROTECTION).toBe("true");
    expect(() => loadConfiguration({ environment: packaged })).toThrow(/Demo data is forbidden in production/u);

    const packagedScreenshotOverride = environmentForRuntime(
      { AMEX_SCREENSHOT_PROTECTION: "false", LOCALAPPDATA: "C:\\runtime" },
      true
    );
    expect(loadConfiguration({ environment: packagedScreenshotOverride }).screenshotProtection).toBe(true);

    const development = environmentForRuntime({ AMEX_APP_ENV: "test" }, false);
    expect(development.AMEX_APP_ENV).toBe("test");
  });

  it("uses a loopback-only local configuration by default", () => {
    const configuration = loadConfiguration({ environment: baseEnvironment });

    expect(configuration.mcp.host).toBe("127.0.0.1");
    expect(configuration.mcp.mode).toBe("local");
    expect(configuration.screenshotProtection).toBe(true);
    expect(configuration.telemetryEnabled).toBe(false);
    expect(configuration.storage.databasePath).toContain("AmexLocalFinanceConnector");
  });

  it("allows screenshot capture only through an explicit non-production opt-in", () => {
    const development = loadConfiguration({
      environment: { ...baseEnvironment, AMEX_APP_ENV: "development", AMEX_SCREENSHOT_PROTECTION: "false" }
    });
    const test = loadConfiguration({
      environment: { ...baseEnvironment, AMEX_APP_ENV: "test", AMEX_SCREENSHOT_PROTECTION: "false" }
    });

    expect(development.screenshotProtection).toBe(false);
    expect(test.screenshotProtection).toBe(false);
    expect(() =>
      loadConfiguration({
        environment: { ...baseEnvironment, AMEX_APP_ENV: "production", AMEX_SCREENSHOT_PROTECTION: "false" }
      })
    ).toThrow(/Screenshot protection cannot be disabled in production/u);
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

  it("allows the MCP page cap to narrow but not broaden the 200-row tool contract", () => {
    expect(loadConfiguration({
      environment: { ...baseEnvironment, AMEX_MCP_MAX_PAGE_SIZE: "25" }
    }).mcp.maxPageSize).toBe(25);
    expect(() => loadConfiguration({
      environment: { ...baseEnvironment, AMEX_MCP_MAX_PAGE_SIZE: "201" }
    })).toThrow();
  });

  it("requires an absolute category mapping path", () => {
    expect(() => loadConfiguration({
      environment: { ...baseEnvironment, AMEX_CATEGORY_MAPPING_FILE: ".\\categories.json" }
    })).toThrow(/absolute local path/u);
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

    expect(() =>
      loadConfiguration({
        environment: {
          ...baseEnvironment,
          AMEX_APP_ENV: "production",
          AMEX_MCP_MODE: "local",
          AMEX_MCP_AUTH_MODE: "loopback-only"
        }
      })
    ).toThrow(/requires bearer authentication/u);

    expect(() =>
      loadConfiguration({
        environment: {
          ...baseEnvironment,
          AMEX_APP_ENV: "production",
          AMEX_MCP_MODE: "disabled",
          AMEX_MCP_AUTH_MODE: "loopback-only"
        }
      })
    ).not.toThrow();
  });

  it("requires conditional tunnel and provider settings", () => {
    expect(() =>
      loadConfiguration({
        environment: {
          ...baseEnvironment,
          AMEX_MCP_MODE: "tunnel",
          AMEX_MCP_AUTH_MODE: "bearer",
          AMEX_MCP_BEARER_TOKEN_REF: "wincred:AmexLocalFinanceConnector/McpBearerToken",
          OPENAI_TUNNEL_ENABLED: "true",
          OPENAI_TUNNEL_CLIENT_PATH: "C:\\Program Files\\ApprovedTunnel\\tunnel.exe",
          OPENAI_TUNNEL_CLIENT_SHA256: "a".repeat(64),
          OPENAI_TUNNEL_ARGUMENTS_JSON: '["--url={localMcpEndpoint}"]'
        }
      })
    ).toThrow(/TUNNEL_ID/);

    expect(() =>
      loadConfiguration({ environment: { ...baseEnvironment, AMEX_US_AGGREGATOR: "approved-provider-generic" } })
    ).toThrow(/aggregation/);
  });

  it("never exposes a tunneled loopback endpoint without bearer authentication", () => {
    const tunnelBase: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      OPENAI_TUNNEL_ENABLED: "true",
      OPENAI_TUNNEL_ID: "owner-tunnel",
      OPENAI_TUNNEL_CLIENT_PATH: "C:\\Program Files\\ApprovedTunnel\\tunnel.exe",
      OPENAI_TUNNEL_CLIENT_SHA256: "a".repeat(64),
      OPENAI_TUNNEL_ARGUMENTS_JSON: '["--url={localMcpEndpoint}"]'
    };

    expect(() => loadConfiguration({ environment: tunnelBase })).toThrow(/MCP_MODE must be tunnel/u);
    expect(() =>
      loadConfiguration({ environment: { ...tunnelBase, AMEX_MCP_MODE: "tunnel" } })
    ).toThrow(/bearer authentication/u);
    expect(() =>
      loadConfiguration({
        environment: {
          ...tunnelBase,
          AMEX_MCP_MODE: "tunnel",
          AMEX_MCP_AUTH_MODE: "bearer",
          AMEX_MCP_BEARER_TOKEN_REF: "wincred:AmexLocalFinanceConnector/McpBearerToken"
        }
      })
    ).not.toThrow();
  });

  it("rejects contradictory tunnel mode and auto-start settings", () => {
    expect(() =>
      loadConfiguration({ environment: { ...baseEnvironment, AMEX_MCP_MODE: "tunnel" } })
    ).toThrow(/OPENAI_TUNNEL_ENABLED must be true/u);
    expect(() =>
      loadConfiguration({ environment: { ...baseEnvironment, OPENAI_TUNNEL_AUTO_START: "true" } })
    ).toThrow(/auto-start.*disabled/u);
  });
});
