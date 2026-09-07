# Environment and secret configuration

The committed [`.env.example`](../.env.example) is the complete configuration contract for the local alpha. Copy it to `.env` only for local development. Packaged builds use hardened defaults plus explicit process settings and do not load a repository-side `.env` file. Most security-sensitive adapter settings remain operator-managed rather than editable in the desktop UI.

> **Never commit production secrets, tokens, American Express credentials, account identifiers, statement imports, exports, logs, or account data.** The app never needs an Amex username or password. A name ending in `_REF` contains only a locator for a protected value, such as `wincred:AmexLocalFinanceConnector/McpBearer`; it must never contain the value itself.

## Loading and validation

Configuration precedence is: explicit process environment, development `.env`, then the safe application default. `dotenv` never overwrites an existing process value. The packaged app does not load `.env` by default and defaults MCP to `disabled`. Startup rejects invalid ports, non-loopback MCP binding, missing conditional settings, insecure production storage, production demo mode, production telemetry, disabling human export approval in production, and any enabled production MCP listener without bearer authentication.

Blank optional values are treated as unset. Comma-separated lists are trimmed by the consuming adapter. Relative storage names are resolved underneath `AMEX_DATA_DIR`; do not use repository folders for runtime data.

The app actively applies the desktop startup/privacy flags, contained storage paths, idle lock, loopback MCP host/port/path/rate/timeout controls, bearer-reference resolution, demo mode, provider validation, and production invariants. Tunnel mode supervises only a hash-pinned executable with reviewed non-secret arguments and an already provisioned protected profile. Retention jobs, a configurable lower MCP tool-page cap, and general settings persistence remain release work; setting their reserved variables does not silently enable those capabilities.

## Application variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_APP_ENV` | No | `development`, `test`, or `production`; enables the corresponding security checks. |
| `AMEX_LOG_LEVEL` | No | Validated/reserved local operational-log threshold: `trace`, `debug`, `info`, `warn`, or `error`. The alpha does not yet wire a general logger; the redacted financial audit sink is separate. |
| `AMEX_START_MINIMIZED` | No | Start directly in the Windows notification area. |
| `AMEX_START_WITH_WINDOWS` | No | Requests per-user startup registration in a packaged build. It is read at process start; a persistent UI toggle remains release work. |
| `AMEX_TIMEZONE` | No | Validated/reserved IANA time zone for future statement-boundary policy. Current display uses the Windows locale and stored transaction instants remain unambiguous. |
| `AMEX_TELEMETRY_ENABLED` | No | Reserved feature flag. Production local-first policy requires `false`. |
| `AMEX_CRASH_REPORTING_ENABLED` | No | Reserved feature flag. Production local-first policy requires `false`; diagnostic bundles are local and user-created. |
| `AMEX_SCREENSHOT_PROTECTION` | No | Defaults to `true` and requests Windows content protection on financial windows. `false` is permitted only in development/test for a synthetic-data screenshot run; production rejects it. The value is read at process start, so fully exit and restart the tray app after changing it. Content protection is defense in depth, not a guarantee against cameras or privileged capture software. |
| `AMEX_DEMO_MODE` | No | Enables explicit synthetic seed data for development. Production rejects `true`. |

### Development-only screenshots

Keep `AMEX_SCREENSHOT_PROTECTION=true` for production and for every run that can display real statements, transactions, account identifiers, provider pages, credentials, tokens, local paths containing personal information, or other financial data.

For a documentation screenshot made entirely with synthetic local data, a developer may temporarily use `AMEX_SCREENSHOT_PROTECTION=false` with `AMEX_APP_ENV=development` or `test`. Fully exit the running tray app first, verify that the next run cannot open an existing real-data profile, then restart with the development screenshot configuration. Never capture `.env`, Windows Credential Manager, provider consent, logs, local file paths, or any screen containing real account data or secrets. Exit that run when finished and restore protection before any real-data use.

The dedicated `npm run dev:screenshots` command is the safer source-development entry point: it enables demo data, uses the isolated `local-data/screenshot-development` data directory, and disables content protection for that run. It cannot display the normal existing real-data store. Still inspect every frame before saving or sharing it. A production configuration cannot start with the environment flag disabled and fails closed with `Screenshot protection cannot be disabled in production.`

