# Environment and secret configuration

The committed [`.env.example`](../.env.example) is the complete configuration contract for the first-release scaffold. Copy it to `.env` only for local development. Packaged builds currently use hardened defaults plus explicit process settings and do not load a repository-side `.env` file. Persisting preferences through the desktop UI is a first-release target, not an implemented scaffold feature.

> **Never commit production secrets, tokens, American Express credentials, account identifiers, statement imports, exports, logs, or account data.** The app never needs an Amex username or password. A name ending in `_REF` contains only a locator for a protected value, such as `wincred:AmexLocalFinanceConnector/OpenAI/TunnelRuntimeKey`; it must never contain the value itself.

## Loading and validation

Configuration precedence is: explicit process environment, development `.env`, then the safe application default. `dotenv` never overwrites an existing process value. The packaged app does not load `.env` by default. Startup rejects invalid ports, non-loopback MCP binding, missing conditional settings, insecure production storage, production demo mode, production telemetry, and disabling human export approval in production.

Blank optional values are treated as unset. Comma-separated lists are trimmed by the consuming adapter. Relative storage names are resolved underneath `AMEX_DATA_DIR`; do not use repository folders for runtime data.

The scaffold actively applies the desktop startup/privacy flags, contained storage paths, loopback MCP host/port/path/rate limit, demo mode, and production invariants. Provider/tunnel/FX adapter settings are validated configuration seams. Automatic lock/retention jobs, configurable MCP timeout/page caps, bearer-reference resolution, tray-supervised tunnel startup, and settings persistence remain explicit release gates; setting their reserved variables does not silently enable those capabilities.

## Application variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_APP_ENV` | No | `development`, `test`, or `production`; enables the corresponding security checks. |
| `AMEX_LOG_LEVEL` | No | Local log threshold: `trace`, `debug`, `info`, `warn`, or `error`. Logs must redact financial fields. |
| `AMEX_START_MINIMIZED` | No | Start directly in the Windows notification area. |
| `AMEX_START_WITH_WINDOWS` | No | Requests per-user startup registration in a packaged build. The scaffold reads this at process start; a persistent UI toggle remains a release gate. |
| `AMEX_TIMEZONE` | No | IANA time zone used for statement boundaries and display. Stored transaction instants remain unambiguous. |
| `AMEX_TELEMETRY_ENABLED` | No | Reserved feature flag. Production local-first policy requires `false`. |
| `AMEX_CRASH_REPORTING_ENABLED` | No | Reserved feature flag. Production local-first policy requires `false`; diagnostic bundles are local and user-created. |
| `AMEX_SCREENSHOT_PROTECTION` | No | Requests Windows content protection on financial windows. It is defense in depth, not a guarantee against screen capture. |
| `AMEX_DEMO_MODE` | No | Enables explicit synthetic seed data for development. Production rejects `true`. |

## Storage and retention variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_DATA_DIR` | No | Absolute local data root. Blank defaults to `%LOCALAPPDATA%\AmexLocalFinanceConnector`. |
| `AMEX_DATABASE_FILE` | No | Encrypted serialized SQLite image name. Default `ledger.db.enc`. |
| `AMEX_IMPORT_STAGING_DIR` | No | Private staging/quarantine subdirectory for selected statement files. |
| `AMEX_EXPORT_DIR` | No | Destination root for human-approved export packages. |
| `AMEX_LOG_DIR` | No | Local operational-log directory. Audit events are logically separate even when stored below the same root. |
| `AMEX_DATABASE_AUTO_LOCK_MINUTES` | No | Validated target policy for an idle-lock timer; the current scaffold supports explicit lock/exit only. |
| `AMEX_LOG_RETENTION_DAYS` | No | Validated target for the not-yet-wired operational-log retention job. |
| `AMEX_AUDIT_RETENTION_DAYS` | No | Validated target for the not-yet-wired audit-retention job. Local policy may require a longer value. |

The SQLite image is decrypted only in the app process and re-encrypted with AES-256-GCM before persistence. A random database key is wrapped by Electron `safeStorage`; on Windows this is backed by the current Windows user’s OS protection facilities (normally DPAPI). The opaque wrapped key is embedded inside the authenticated `.db.enc` envelope—there is no plaintext key or key sidecar. The encrypted file is sensitive and ignored. Copying it to another computer is not supported and does not create cross-device sync. Windows account compromise can still expose data while the app is unlocked; see the threat model.

