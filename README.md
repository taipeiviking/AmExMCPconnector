# AmEx MCP Connector

A Windows 11-focused, local-first desktop application for owner-controlled American Express financial data. It runs from the system tray, keeps credentials and data on one Windows installation, and exposes only seven explicitly scoped, read-only MCP tools.

> **Development status:** this is a runnable local alpha, not production financial software and not affiliated with American Express. Start with the synthetic test drive. Japan CSV/XLSX/QIF/text-PDF import and all six reviewed accounting-file formats are wired end to end, but official statement layouts and accounting import behavior can change and must be verified before relying on real data. U.S. use requires an independently approved provider and configuration; this repository does not include provider access or direct/live Amex connectivity. Code signing, a reviewed update chain, broader real-format fixtures, operational recovery, and production security review remain release gates.

## Installed the app? Start here

1. Open **Amex Local Finance Connector**. If the dashboard is hidden, use its Windows system-tray icon and choose **Open dashboard**.
2. On **Getting started**, choose **Start the safe test**. The seven-part check uses fake transactions in memory; it does not add an account, save a statement, open a sign-in page, or contact Amex.
3. When all seven checks pass, use **Start over**, choose a Japan personal or company path, and follow **Your plan**. Japan statement import is the path available for real local testing now.
4. Choose **Finish and add my Japan account**. The app opens **Accounts**, where you enter a nickname and owner/company label—not a card number or password.
5. On the new account card, choose **Choose statement**. The account is preselected and the app opens the visible **Official statement imports** review. Nothing is stored until you inspect the rows and choose **Approve reviewed rows and import**; **Cancel preview** stores no transactions.

U.S. choices remain disabled until the app's approved-provider readiness check passes. An unconfigured installation adds no U.S. account and opens no sign-in page. This app never asks for or stores an Amex password. See the [friendly first-use guide](docs/GETTING_STARTED.md); administrators can find optional provider configuration in [Windows setup](docs/WINDOWS_SETUP.md).

## What is implemented

- Electron/TypeScript Windows tray app with a context-isolated, sandboxed dashboard for accounts, owner-editable portfolio membership, imports, exports, sync/authorization status, review-only alert dispositions, audit, and private connection status.
- One connector with multiple separately authorized/import-only accounts; no global MCP enumeration and no implicit “current account.”
- Exactly seven MCP tools: `list_accounts`, `get_account_status`, `list_transactions`, `get_statement`, `get_portfolio_report`, `list_fraud_alerts`, and `explain_alert`.
- Mandatory `target` discriminator (`account` or `portfolio`) and authorization/readiness checks before financial reads.
- Streamable HTTP bound only to `127.0.0.1`, with host/origin, authentication, body-size, page-size, concurrency, timeout, and separate authenticated/failed-auth rate controls plus read-only MCP annotations. Packaged production keeps MCP disabled unless bearer authentication is explicitly configured.
- A sql.js/SQLite image encrypted as one AES-256-GCM envelope; its random data key is wrapped by Electron `safeStorage` (Windows DPAPI) and embedded as opaque ciphertext. There is no plaintext fallback.
- Typed financial domain, encrypted repository, durable redacted audit sink, exact decimal-string money model, reconciliation/category/portfolio/anomaly services, and explicit synthetic demo fixtures.
- Two-phase local Japan statement review and confirmed import for CSV, bounded `.xlsx`, QIF, and text-based PDF files. Before anything is committed, the UI shows every candidate row (up to 1,000), signed per-currency totals, duplicates, warnings, reconciliation, and the active category-mapping fingerprint, with explicit **Approve reviewed rows and import** and **Cancel preview** actions. Approval performs one atomic encrypted-store commit—never scraping or credential replay.
- QuickBooks CSV/QBO/QFX and Money Forward statement/journal/ledger package creation with local duplicate history, an exact preview fingerprint, one-time human approval, atomic destination writes, manifests, and checksums. No posting client exists.
- A normalized U.S. provider OAuth/read-only adapter with per-account encrypted token isolation and guarded HTTPS configuration. It remains disabled until the owner supplies an independently approved provider; it is not a built-in or direct Amex connection.
- A fail-closed, tray-supervised Secure MCP Tunnel path for an already provisioned protected client profile. It starts only when the hash-pinned executable, loopback endpoint, and reviewed non-secret arguments validate; no raw credentials are accepted in arguments or the process environment. Local-only mode remains fully usable.
- Automated unit/contract/security tests, Windows CI, unsigned NSIS installer packaging for local testing, environment specification, threat model, and phased implementation plan.

## Security boundary

```mermaid
flowchart LR
  ChatGPT[ChatGPT developer-mode app] <-->|organization/workspace scoped| Tunnel[OpenAI-hosted tunnel endpoint]
  Tunnel <-.->|intended private route; verify externally| Client[vetted tunnel client on this PC]
  Client -->|127.0.0.1 only| MCP[Read-only MCP adapter]
  MCP --> Guard[Target + authorization guard]
  Guard --> DB[(Encrypted local SQLite image)]

  UI[Windows tray desktop UI] --> Config[Consent, account and portfolio configuration]
  UI --> Import[Official statement import review]
  UI --> Export[Human-approved export packages]
  Config --> DB
  Import --> DB
  DB --> Export

  MCP -. no dependency .->|cannot call| Config
  MCP -. cannot call .-> Import
  MCP -. cannot call .-> Export
```