Every packaged launch forces screenshot protection on, even if its process environment tries to set the flag to `false`. The separately built **unsigned-alpha** installer has a second, session-only control for documentation testing after that protected start. Choose **Settings → Allow screenshots this session**, read the native warning, and explicitly confirm. While protection is off, the app shows a **Screenshots allowed** badge and the warning **Screenshot capture is allowed for this session** on every page. Choose **Turn protection back on** as soon as the capture is complete. This Settings choice is held only in memory; exiting and relaunching the installed app starts protected again.

The session control is available only to unpackaged development/test runs and artifacts carrying the explicit generated `unsigned-alpha` build-channel marker. A missing, malformed, or ordinary production marker hides it. Future signed/production packages must not expose the control. The unsigned-alpha exception does not make real-data capture acceptable: use synthetic data only and never capture real account information or credentials.

## Storage and retention variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_DATA_DIR` | No | Absolute local data root. Blank defaults to `%LOCALAPPDATA%\AmexLocalFinanceConnector`. |
| `AMEX_DATABASE_FILE` | No | Encrypted serialized SQLite image name. Default `ledger.db.enc`. |
| `AMEX_IMPORT_STAGING_DIR` | No | Private staging/quarantine subdirectory for selected statement files. |
| `AMEX_EXPORT_DIR` | No | Destination root for human-approved export packages. |
| `AMEX_LOG_DIR` | No | Local operational-log directory. Audit events are logically separate even when stored below the same root. |
| `AMEX_DATABASE_AUTO_LOCK_MINUTES` | No | Minutes of inactivity before the encrypted runtime locks; `0` disables the idle timer. Explicit lock/exit remains available. |
| `AMEX_LOG_RETENTION_DAYS` | No | Validation-only target for a not-yet-wired operational-log retention job. |
| `AMEX_AUDIT_RETENTION_DAYS` | No | Validation-only target for a not-yet-wired audit-retention job. Local policy may require a longer value. |

The SQLite image is decrypted only in the app process and re-encrypted with AES-256-GCM before persistence. A random database key is wrapped by Electron `safeStorage`; on Windows this is backed by the current Windows user’s OS protection facilities (normally DPAPI). The opaque wrapped key is embedded inside the authenticated `.db.enc` envelope—there is no plaintext key or key sidecar. The encrypted file is sensitive and ignored. Copying it to another computer is not supported and does not create cross-device sync. Windows account compromise can still expose data while the app is unlocked; see the threat model.

## MCP variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_MCP_MODE` | No | `disabled`, `local`, or `tunnel`. Packaged production defaults to `disabled`; `local` starts only the loopback server and `tunnel` additionally allows the tray app to supervise a fully configured, hash-pinned outbound client. |
| `AMEX_MCP_HOST` | No | Must be `127.0.0.1`. Any public/LAN bind is rejected. |
| `AMEX_MCP_PORT` | No | Loopback port for Streamable HTTP. Default `43121`. |
| `AMEX_MCP_PATH` | No | MCP route, default `/mcp`. |
| `AMEX_MCP_AUTH_MODE` | No | `loopback-only` or `bearer`. `loopback-only` is for development/test use; every enabled production MCP mode, including local loopback, requires `bearer`. |
| `AMEX_MCP_BEARER_TOKEN_REF` | Conditional | Required for `bearer` mode; locator for a randomly generated token held in the current Windows user's Generic Credential store, never the token itself. |
| `AMEX_MCP_MAX_PAGE_SIZE` | No | Applied upper bound for MCP/provider page requests; the registered tool schemas additionally hard-cap pages at `200`. |
| `AMEX_MCP_REQUEST_TIMEOUT_MS` | No | Transport request timeout in milliseconds; an expired request is terminated locally. |
| `AMEX_MCP_RATE_LIMIT_PER_MINUTE` | No | Per-loopback-client authenticated abuse-control budget. Failed authentication is counted in a separate, smaller bucket so local guessing is bounded without exhausting the legitimate client's quota. |

Every MCP financial-data call contains an explicit `account_id` or `portfolio_id`. The server publishes only the seven read-only tools documented in `MCP_TOOLS.md`; desktop configuration, imports, exports, and account authorization are not MCP capabilities.

