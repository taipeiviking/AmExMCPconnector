import { isAbsolute, relative, resolve, sep } from "node:path";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const booleanValue = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional()
);

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonNegativeInteger = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

const environmentSchema = z.object({
  AMEX_APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  AMEX_LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  AMEX_START_MINIMIZED: booleanValue.default(false),
  AMEX_START_WITH_WINDOWS: booleanValue.default(false),
  AMEX_TIMEZONE: z.string().trim().min(1).default("UTC"),
  AMEX_TELEMETRY_ENABLED: booleanValue.default(false),
  AMEX_CRASH_REPORTING_ENABLED: booleanValue.default(false),
  AMEX_SCREENSHOT_PROTECTION: booleanValue.default(true),
  AMEX_DEMO_MODE: booleanValue.default(false),

  AMEX_DATA_DIR: optionalString,
  AMEX_DATABASE_FILE: z.string().trim().min(1).default("ledger.db.enc"),
  AMEX_IMPORT_STAGING_DIR: z.string().trim().min(1).default("imports"),
  AMEX_EXPORT_DIR: z.string().trim().min(1).default("exports"),
  AMEX_LOG_DIR: z.string().trim().min(1).default("logs"),
  AMEX_DATABASE_AUTO_LOCK_MINUTES: nonNegativeInteger(15),
  AMEX_LOG_RETENTION_DAYS: positiveInteger(90),
  AMEX_AUDIT_RETENTION_DAYS: positiveInteger(2555),

  AMEX_MCP_MODE: z.enum(["disabled", "local", "tunnel"]).default("local"),
  AMEX_MCP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  AMEX_MCP_PORT: z.coerce.number().int().min(1024).max(65535).default(43121),
  AMEX_MCP_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default("/mcp"),
  AMEX_MCP_AUTH_MODE: z.enum(["loopback-only", "bearer"]).default("loopback-only"),
  AMEX_MCP_BEARER_TOKEN_REF: optionalString,
  AMEX_MCP_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(200),
  AMEX_MCP_REQUEST_TIMEOUT_MS: positiveInteger(30_000),
  AMEX_MCP_RATE_LIMIT_PER_MINUTE: positiveInteger(120),

  OPENAI_TUNNEL_ENABLED: booleanValue.default(false),
  OPENAI_TUNNEL_AUTO_START: booleanValue.default(false),
  OPENAI_TUNNEL_CLIENT_PATH: optionalString,
  OPENAI_TUNNEL_CLIENT_SHA256: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().regex(/^[A-Fa-f0-9]{64}$/).optional()
  ),
  OPENAI_TUNNEL_ARGUMENTS_JSON: z.string().trim().min(2).default("[]"),
  OPENAI_TUNNEL_PROFILE: z.string().trim().min(1).default("amex-local"),
  OPENAI_TUNNEL_ID: optionalString,

  AMEX_US_AGGREGATOR: z.enum(["disabled", "plaid", "approved-provider-generic"]).default("plaid"),
  AMEX_US_AGGREGATOR_ENVIRONMENT: z.enum(["sandbox", "production"]).default("sandbox"),
  AMEX_US_AGGREGATOR_BASE_URL: optionalString,
  AMEX_US_AGGREGATOR_CLIENT_ID_REF: optionalString.default(
    "wincred:AmexLocalFinanceConnector%2FPlaid%2FClientId"
  ),
  AMEX_US_AGGREGATOR_CLIENT_SECRET_REF: optionalString.default(
    "wincred:AmexLocalFinanceConnector%2FPlaid%2FSecret"
  ),
  AMEX_US_PLAID_REDIRECT_URI: optionalString,
  AMEX_US_OAUTH_AUTHORIZATION_URL: optionalString,
  AMEX_US_OAUTH_TOKEN_URL: optionalString,
  AMEX_US_OAUTH_REVOCATION_URL: optionalString,
  AMEX_US_AGGREGATOR_REDIRECT_URI: z.string().url().default("http://127.0.0.1:43122/oauth/callback"),
  AMEX_US_AGGREGATOR_SCOPES: z.string().default("accounts,transactions,statements"),
  AMEX_US_PROVIDER_RESPONSE_PROFILE: z.enum(["normalized_v1"]).default("normalized_v1"),
  AMEX_US_API_ACCOUNTS_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default("/v1/accounts"),
  AMEX_US_API_ACCOUNT_STATUS_PATH: z.string().regex(/^\/[A-Za-z0-9/{}_-]*$/).default("/v1/accounts/{providerAccountId}"),
  AMEX_US_API_TRANSACTIONS_PATH: z.string().regex(/^\/[A-Za-z0-9/{}_-]*$/).default("/v1/accounts/{providerAccountId}/transactions"),
  AMEX_US_API_STATEMENTS_PATH: z.string().regex(/^\/[A-Za-z0-9/{}_-]*$/).default("/v1/accounts/{providerAccountId}/statements"),
  AMEX_US_API_STATEMENT_PATH: z.string().regex(/^\/[A-Za-z0-9/{}_-]*$/).default("/v1/accounts/{providerAccountId}/statements/{providerStatementId}"),
  AMEX_US_PROVIDER_MAX_RESPONSE_MB: positiveInteger(10),
  AMEX_US_OAUTH_CALLBACK_PORT: z.coerce.number().int().min(1024).max(65535).default(43122),
  AMEX_US_SYNC_INTERVAL_MINUTES: positiveInteger(360),
  AMEX_US_SYNC_LOOKBACK_DAYS: positiveInteger(730),
  AMEX_US_TOKEN_REFRESH_SKEW_SECONDS: nonNegativeInteger(300),

  // The strictest supported parser source limit is 25 MiB. Keeping selection
  // at the same ceiling avoids accepting a file that must fail at preview.
  AMEX_JP_IMPORT_MAX_MB: z.coerce.number().int().min(1).max(25).default(25),
  AMEX_JP_ALLOWED_EXTENSIONS: z.string().default(".csv,.xlsx,.qif,.pdf"),
  AMEX_JP_CSV_ENCODINGS: z.string().default("utf-8,shift_jis,cp932"),
  AMEX_IMPORT_QUARANTINE_ENABLED: booleanValue.default(true),
  AMEX_IMPORT_DUPLICATE_WINDOW_DAYS: nonNegativeInteger(7),
  AMEX_PDF_OCR_ENABLED: booleanValue.default(false),
  AMEX_PDF_OCR_ENGINE_PATH: optionalString,

  AMEX_DEFAULT_PORTFOLIO_ID: z.string().trim().min(1).default("owner-main"),
  AMEX_BASE_CURRENCY: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  AMEX_FX_RATE_SOURCE: z.enum(["manual", "provider"]).default("manual"),
  AMEX_FX_PROVIDER_BASE_URL: optionalString,
  AMEX_FX_PROVIDER_API_KEY_REF: optionalString,
  AMEX_FX_STALE_AFTER_HOURS: positiveInteger(24),
  AMEX_RECONCILIATION_TOLERANCE_MINOR_UNITS: nonNegativeInteger(1),
  AMEX_CATEGORY_MAPPING_FILE: optionalString,

  AMEX_ALERTS_ENABLED: booleanValue.default(true),
  AMEX_ALERT_LOOKBACK_DAYS: positiveInteger(90),
  AMEX_ALERT_AMOUNT_ZSCORE: z.coerce.number().positive().default(3),
  AMEX_ALERT_NEW_MERCHANT_DAYS: positiveInteger(180),
  AMEX_ALERT_HIGH_VALUE_USD: z.coerce.number().positive().default(1000),
  AMEX_ALERT_HIGH_VALUE_JPY: z.coerce.number().positive().default(150000),

  AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL: booleanValue.default(true),
  AMEX_EXPORT_DUPLICATE_WINDOW_DAYS: nonNegativeInteger(365),
  AMEX_EXPORT_RETENTION_DAYS: positiveInteger(30),
  AMEX_QBO_DEFAULT_FORMAT: z.enum(["csv", "qbo", "qfx"]).default("csv"),
  AMEX_MONEY_FORWARD_ENCODING: z.enum(["utf-8", "shift_jis"]).default("shift_jis"),
  AMEX_MONEY_FORWARD_LINE_ENDING: z.enum(["lf", "crlf"]).default("crlf")
});