ChatGPT cannot directly reach a local server. Private connected mode therefore requires a workspace-authorized Secure MCP Tunnel and a vetted client/profile supplied through an authoritative deployment channel. The public OpenAI material currently available describes [custom MCP apps and their workspace controls](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta), but does not establish a generally available tunnel client or stable Windows CLI contract; this repository deliberately does not guess one. Local MCP remains available with the tunnel disabled. Never substitute a public listener, public port forward, or generic public reverse proxy.

Remote queries intentionally send the selected response to the chosen OpenAI product; “local-first storage” does not mean those selected results remain on the PC. Review workspace retention and data controls before connected use.

## Developer quick start on Windows 11

Requires Node.js 22.12 or newer.

```powershell
git clone https://github.com/taipeiviking/AmExMCPconnector.git
Set-Location .\AmExMCPconnector
npm ci
npm run verify
npm run dev:demo
```

`dev:demo` is an explicit synthetic-data mode. Use `npm run dev` for an empty encrypted local store. Runtime files default to `%LOCALAPPDATA%\AmexLocalFinanceConnector`, outside the repository.

For development configuration only:

```powershell
Copy-Item .env.example .env
```

Never place a real secret, token, Amex credential, account identifier, statement, database, log, or export in `.env` or this repository. Values ending in `_REF` are protected-secret references, never secret values. See [configuration](docs/CONFIGURATION.md) and [Windows setup](docs/WINDOWS_SETUP.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and start the empty local app. |
| `npm run dev:demo` | Build and start with synthetic in-memory accounts. |
| `npm run typecheck` | Run strict TypeScript checks. |
| `npm test` | Run the automated test suite. |
| `npm run build` | Compile and copy renderer/WASM assets. |
| `npm run verify` | Typecheck, run unit/contract tests, build, and smoke-test the Electron/IPC/MCP startup path. |
| `npm run package:win` | Create an unsigned NSIS installer under `release/`. |
| `npm run smoke:packaged` | Launch the unpacked production executable with isolated temporary data, verify encrypted startup with MCP safely disabled by default, and exercise its graceful shutdown path. Run after packaging. |

Unsigned installers are for local testing only. Production distribution needs protected code signing, release provenance, malware scanning, and a reviewed update process.

## Collection and export policy

- **U.S.:** the normalized adapter runs only with an owner-configured, independently approved consent-based read-only provider. Provider OAuth tokens are isolated per authorization. The app never asks for or stores an Amex password, one-time code, or security answer. No provider is bundled or endorsed, and configuration alone is not evidence of live Amex access.
- **Japan:** the local pipeline accepts owner-selected CSV, `.xlsx`, QIF, and text-based PDF exports. Its first phase shows all candidate rows up to the 1,000-row review limit plus signed totals, duplicate/warning/reconciliation results, and mapping/source fingerprints; only the separate **Approve reviewed rows and import** action can commit. **Cancel preview** discards the pending preview. No browser automation, scraping, OCR, or encrypted-PDF bypass is included. Verify each official layout before relying on it.
- **Portfolio:** in normal unlocked mode, the owner can rename the local portfolio and choose its member accounts with checkboxes. Selected personal/company accounts can be viewed together, but every transaction retains source account, legal entity, country, currency, class, and business purpose. A portfolio is an attributed view, not a merged ledger or synced object; removing membership does not delete an account or its data.
- **Accounting:** QuickBooks Online and Money Forward integration ends at reviewed local import-file generation. Duplicate detection and an exact, one-time approval precede atomic package creation; each package includes checksums and a manifest. The app never posts or uploads automatically, and local duplicate history cannot see entries created elsewhere in the accounting system.
- **Alerts:** an open anomaly/fraud signal can be marked **reviewed**, **dismissed**, or **flagged as suspicious** by the owner in the desktop UI. These are audited local review dispositions, not issuer fraud determinations or card/dispute actions. ChatGPT can read and explain alerts but cannot change their status.

## Documentation

- [Getting started on Windows](docs/GETTING_STARTED.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Read-only MCP tool contract](docs/MCP_TOOLS.md)
- [Data model](docs/DATA_MODEL.md)
- [Import and export specification](docs/IMPORT_EXPORT.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Environment and secret configuration](docs/CONFIGURATION.md)
- [Windows setup and Secure MCP Tunnel](docs/WINDOWS_SETUP.md)
- [Security reporting](SECURITY.md)

## Repository hygiene

This repository is public. `.gitignore` excludes all `.env` variants except `.env.example`, credential/token material, private keys, local databases and journals, real statement imports, exports, reconciliation outputs, and logs. Ignore rules are a last line of defense: inspect every staged diff and use only synthetic fixtures.

## License

[MIT](LICENSE)