## OpenAI Secure MCP Tunnel variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENAI_TUNNEL_ENABLED` | No | Allows tunnel integration. It does not make the app public and has no effect unless a configured client is running. |
| `OPENAI_TUNNEL_AUTO_START` | No | Starts the verified outbound client with the encrypted runtime and stops it on lock/exit. Keep `false` until the exact client/profile is reviewed. |
| `OPENAI_TUNNEL_CLIENT_PATH` | Conditional | Absolute path to the vetted tunnel client executable; required when enabled. Reparse points and non-files are rejected. |
| `OPENAI_TUNNEL_CLIENT_SHA256` | Conditional | Exact SHA-256 of the vetted executable. The app re-hashes the binary immediately before every launch. |
| `OPENAI_TUNNEL_ARGUMENTS_JSON` | Conditional | JSON array of reviewed CLI arguments. It must include `{localMcpEndpoint}` and may include `{profile}` and `{tunnelId}`. Secrets and public-listen flags are rejected. |
| `OPENAI_TUNNEL_PROFILE` | No | Name of the vetted client's already-provisioned protected profile, default `amex-local`. |
| `OPENAI_TUNNEL_ID` | Conditional | Required when enabled; the `tunnel_...` identifier created in Platform tunnel settings. It is an identifier, not a credential. |

Connected mode accepts only a reviewed outbound client command supplied for the exact client build, verifies the executable hash, rejects command-line/environment secrets and public-listen flags, and supervises process shutdown. The public OpenAI documentation lookup performed during implementation did not establish a generally available client download or stable CLI contract, so no install or provisioning command is guessed in this repository. Platform/workspace authority, an already provisioned protected client profile, and the exact authoritative client instructions for that account remain external prerequisites. Fully local mode remains available with the tunnel disabled; generic reverse proxies and public port forwarding are unsupported.

## U.S. aggregation variables