/** Canonical public configuration contract used to keep the safe template and
 * documentation complete as settings evolve. */
export const ENVIRONMENT_VARIABLE_NAMES = Object.freeze(Object.keys(environmentSchema.shape).sort());

export type RawEnvironment = z.infer<typeof environmentSchema>;

export interface AppConfiguration {
  environment: "development" | "production" | "test";
  logLevel: RawEnvironment["AMEX_LOG_LEVEL"];
  startMinimized: boolean;
  startWithWindows: boolean;
  timezone: string;
  telemetryEnabled: boolean;
  crashReportingEnabled: boolean;
  screenshotProtection: boolean;
  demoMode: boolean;
  storage: {
    dataDirectory: string;
    databasePath: string;
    importDirectory: string;
    exportDirectory: string;
    logDirectory: string;
    autoLockMinutes: number;
  };
  mcp: {
    mode: RawEnvironment["AMEX_MCP_MODE"];
    host: "127.0.0.1";
    port: number;
    path: string;
    authMode: RawEnvironment["AMEX_MCP_AUTH_MODE"];
    bearerTokenReference?: string;
    maxPageSize: number;
    requestTimeoutMs: number;
    rateLimitPerMinute: number;
  };
  tunnel: {
    enabled: boolean;
    autoStart: boolean;
    clientPath?: string;
    clientSha256?: string;
    arguments: readonly string[];
    profile: string;
    tunnelId?: string;
  };
  defaults: {
    portfolioId: string;
    baseCurrency: string;
  };
  raw: RawEnvironment;
}

