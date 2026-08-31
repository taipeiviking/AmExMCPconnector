# AmEx MCP Connector

A Windows 11-focused, local-first desktop scaffold for owner-controlled American Express financial data. It runs from the system tray, keeps credentials and data on one Windows installation, and exposes only seven explicitly scoped, read-only MCP tools.

> **Development status:** this is a security-oriented runnable skeleton, not production financial software and not affiliated with American Express. Use synthetic data only. The U.S. provider integration, production OAuth credential resolver, tray-supervised Secure MCP Tunnel lifecycle, draining/cancellation of in-flight reads and audit persistence during lock/delete, full Excel/PDF variants, durable/atomic export-package history and approval consumption, signed installer/update chain, and live-format accounting validation remain release gates.

## What is implemented

- Electron/TypeScript Windows tray app with a context-isolated, sandboxed dashboard for accounts, portfolios, imports, exports, sync/authorization status, alerts, audit, and private connection status.
- One connector with multiple separately authorized/import-only accounts; no global MCP enumeration and no implicit “current account.”
- Exactly seven MCP tools: `list_accounts`, `get_account_status`, `list_transactions`, `get_statement`, `get_portfolio_report`, `list_fraud_alerts`, and `explain_alert`.
- Mandatory `target` discriminator (`account` or `portfolio`) and authorization/readiness checks before financial reads.
- Streamable HTTP bound only to `127.0.0.1`, with host/origin, body-size, page-size, and rate controls plus read-only MCP annotations. The bearer-reference resolver and complete request/response/concurrency limits remain release gates.
- A sql.js/SQLite image encrypted as one AES-256-GCM envelope; its random data key is wrapped by Electron `safeStorage` (Windows DPAPI) and embedded as opaque ciphertext. There is no plaintext fallback.
- Typed financial domain, encrypted repository, durable redacted audit sink, exact decimal-string money model, reconciliation/category/portfolio/anomaly services, and explicit synthetic demo fixtures.
- CSV and QIF normalization plus format adapter boundaries for official Japan CSV/Excel/QIF/PDF exports—never scraping or credential replay.
- QuickBooks CSV/QBO/QFX and Money Forward statement/journal/ledger byte-generation seams with duplicate checks, digest-bound human approval, and process-lifetime replay rejection. Durable atomic materialization/history remains a release gate. No posting client exists.
- Automated unit/contract/security tests, Windows CI, NSIS installer scaffolding, environment specification, threat model, and phased implementation plan.

## Security boundary

```mermaid
flowchart LR
  ChatGPT[ChatGPT developer-mode app] <-->|organization/workspace scoped| Tunnel[OpenAI-hosted tunnel endpoint]
  Tunnel <-->|outbound HTTPS polling| Client[tunnel-client on this PC]
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

ChatGPT cannot directly reach a local server. Private connected mode uses the official [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), an outbound-only path while the app and client run. The local MCP mode remains available with the tunnel disabled. The app must never be exposed through a public listener, public port forward, or generic public reverse proxy.

Remote queries intentionally send the selected response to the chosen OpenAI product; “local-first storage” does not mean those selected results remain on the PC. Review workspace retention and data controls before connected use.

## Quick start on Windows 11

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

Unsigned installers are for local testing only. Production distribution needs protected code signing, release provenance, malware scanning, and a reviewed update process.

## Collection and export policy

- **U.S.:** only an approved consent-based read-only provider path may be implemented. Provider OAuth tokens are isolated per authorization. The app never asks for or stores an Amex password, one-time code, or security answer. The scaffold leaves the provider disabled.
- **Japan:** first release accepts only official owner-selected CSV, Excel, QIF, and PDF exports after the concrete variant has fixture-backed validation. No browser automation or scraping.
- **Portfolio:** selected personal/company accounts can be viewed together, but every transaction retains source account, legal entity, country, currency, class, and business purpose. A portfolio is an attributed view, not a merged ledger or synced object.
- **Accounting:** QuickBooks Online and Money Forward integration ends at reviewed import-file generation; the scaffold UI does not yet materialize packages. Duplicate detection and exact approval checks precede byte generation. The app never posts or uploads automatically.
- **Alerts:** anomaly/fraud signals are review aids, not fraud determinations. The app cannot block a card, control an account, or submit a dispute.

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