These variables describe the current normalized, provider-agnostic adapter. They are **not** a drop-in Plaid configuration: Plaid Hosted Link does not use this adapter's generic authorization/token endpoints or `normalized_v1` response paths, and Plaid Statements does not support credit-card accounts. Do not set Plaid API URLs here and infer that the U.S. path is ready. The proposed provider-specific contract is design-only in [Future Plaid Hosted Link design](PLAID_HOSTED_LINK.md); it needs code, tests, external approval, and an explicit configuration mapping before use.

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_US_AGGREGATOR` | No | Normalized provider adapter name. Defaults to `disabled`; only an independently approved consent-based read-only provider may be enabled. No provider or direct Amex access is bundled. |
| `AMEX_US_AGGREGATOR_ENVIRONMENT` | Conditional | `sandbox` or `production` provider environment. |
| `AMEX_US_AGGREGATOR_BASE_URL` | Conditional | Reviewed provider API base URL. Required whenever the adapter is not disabled. |
| `AMEX_US_AGGREGATOR_CLIENT_ID_REF` | Conditional | Reference to the registered OAuth client ID. Required when enabled. |
| `AMEX_US_AGGREGATOR_CLIENT_SECRET_REF` | Conditional | Reference to the protected OAuth client secret. Required when enabled. |
| `AMEX_US_OAUTH_AUTHORIZATION_URL` | Conditional | Exact HTTPS authorization endpoint supplied by the approved provider; required when enabled. |
| `AMEX_US_OAUTH_TOKEN_URL` | Conditional | Exact HTTPS token endpoint supplied by the approved provider; required when enabled. |
| `AMEX_US_OAUTH_REVOCATION_URL` | No | Optional exact HTTPS revocation endpoint when the approved provider supports it. |
| `AMEX_US_AGGREGATOR_REDIRECT_URI` | No | Loopback OAuth callback registered with the provider. |
| `AMEX_US_AGGREGATOR_SCOPES` | No | Requested read-only scopes. Provider setup must reject write/payment/control scopes. |
| `AMEX_US_PROVIDER_RESPONSE_PROFILE` | No | Versioned response contract; the current adapter accepts only `normalized_v1`. This does not make an arbitrary provider compatible. |
| `AMEX_US_API_ACCOUNTS_PATH` | No | Relative GET path for the provider's normalized account list. |
| `AMEX_US_API_ACCOUNT_STATUS_PATH` | No | Relative GET template for one account status; must include `{providerAccountId}`. |
| `AMEX_US_API_TRANSACTIONS_PATH` | No | Relative GET template for transactions; must include `{providerAccountId}`. |
| `AMEX_US_API_STATEMENTS_PATH` | No | Relative GET template for statement summaries; must include `{providerAccountId}`. |
| `AMEX_US_API_STATEMENT_PATH` | No | Relative GET template for one statement; must include `{providerAccountId}` and `{providerStatementId}`. |
| `AMEX_US_PROVIDER_MAX_RESPONSE_MB` | No | Maximum response body accepted from the provider, in MiB; default `10`. Oversized responses fail closed. |
| `AMEX_US_OAUTH_CALLBACK_PORT` | No | Loopback callback port. |
| `AMEX_US_SYNC_INTERVAL_MINUTES` | No | Validation-only target for automatic refresh scheduling. The alpha syncs only from an explicit desktop action. |
| `AMEX_US_SYNC_LOOKBACK_DAYS` | No | Initial/repair transaction lookback request. Provider limits still apply. |
| `AMEX_US_TOKEN_REFRESH_SKEW_SECONDS` | No | Refresh-before-expiry margin. Reauthorization is requested only when refresh cannot restore valid consent. |

OAuth access/refresh tokens are per authorized account connection and belong in the encrypted local token vault/database, not environment variables. The provider's hosted flow obtains user consent. The application must never ask for, scrape, log, or store an Amex username, password, one-time code, or security answer. An expected external provider or American Express page may handle authentication, but its credentials must never cross into this app.

If a future Plaid implementation deliberately maps its API registration to `AMEX_US_AGGREGATOR_CLIENT_ID_REF` and `AMEX_US_AGGREGATOR_CLIENT_SECRET_REF`, both settings must still contain only environment-specific `wincred:` locators. The Plaid `client_id` and `secret` are resolved only in the privileged provider boundary. Per-Item Plaid access tokens and Item IDs are internal encrypted connection records, not `.env` values. Merely adding those references today does not enable Plaid.

## Japan import variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_JP_IMPORT_MAX_MB` | No | Maximum selected statement-file size before parsing, integer `1`–`25`; default `25` MiB. All current parsers enforce the same 25 MiB ceiling. |
| `AMEX_JP_ALLOWED_EXTENSIONS` | No | Allowlist of official export formats. Content sniffing and parser validation are still required. |
| `AMEX_JP_CSV_ENCODINGS` | No | Validation-only preference for a future configurable encoding allowlist. Current parsers use their fixed reviewed UTF-8/Shift-JIS/CP932 handling. |
| `AMEX_IMPORT_QUARANTINE_ENABLED` | No | Validation-only target for a retained private staging-copy policy. The current flow reads a stable owner-selected file into bounded memory and does not retain a raw copy. |
| `AMEX_IMPORT_DUPLICATE_WINDOW_DAYS` | No | Validation-only target for future fuzzy/date-window duplicate matching. Current import checks stable exact fingerprints within the selected account. |
| `AMEX_PDF_OCR_ENABLED` | No | Reserved and not connected. OCR is not implemented; text-layer PDFs only. Keep `false`. |
| `AMEX_PDF_OCR_ENGINE_PATH` | Conditional | Reserved and not connected. Setting a path does not enable OCR. |

Japan collection is official-file import only in the first release. These settings do not enable scraping or browser automation.

## Portfolio, reconciliation, FX, and alert variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_DEFAULT_PORTFOLIO_ID` | No | Local owner-controlled portfolio identifier used by the UI/demo. MCP callers still pass it explicitly. |
| `AMEX_BASE_CURRENCY` | No | ISO 4217 reporting currency. Original transaction amounts/currencies are never overwritten. |
| `AMEX_FX_RATE_SOURCE` | No | Validation-only `manual`/`provider` selection. Automated FX retrieval is not connected in the alpha; original-currency amounts remain canonical. |
| `AMEX_FX_PROVIDER_BASE_URL` | Conditional | Validation-only reviewed HTTPS endpoint, required when the reserved FX source is `provider`; setting it does not start network access. |
| `AMEX_FX_PROVIDER_API_KEY_REF` | Conditional | Validation-only protected-key reference for a future reviewed FX adapter. |
| `AMEX_FX_STALE_AFTER_HOURS` | No | Validation-only age target for future FX staleness warnings. |
| `AMEX_RECONCILIATION_TOLERANCE_MINOR_UNITS` | No | Validation-only global target. The current import preview uses its format-specific reconciliation behavior rather than this setting. |
| `AMEX_CATEGORY_MAPPING_FILE` | No | Optional absolute path to a strict UTF-8 JSON category-rule file, at most 1 MiB. Symlinks and files that change during reading are rejected. Its SHA-256 is bound to import preview/approval and audited; imported category/purpose columns are ignored. |
| `AMEX_ALERTS_ENABLED` | No | Enables review-only local anomaly generation. It never files a dispute or controls a card. |
| `AMEX_ALERT_LOOKBACK_DAYS` | No | Validation-only target for a future historical baseline window. |
| `AMEX_ALERT_AMOUNT_ZSCORE` | No | Validation-only target for a future statistical amount-deviation rule. |
| `AMEX_ALERT_NEW_MERCHANT_DAYS` | No | Validation-only target for a future new-merchant history rule. |
| `AMEX_ALERT_HIGH_VALUE_USD` | No | Direct USD high-value review threshold. It is evaluated only on USD transactions; no implicit FX conversion is performed. |
| `AMEX_ALERT_HIGH_VALUE_JPY` | No | Direct JPY high-value review threshold. It is evaluated in JPY without implicit currency conversion. |