export interface LoadConfigurationOptions {
  loadEnvFile?: boolean;
  environment?: NodeJS.ProcessEnv;
}

/** Packaged binaries always enforce production invariants; a parent process
 * cannot downgrade them by setting AMEX_APP_ENV. */
export function environmentForRuntime(
  environment: NodeJS.ProcessEnv,
  packaged: boolean
): NodeJS.ProcessEnv {
  return packaged
    ? {
        ...environment,
        AMEX_APP_ENV: "production",
        // Screenshot capture is a session-only UI choice in an explicitly
        // marked unsigned alpha; no process setting may disable it at launch.
        AMEX_SCREENSHOT_PROTECTION: "true",
        // A packaged first run stays local-only until the owner explicitly
        // provisions bearer authentication and enables an MCP transport.
        ...(environment.AMEX_MCP_MODE === undefined ? { AMEX_MCP_MODE: "disabled" } : {})
      }
    : { ...environment };
}

export function loadConfiguration(options: LoadConfigurationOptions = {}): AppConfiguration {
  if (options.loadEnvFile === true) {
    loadDotEnv({ override: false });
  }

  const parsed = environmentSchema.parse(options.environment ?? process.env);
  enforceSecurityInvariants(parsed);

  const localAppData = (options.environment ?? process.env).LOCALAPPDATA;
  const dataDirectory = resolve(
    parsed.AMEX_DATA_DIR ??
      (localAppData ? resolve(localAppData, "AmexLocalFinanceConnector") : resolve(".local-data"))
  );
  const databasePath = resolveContainedPath(dataDirectory, parsed.AMEX_DATABASE_FILE, "AMEX_DATABASE_FILE");
  const importDirectory = resolveContainedPath(
    dataDirectory,
    parsed.AMEX_IMPORT_STAGING_DIR,
    "AMEX_IMPORT_STAGING_DIR"
  );
  const exportDirectory = resolveContainedPath(dataDirectory, parsed.AMEX_EXPORT_DIR, "AMEX_EXPORT_DIR");
  const logDirectory = resolveContainedPath(dataDirectory, parsed.AMEX_LOG_DIR, "AMEX_LOG_DIR");

  const mcp: AppConfiguration["mcp"] = {
    mode: parsed.AMEX_MCP_MODE,
    host: parsed.AMEX_MCP_HOST,
    port: parsed.AMEX_MCP_PORT,
    path: parsed.AMEX_MCP_PATH,
    authMode: parsed.AMEX_MCP_AUTH_MODE,
    maxPageSize: parsed.AMEX_MCP_MAX_PAGE_SIZE,
    requestTimeoutMs: parsed.AMEX_MCP_REQUEST_TIMEOUT_MS,
    rateLimitPerMinute: parsed.AMEX_MCP_RATE_LIMIT_PER_MINUTE
  };
  if (parsed.AMEX_MCP_BEARER_TOKEN_REF) {
    mcp.bearerTokenReference = parsed.AMEX_MCP_BEARER_TOKEN_REF;
  }

  const tunnel: AppConfiguration["tunnel"] = {
    enabled: parsed.OPENAI_TUNNEL_ENABLED,
    autoStart: parsed.OPENAI_TUNNEL_AUTO_START,
    profile: parsed.OPENAI_TUNNEL_PROFILE,
    arguments: parseTunnelArguments(parsed.OPENAI_TUNNEL_ARGUMENTS_JSON)
  };
  if (parsed.OPENAI_TUNNEL_CLIENT_PATH) tunnel.clientPath = parsed.OPENAI_TUNNEL_CLIENT_PATH;
  if (parsed.OPENAI_TUNNEL_CLIENT_SHA256) tunnel.clientSha256 = parsed.OPENAI_TUNNEL_CLIENT_SHA256.toLowerCase();
  if (parsed.OPENAI_TUNNEL_ID) tunnel.tunnelId = parsed.OPENAI_TUNNEL_ID;

  return {
    environment: parsed.AMEX_APP_ENV,
    logLevel: parsed.AMEX_LOG_LEVEL,
    startMinimized: parsed.AMEX_START_MINIMIZED,
    startWithWindows: parsed.AMEX_START_WITH_WINDOWS,
    timezone: parsed.AMEX_TIMEZONE,
    telemetryEnabled: parsed.AMEX_TELEMETRY_ENABLED,
    crashReportingEnabled: parsed.AMEX_CRASH_REPORTING_ENABLED,
    screenshotProtection: parsed.AMEX_SCREENSHOT_PROTECTION,
    demoMode: parsed.AMEX_DEMO_MODE,
    storage: {
      dataDirectory,
      databasePath,
      importDirectory,
      exportDirectory,
      logDirectory,
      autoLockMinutes: parsed.AMEX_DATABASE_AUTO_LOCK_MINUTES
    },
    mcp,
    tunnel,
    defaults: {
      portfolioId: parsed.AMEX_DEFAULT_PORTFOLIO_ID,
      baseCurrency: parsed.AMEX_BASE_CURRENCY
    },
    raw: parsed
  };
}