## MCP variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_MCP_MODE` | No | `disabled`, `local`, or `tunnel`. `local` starts the loopback server. `tunnel` reserves connected mode but does not yet supervise `tunnel-client`; use the documented manual client workflow. |
| `AMEX_MCP_HOST` | No | Must be `127.0.0.1`. Any public/LAN bind is rejected. |
| `AMEX_MCP_PORT` | No | Loopback port for Streamable HTTP. Default `43121`. |
| `AMEX_MCP_PATH` | No | MCP route, default `/mcp`. |
| `AMEX_MCP_AUTH_MODE` | No | `loopback-only` or reserved `bearer`. The current scaffold refuses to start MCP in bearer mode until its protected-reference resolver is implemented. |
| `AMEX_MCP_BEARER_TOKEN_REF` | Conditional | Required for reserved `bearer` mode; locator for a randomly generated token held in a Windows secret store, never the token itself. |
| `AMEX_MCP_MAX_PAGE_SIZE` | No | Validated target setting; current registered tool schemas hard-cap pages at 200. Wiring a configurable lower cap remains a release gate. |
| `AMEX_MCP_REQUEST_TIMEOUT_MS` | No | Validated target setting for request cancellation; transport-level enforcement remains a release gate. |
| `AMEX_MCP_RATE_LIMIT_PER_MINUTE` | No | Per-loopback-client abuse-control budget. |

Every MCP financial-data call contains an explicit `account_id` or `portfolio_id`. The server publishes only the seven read-only tools documented in `MCP_TOOLS.md`; desktop configuration, imports, exports, and account authorization are not MCP capabilities.

## OpenAI Secure MCP Tunnel variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_TUNNEL_ENABLED` | No | Allows tunnel integration. It does not make the app public and has no effect unless a configured client is running. |
| `OPENAI_TUNNEL_AUTO_START` | No | Reserved target for tray supervision. Keep `false`; the current scaffold does not start a child process or resolve its runtime key. |
| `OPENAI_TUNNEL_CLIENT_PATH` | Conditional | Absolute path to a verified OpenAI `tunnel-client` binary for the future app-managed workflow; current manual setup invokes it outside the app. |
| `OPENAI_TUNNEL_PROFILE` | No | Local tunnel-client profile name, default `amex-local`. |
| `OPENAI_TUNNEL_ID` | Conditional | Required when enabled; the `tunnel_...` identifier created in Platform tunnel settings. It is an identifier, not a credential. |
| `OPENAI_TUNNEL_CONTROL_PLANE_API_KEY_REF` | Conditional | Required for auto-start; reference to the runtime API key in protected Windows storage. Never put `CONTROL_PLANE_API_KEY` or an `sk-...` value in `.env`. |
| `OPENAI_TUNNEL_MTLS_CERT_REF` | No | Optional enterprise client-certificate reference. |
| `OPENAI_TUNNEL_MTLS_KEY_REF` | No | Optional protected private-key reference paired with the certificate. |
| `OPENAI_TUNNEL_CA_BUNDLE` | No | Optional reviewed custom CA bundle path. |
| `OPENAI_TUNNEL_HTTPS_PROXY` | No | Optional outbound HTTPS proxy used by the tunnel client. Do not embed proxy credentials. |
| `OPENAI_TUNNEL_NO_PROXY` | No | Hosts that bypass the proxy; loopback must remain present. |

The official [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) describes an outbound HTTPS client that forwards MCP requests to a private local server without opening inbound firewall ports. It requires a Platform tunnel ID, tunnel permissions, a runtime API key, and separate ChatGPT developer-mode/workspace authority. The app remains useful with the tunnel disabled. The tunnel is for private development/workspace connections and is not a public plugin-publishing endpoint.

## U.S. aggregation variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_US_AGGREGATOR` | No | Provider adapter name. First-release scaffold defaults to `disabled`; only an approved consent-based read-only provider may be enabled. |
| `AMEX_US_AGGREGATOR_ENVIRONMENT` | Conditional | `sandbox` or `production` provider environment. |
| `AMEX_US_AGGREGATOR_BASE_URL` | Conditional | Reviewed provider API base URL. Required whenever the adapter is not disabled. |
| `AMEX_US_AGGREGATOR_CLIENT_ID_REF` | Conditional | Reference to the registered OAuth client ID. Required when enabled. |
| `AMEX_US_AGGREGATOR_CLIENT_SECRET_REF` | Conditional | Reference to the protected OAuth client secret. Required when enabled. |
| `AMEX_US_AGGREGATOR_REDIRECT_URI` | No | Loopback OAuth callback registered with the provider. |
| `AMEX_US_AGGREGATOR_SCOPES` | No | Requested read-only scopes. Provider setup must reject write/payment/control scopes. |
| `AMEX_US_OAUTH_CALLBACK_PORT` | No | Loopback callback port. |
| `AMEX_US_SYNC_INTERVAL_MINUTES` | No | Minimum automatic refresh interval while the app runs. |
| `AMEX_US_SYNC_LOOKBACK_DAYS` | No | Initial/repair transaction lookback request. Provider limits still apply. |
| `AMEX_US_TOKEN_REFRESH_SKEW_SECONDS` | No | Refresh-before-expiry margin. Reauthorization is requested only when refresh cannot restore valid consent. |

OAuth access/refresh tokens are per authorized account connection and belong in the encrypted local token vault/database, not environment variables. The provider’s hosted flow obtains user consent. The application must never ask for, scrape, log, or store an Amex username, password, one-time code, or security answer.