The category-rule file has one versioned shape. Rules run by numeric `priority` and may match normalized descriptions or merchants; `businessPurpose` is optional. The import review shows the resulting category and purpose on every row, and changing the rule file after preview invalidates approval. Use category identifiers defined by the local category set, and keep the file free of account data and secrets. For example:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "synthetic-transit",
      "priority": 10,
      "match": { "kind": "description_contains", "value": "TEST RAIL" },
      "categoryId": "travel",
      "businessPurpose": "Synthetic test travel"
    }
  ]
}
```

Allowed `match.kind` values are `description_contains`, `description_prefix`, and `merchant_equals`. Review the resulting category and business-purpose suggestions in the import preview; a mapping rule does not make source data authoritative.

## Export variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `AMEX_EXPORT_REQUIRE_HUMAN_APPROVAL` | No | Must remain `true` in production. Approval is one-time, bound to the exact preview fingerprint and duplicate report, journaled durably, and consumed before atomic materialization. |
| `AMEX_EXPORT_DUPLICATE_WINDOW_DAYS` | No | Validation-only target; current durable duplicate history compares stable transaction fingerprints without a time-window filter. |
| `AMEX_EXPORT_RETENTION_DAYS` | No | Validation-only cleanup target. The app never deletes owner-created export packages automatically. |
| `AMEX_QBO_DEFAULT_FORMAT` | No | Validation-only UI-default target (`csv`, `qbo`, or `qfx`); the current UI requires an explicit format choice. It never calls QuickBooks Online. |
| `AMEX_MONEY_FORWARD_ENCODING` | No | Validation-only UI-default target. The current export form explicitly chooses UTF-8 with BOM or Shift-JIS/CP932 per package. |
| `AMEX_MONEY_FORWARD_LINE_ENDING` | No | Validation-only output-policy target; current generators apply their reviewed format-specific line endings. |

## Secret references and rotation

`wincred:<target>` is the documented reference grammar for operator-provided secrets. The production secret resolver must retrieve a Generic Credential for the current Windows user and return it only to the adapter that needs it. Internal OAuth tokens and the database key are instead encrypted with the app’s `safeStorage`/DPAPI boundary. Neither mechanism makes secrets safe from malware running as the same unlocked user.

Rotate provider client secrets at their source, update the corresponding Windows-protected entry, then restart the adapter. Account OAuth tokens are rotated/refreshed independently per authorization. Any tunnel credential belongs to the externally provisioned protected client profile and must be rotated using that exact client's authoritative instructions; the app neither accepts nor injects a raw tunnel secret. Revoking one authorization must not invalidate or merge any other account’s data. Never copy token caches, client profiles, or key envelopes into Git, tickets, logs, or diagnostic bundles.

## Configuration review checklist

1. Confirm the MCP host is exactly `127.0.0.1` and Windows Firewall has no inbound rule for the app.
2. Confirm demo mode, telemetry, crash reporting, and insecure storage are off for production.
3. Confirm every `_REF` value is a reference and not a secret.
4. Confirm the U.S. adapter is disabled until provider approval, read-only scopes, redirect URI, and data handling are reviewed.
5. Confirm tunnel organization/workspace associations grant only the intended owner/workspace access.
6. Confirm export human approval remains on and review target account/entity mappings before every export.