function resolveContainedPath(dataDirectory: string, configuredPath: string, variable: string): string {
  if (isAbsolute(configuredPath)) {
    throw new Error(`${variable} must be a relative path inside AMEX_DATA_DIR.`);
  }
  const candidate = resolve(dataDirectory, configuredPath);
  const relativePath = relative(dataDirectory, candidate);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${variable} must remain inside AMEX_DATA_DIR.`);
  }
  return candidate;
}

function enforceSecurityInvariants(environment: RawEnvironment): void {
  if (environment.AMEX_MCP_AUTH_MODE === "bearer" && !environment.AMEX_MCP_BEARER_TOKEN_REF) {
    throw new Error("AMEX_MCP_BEARER_TOKEN_REF is required when bearer authentication is enabled.");
  }

  if (environment.OPENAI_TUNNEL_ENABLED && environment.AMEX_MCP_MODE !== "tunnel") {
    throw new Error("AMEX_MCP_MODE must be tunnel when the Secure MCP Tunnel is enabled.");
  }
  if (environment.AMEX_MCP_MODE === "tunnel" && !environment.OPENAI_TUNNEL_ENABLED) {
    throw new Error("OPENAI_TUNNEL_ENABLED must be true when AMEX_MCP_MODE is tunnel.");
  }
  if (environment.OPENAI_TUNNEL_ENABLED && environment.AMEX_MCP_AUTH_MODE !== "bearer") {
    throw new Error("Tunnel mode requires bearer authentication on the loopback MCP endpoint.");
  }
  if (environment.OPENAI_TUNNEL_AUTO_START && !environment.OPENAI_TUNNEL_ENABLED) {
    throw new Error("Tunnel auto-start cannot be enabled while the Secure MCP Tunnel is disabled.");
  }

  if (environment.OPENAI_TUNNEL_ENABLED && !environment.OPENAI_TUNNEL_ID) {
    throw new Error("OPENAI_TUNNEL_ID is required when the Secure MCP Tunnel is enabled.");
  }
  if (
    environment.OPENAI_TUNNEL_ENABLED &&
    (!environment.OPENAI_TUNNEL_CLIENT_PATH || !environment.OPENAI_TUNNEL_CLIENT_SHA256)
  ) {
    throw new Error("Tunnel mode requires a verified client path and SHA-256 digest.");
  }
  if (environment.OPENAI_TUNNEL_ENABLED && parseTunnelArguments(environment.OPENAI_TUNNEL_ARGUMENTS_JSON).length === 0) {
    throw new Error("Tunnel mode requires a reviewed outbound client argument template.");
  }

  if (environment.AMEX_US_AGGREGATOR === "approved-provider-generic") {
    const missing = [
      environment.AMEX_US_AGGREGATOR_BASE_URL,
      environment.AMEX_US_AGGREGATOR_CLIENT_ID_REF,
      environment.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF,
      environment.AMEX_US_OAUTH_AUTHORIZATION_URL,
      environment.AMEX_US_OAUTH_TOKEN_URL
    ].some((value) => !value);
    if (missing) {
      throw new Error("Approved U.S. aggregation requires its base URL and protected client credential references.");
    }
  }
  if (
    environment.AMEX_US_AGGREGATOR === "plaid" &&
    (!environment.AMEX_US_AGGREGATOR_CLIENT_ID_REF || !environment.AMEX_US_AGGREGATOR_CLIENT_SECRET_REF)
  ) {
    throw new Error("Plaid setup requires protected Windows client credential references.");
  }

  if (environment.AMEX_FX_RATE_SOURCE === "provider" && !environment.AMEX_FX_PROVIDER_BASE_URL) {
    throw new Error("AMEX_FX_PROVIDER_BASE_URL is required for provider-sourced FX rates.");
  }

  if (environment.AMEX_CATEGORY_MAPPING_FILE && !isAbsolute(environment.AMEX_CATEGORY_MAPPING_FILE)) {
    throw new Error("AMEX_CATEGORY_MAPPING_FILE must be an absolute local path.");
  }

  if (environment.AMEX_APP_ENV === "production") {
    if (!environment.AMEX_SCREENSHOT_PROTECTION) {
      throw new Error("Screenshot protection cannot be disabled in production.");
    }
    if (environment.AMEX_DEMO_MODE) throw new Error("Demo data is forbidden in production.");
    if (!environment.AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL) {
      throw new Error("Human export approval cannot be disabled in production.");
    }
    if (environment.AMEX_TELEMETRY_ENABLED || environment.AMEX_CRASH_REPORTING_ENABLED) {
      throw new Error("Remote telemetry and crash reporting are disabled by the local-first production policy.");
    }
    if (environment.AMEX_MCP_MODE !== "disabled" && environment.AMEX_MCP_AUTH_MODE !== "bearer") {
      throw new Error("Production financial-data MCP access requires bearer authentication, including on loopback.");
    }
  }
}

function parseTunnelArguments(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("OPENAI_TUNNEL_ARGUMENTS_JSON must be a JSON array of argument strings.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 64 ||
    !parsed.every(
      (item) =>
        typeof item === "string" &&
        item.length >= 1 &&
        item.length <= 8192 &&
        !/[\u0000\r\n]/u.test(item)
    )
  ) {
    throw new Error("OPENAI_TUNNEL_ARGUMENTS_JSON must contain at most 64 safe argument strings.");
  }
  if (parsed.length > 0 && !parsed.some((item) => item.includes("{localMcpEndpoint}"))) {
    throw new Error("Tunnel arguments must include the {localMcpEndpoint} placeholder.");
  }
  return Object.freeze([...parsed]);
}