## Japan import variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_JP_IMPORT_MAX_MB` | No | Maximum selected statement-file size before parsing. |
| `AMEX_JP_ALLOWED_EXTENSIONS` | No | Allowlist of official export formats. Content sniffing and parser validation are still required. |
| `AMEX_JP_CSV_ENCODINGS` | No | Accepted text encodings in priority order. `cp932` is distinct from strict Shift-JIS for some characters. |
| `AMEX_IMPORT_QUARANTINE_ENABLED` | No | Copies selected input into a private staging area before validation. |
| `AMEX_IMPORT_DUPLICATE_WINDOW_DAYS` | No | Extra date window considered by import fingerprint duplicate checks. |
| `AMEX_PDF_OCR_ENABLED` | No | Enables a future local-only OCR adapter. Default off; no cloud OCR is implied. |
| `AMEX_PDF_OCR_ENGINE_PATH` | Conditional | Verified local OCR binary path when OCR is enabled. |

Japan collection is official-file import only in the first release. These settings do not enable scraping or browser automation.

## Portfolio, reconciliation, FX, and alert variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_DEFAULT_PORTFOLIO_ID` | No | Local owner-controlled portfolio identifier used by the UI/demo. MCP callers still pass it explicitly. |
| `AMEX_BASE_CURRENCY` | No | ISO 4217 reporting currency. Original transaction amounts/currencies are never overwritten. |
| `AMEX_FX_RATE_SOURCE` | No | `manual` or `provider`; default manual avoids unapproved network calls. |
| `AMEX_FX_PROVIDER_BASE_URL` | Conditional | Required if FX source is `provider`. |
| `AMEX_FX_PROVIDER_API_KEY_REF` | Conditional | Optional protected provider-key reference if that reviewed provider requires one. |
| `AMEX_FX_STALE_AFTER_HOURS` | No | Age after which converted totals are flagged as using stale rates. |
| `AMEX_RECONCILIATION_TOLERANCE_MINOR_UNITS` | No | Allowed rounding difference in the statement currency’s minor units. |
| `AMEX_CATEGORY_MAPPING_FILE` | No | Optional local mapping file path; it must contain categories only, not statement data or secrets. |
| `AMEX_ALERTS_ENABLED` | No | Enables review-only local anomaly generation. It never files a dispute or controls a card. |
| `AMEX_ALERT_LOOKBACK_DAYS` | No | Baseline history window. |
| `AMEX_ALERT_AMOUNT_ZSCORE` | No | Statistical amount-deviation threshold. |
| `AMEX_ALERT_NEW_MERCHANT_DAYS` | No | History window used to label a merchant as new. |
| `AMEX_ALERT_HIGH_VALUE_USD` | No | Simple USD-equivalent high-value review threshold; converted values disclose their FX provenance. |

## Export variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL` | No | Must remain `true` in production. The scaffold binds approval to one preview digest and rejects process-lifetime replay; durable transactional consumption across restarts remains a release gate. |
| `AMEX_EXPORT_DUPLICATE_WINDOW_DAYS` | No | Period searched for earlier export fingerprints before package creation. |
| `AMEX_EXPORT_RETENTION_DAYS` | No | Local export-package cleanup target after the owner has collected the files. |
| `AMEX_QBO_DEFAULT_FORMAT` | No | `csv`, `qbo`, or `qfx`. This creates an import file only; it never calls QuickBooks Online. |
| `AMEX_MONEY_FORWARD_ENCODING` | No | `utf-8` or `shift_jis`, selected to match the chosen Money Forward import workflow. |
| `AMEX_MONEY_FORWARD_LINE_ENDING` | No | `lf` or Windows-compatible `crlf`. |

## Secret references and rotation

`wincred:<target>` is the documented reference grammar for operator-provided secrets. The production secret resolver must retrieve a Generic Credential for the current Windows user and return it only to the adapter that needs it. Internal OAuth tokens and the database key are instead encrypted with the app’s `safeStorage`/DPAPI boundary. Neither mechanism makes secrets safe from malware running as the same unlocked user.

Rotate provider client secrets and tunnel runtime keys at their source, update the corresponding Windows-protected entry, then restart the adapter. Account OAuth tokens are rotated/refreshed independently per authorization. Revoking one authorization must not invalidate or merge any other account’s data. Never copy token caches or key envelopes into Git, tickets, logs, or diagnostic bundles.

## Configuration review checklist

1. Confirm the MCP host is exactly `127.0.0.1` and Windows Firewall has no inbound rule for the app.
2. Confirm demo mode, telemetry, crash reporting, and insecure storage are off for production.
3. Confirm every `_REF` value is a reference and not a secret.
4. Confirm the U.S. adapter is disabled until provider approval, read-only scopes, redirect URI, and data handling are reviewed.
5. Confirm tunnel organization/workspace associations grant only the intended owner/workspace access.
6. Confirm export human approval remains on and review target account/entity mappings before every export.
