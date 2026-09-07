# Implementation Plan

Status: first-release delivery plan
Target: Windows 11 x64, single local user

## Outcome

Deliver a signed, installable Windows tray application that can safely manage multiple separately authorized U.S. and import-only Japan Amex personal/company accounts, maintain an encrypted and source-attributed local store, answer only the approved read-only MCP queries, and create human-approved accounting import packages without posting them.

This is the historical risk-ordered delivery plan plus remaining production gates. The README is authoritative for current alpha behavior; production data remains prohibited until encryption, authorization isolation, parser safety, recovery, and remote-access gates are independently reviewed.

## Release scope

### Required for 1.0

- Windows 11 x64 installer and system-tray lifecycle.
- Single-user local configuration, encrypted database, Windows-protected secrets, schema migration, backup/restore documentation, and audit log.
- Multiple accounts and authorization bindings across U.S./Japan, personal/company, and legal entities.
- U.S. provider adapter interface plus one approved read-only consent/provider implementation, if provider authority and credentials are available.
- Official Japan CSV, Excel, QIF, and PDF import for explicitly fixture-tested variants; no scraping or credentials.
- Validation, idempotent import/sync, duplicate review, statement reconciliation, category mappings, business-purpose metadata, multi-currency reporting, and review-only anomaly alerts.
- Local portfolio configuration that retains source account/entity/country/currency/classification on all details and aggregates.
- Seven read-only MCP tools with explicit target, readiness checks, pagination, freshness, provenance, and negative isolation tests.
- Fully local MCP mode and an optional OpenAI Secure MCP Tunnel mode supervised by the tray app.
- QuickBooks Online CSV/QBO/QFX and Money Forward transaction-statement/CSV journal-or-ledger export packages, mapped per account/entity, with preview, duplicate detection, explicit approval, and no posting.
- Automated unit, property, integration, security, packaging, and end-to-end tests; user/admin/developer documentation; threat model and release evidence.

### Explicitly not in 1.0

- Payments, transfers, card controls, disputes, reward actions, or any issuer mutation.
- MCP-driven sync, consent, import, export, configuration, category changes, or alert acknowledgement.
- QuickBooks or Money Forward APIs and unattended posting.
- Browser automation/scraping or storage of Amex credentials.
- Shared users, hosted storage, cloud backup, or cross-device sync.
- Mobile/macOS support, enterprise fleet administration, or public plugin publication.
- Guaranteed fraud detection, automated accounting/tax decisions, or unsupervised OCR of unknown PDF layouts.

## Delivery principles

- Build command/query separation into module boundaries before adding features.
- Preserve raw source values and lineage; add corrections/derivations rather than overwriting facts.
- Make every account boundary testable with at least two same-shaped accounts from different grants/entities.
- Fail closed on unknown format, authorization ambiguity, target ambiguity, encoding loss, and reconciliation uncertainty.
- Bind human approvals to immutable digests of the exact import/export plan.
- Keep provider, parser, FX, export, and tunnel integrations behind replaceable ports with contract fixtures.
- Treat auditability, redaction, migration, installer behavior, and threat-model tests as product features.

## Phase 0 — decisions, repository, and safety rails

### Work

- Establish repository ownership, branch protection, review rules, issue templates, release tags, and a least-privilege CI identity.
- Commit only safe environment examples; ignore local databases, secrets, token caches, imports, exports, logs, build artifacts, and signing material.
- Enable dependency lock verification, secret scanning, license/dependency review, static analysis, tests, artifact checksums, and SBOM generation.
- Record decisions for the Electron security posture, encrypted database/key-vault mechanism, local transport, schema migrations, installer/signing, raw-file retention, FX source, and telemetry (default none).
- Select and approve a U.S. aggregation provider only after verifying Amex U.S. personal/company coverage, account-level identifiers, statement/transaction fields, supported read-only scopes, OAuth/token behavior, rate limits, retention/deletion, sandbox, and contractual authority.
- Obtain sanitized official Japan statement variants and published import specifications/samples for accounting targets. Never commit real customer files.
- Verify current Secure MCP Tunnel availability, authoritative client instructions, organization/workspace permissions, and network requirements for the intended OpenAI context; the public [custom MCP app guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta) does not by itself prove tunnel-client access.

### Exit evidence

- No secret or real financial data in Git history.
- Threat model reviewed; unresolved risks and owners recorded.
- Chosen encryption/vault libraries have a maintenance/security assessment and recovery design.
- Provider decision is documented, or the provider integration is explicitly feature-gated and the release is labeled import-only.
- Every external format has a source, fixture policy, and versioning strategy.

## Phase 1 — runnable local skeleton

### Work

- Create a Windows tray host with Open, Pause/Resume local services, Connected Mode, Status, and Exit actions.
- Build a sandboxed renderer and narrow typed IPC bridge. Add the initial views for Accounts, Portfolios, Imports, Exports, Sync, Alerts, and Audit.
- Define domain ports for storage, secret vault, provider, parser, FX, anomaly, exporter, audit, and MCP queries.
- Implement a demo-only in-memory repository with synthetic, clearly labeled U.S./Japan personal/company data.
- Register only the seven read-only MCP tools against the demo query service over stdio and optional loopback development transport.
- Make production-data paths refuse to start in demo/unprotected-storage mode.

### Exit evidence

- A clean Windows 11 machine can install/run the development build, see the tray icon, open the UI, query synthetic data locally, and exit without orphan processes.
- Renderer security settings and IPC allowlist have automated tests.
- No MCP call reaches a command-side interface.
- Demo mode and production mode are visibly and technically distinct.

## Phase 2 — local encrypted persistence and audit foundation

### Work

- Implement the schema in `DATA_MODEL.md` with transactional migrations and a schema-version table.
- Generate a random database master key, wrap it to the current Windows user, and store token/tunnel/database-key references through the reviewed Windows vault adapter.
- Use authenticated database/file encryption. Add key-version metadata, rotation, backup, restore, and unrecoverable-key-loss behavior.
- Apply private user ACLs and safe application-data paths; exclude data from search/indexing where practical.
- Implement append-only audit APIs, sequence/hash integrity verification, retention/rotation, and strict allowlist redaction.
- Add startup integrity checks and explicit recovery/read-only-safe mode.

### Exit evidence

- On-disk inspection finds no plaintext financial facts or secrets after clean shutdown.
- Another Windows user cannot open the vault/database through supported APIs.
- Crash, migration interruption, backup/restore, key rotation, wrong key, missing key, and audit-chain break tests pass.
- Logs, errors, environment dumps, and crash artifacts pass automated secret/financial-data scans.

## Phase 3 — account, entity, authorization, and portfolio configuration

### Work

- Implement Legal Entity, Account, Authorization Grant/Binding, Portfolio, and Portfolio Membership use cases.
- Require local opaque IDs; expose only masked display identifiers.
- Build U.S. authorization state machine and Japan import-only readiness state machine.
- Make account status, last successful sync/import, stale thresholds, errors, and reauthorization need visible in the UI.
- Allow owner-managed account class, entity, country, currency, display name, and business-purpose defaults with audit history.
- Add portfolio membership UI. Prevent a portfolio from becoming a source ledger or changing provider authorization.

### Exit evidence

- Two grants with similarly named accounts cannot cross-bind in tests.
- Removing an account from a portfolio immediately changes subsequent query snapshots without deleting source data.
- Transient provider errors never force reauthorization; revoked/unrefreshable grants do.
- Import-only accounts never request OAuth reauthorization.

## Phase 4 — Japan import pipeline

### Work

- Implement restricted staging, content sniffing, file/row/page/cell/archive limits, parser timeouts, and SHA-256 batch identity.
- Add versioned parsers for approved official Amex CSV, non-macro Excel, QIF, and text-based PDF variants. Reject macros, active content, encrypted files, external links, and unknown layouts.
- Preserve original values plus normalized dates, directions, minor-unit amounts, currency, merchant/description, statement identifiers, and source row/page locators.
- Build UI for account/period/currency confirmation, validation issues, reconciliation, exact/possible duplicates, and commit approval.
- Commit a confirmed import atomically; retrying the same digest is idempotent. Keep or purge raw files according to explicit local retention policy.
- Build a quarantined/manual-review path for PDF extraction ambiguity. Do not silently OCR or guess columns.

### Exit evidence

- Each supported variant has sanitized golden fixtures and round-trip normalized expectations.
- Malicious corpus and resource-exhaustion tests from `THREAT_MODEL.md` pass.
- File replacement after preview invalidates approval.
- Ambiguous account, period, sign, currency, duplicate, or reconciliation fails closed.
- A crashed import exposes no partial queryable transactions.

## Phase 5 — U.S. read-only provider integration

### Work

- Implement the approved provider adapter and sandbox contract tests without ever accepting Amex credentials.
- Launch consent in the approved browser flow; enforce state, PKCE where applicable, nonce where applicable, exact redirects, expiry, and one-time callback handling.
- Store tokens only through secret references. Request the minimum read-only scope and isolate refresh/revocation per grant.
- Discover accounts, require owner mapping confirmation, and validate each fetched record against grant/provider account binding.
- Implement bounded, incremental, idempotent sync with backoff, provider cursor/checkpoint, staging, schema validation, and atomic commit.
- Distinguish provider outage, rate limit, data error, consent revocation, and refresh failure. Never initiate reauthorization from MCP.

### Exit evidence

- OAuth attack and token-redaction tests pass.
- Sandbox revocation, rate limiting, pagination, partial provider failure, duplicate delivery, and schema drift tests pass.
- No password/security-answer field or storage path exists.
- One grant's failure leaves unrelated grants queryable.

If required external provider authority is unavailable, retain the provider port and synthetic adapter, disable real U.S. sync in production UI, and report the exact authority/credential blocker. Do not improvise scraping.

## Phase 6 — normalization, reconciliation, classification, FX, and alerts

### Work

- Apply one canonical direction/sign and minor-unit model while preserving source sign/text.
- Implement statement-total/balance/activity reconciliation with currency-specific tolerances and issue codes.
- Implement versioned category rules with deterministic precedence, owner overrides, and non-destructive reclassification previews.
- Store business purpose per transaction with account default as a suggestion, never an invisible fact.
- Integrate a selected FX source or owner-provided rate table behind a port; store rate/base/quote/date/source/version and label all converted totals derived.
- Implement deterministic first-release anomaly signals: new merchant, unusual amount relative to account history, rapid repeats, foreign/cross-border indicator, exact/near duplicate, and statement inconsistency. Calibrate per account and provide evidence/reason codes.
- Keep alert state changes in the desktop UI. No blocking, card action, dispute, or issuer report.

### Exit evidence

- Property/golden tests cover signs, zero-decimal JPY, rounding, FX direction, time zones, and aggregation attribution.
- Re-running a category/rate model creates new derivations without changing source facts.
- Portfolio totals cannot hide missing rates/accounts and cannot mix currencies without an explicit reporting currency.
- Alert explanations reproduce from stored evidence; copy and UI clearly say “review-only.”

## Phase 7 — production MCP contract and private connectivity

### Work

- Implement `MCP_TOOLS.md` exactly, including mandatory targets, bounded filters, stable output envelopes, opaque cursors, freshness/provenance, and error taxonomy.
- Resolve all targets/readiness states before opening a read snapshot. Default portfolio behavior is complete-or-error; partial results require explicit opt-in.
- Enforce database read transactions and module-capability separation. The only query side effect is a redacted access audit event/metric.
- Add response minimization and maximum row/byte/time/concurrency limits.
- Keep stdio/loopback fully local mode independently functional.
- Integrate a pinned/integrity-checked `tunnel-client`, started/stopped by the tray app, with vault-resolved runtime credential and loopback/stdio forwarding only.
- Add connected-mode UI showing enabled/disabled/running/error, target OpenAI organization/workspace context where safely available, last request, and a prominent privacy notice.

### Exit evidence

- Contract, fuzz, pagination, cursor, stale state, cross-account, portfolio-membership-race, and response-limit tests pass.
- A generated dependency/call graph plus code review shows no MCP-to-command path.
- Port scan and network capture show no inbound public listener and only expected outbound HTTPS when connected mode runs.
- Exiting/disablement terminates tunnel and local remote-facing service with no orphan; local mode still works.
- Tunnel permissions and configuration are verified against current official OpenAI documentation, and unavailable access fails with an actionable local-only fallback.

## Phase 8 — human-approved accounting export packages

### Work

- Implement owner-defined, per-account/legal-entity export profiles and versioned mapping snapshots.
- Generate an in-memory preview with included/excluded transactions, totals, currencies, categories/accounts, validation warnings, and duplicate candidates.
- Detect exact/possible duplicates within the batch, source/import history, and local prior-export manifests. State clearly that this cannot prove absence in an unconnected accounting ledger.
- Bind explicit approval to the exact preview digest; invalidate it on any data, mapping, selection, or duplicate-result change.
- After approval only, atomically materialize QuickBooks CSV/QBO/QFX or Money Forward transaction-statement/CSV journal-or-ledger packages.
- Apply target-specific sign, date, account, tax/category, delimiter, quoting, CRLF, formula-safety, and UTF-8/Shift-JIS behavior. Fail rather than silently replace unencodable text.
- Include a manifest with checksums, source account/entity, format/profile versions, selection, totals, encoding, duplicate decisions, and approval timestamp.
- Provide no upload, browser automation, API client, or “post” command.

### Exit evidence

- Files cannot exist before approval; stale/tampered approval cannot materialize.
- Golden imports validate against current QuickBooks and Money Forward documentation/test environments or documented manual fixtures.
- Re-export and duplicate cases are deterministic and reviewable.
- Mapping errors, multi-currency uncertainty, and encoding loss fail closed.
- The UI and docs make manual review/import responsibility explicit.

## Phase 9 — product hardening, installer, and release

### Work

- Finish tray/status/account/import/export/alerts/audit UX, accessibility, localization-ready strings, privacy-safe notifications, and actionable error recovery.
- Build NSIS installer for Windows 11 x64; test install path, per-user permissions, upgrade, repair, uninstall, retained-data choice, and no unexpected startup/network behavior.
- Code-sign executable and installer. Generate checksums, SBOM, release notes, dependency/security reports, and provenance evidence.
- Run performance tests on documented upper bounds and long-running stability tests across sync/import/query/tunnel cycles.
- Complete developer, user, environment, provider, import/export, backup/restore, privacy, security, incident, and troubleshooting documentation.
- Conduct an independent security review and threat-model reconciliation. Resolve or explicitly accept findings before production data.

### Exit evidence

- `verify`/CI passes from a clean checkout and a clean Windows test VM.
- No critical/high unresolved vulnerability; lower findings have owners and dates.
- Signed installer passes install/upgrade/uninstall and reputation/malware checks available to the project.
- Release candidate passes the definition of done below with reproducible evidence.

## Test strategy

### Unit and property tests

- Money direction, minor units, decimal serialization, rounding, FX conversion, category precedence, date/time zone boundaries.
- Authorization/readiness state transitions and reauthorization rules.
- Transaction fingerprints, exact/possible duplicate scoring, reconciliation, and alert reason generation.
- Encoding, quoting, formula-safety, QBO/QFX serialization, and manifest checksums.

### Contract tests

- Provider sandbox schemas, pagination, token refresh/revocation, and account binding.
- Every supported statement parser variant with sanitized fixtures and explicit parser version.
- MCP JSON schemas, annotations, output envelopes, errors, cursors, and maximums.
- QuickBooks and Money Forward golden files tied to the format/version evidence used.

### Integration tests

- Vault plus encrypted store; migration, key rotation, backup/restore, missing/corrupt key.
- Import staging through atomic commit and rollback.
- Sync staging through atomic commit and independent-grant failure.
- Portfolio query across entities/currencies with unavailable accounts/rates.
- Preview, approval digest, duplicate decision, and atomic export materialization.
- MCP local transport and tunnel-client lifecycle with a mock/private endpoint where official test access is unavailable.

### End-to-end Windows tests

- First run, tray startup, local-only operation, consent sandbox, import, portfolio, query, alert review, export, restart, upgrade, disconnect, delete, and uninstall.
- Standard user, multiple Windows user profiles, session lock/unlock, sleep/resume, offline/online, proxy/certificate error, and clock/time-zone change.
- Privacy-safe taskbar/tray notifications, recent files, logs, and crash handling.

### Security and adversarial tests

Use the complete abuse-case list in `THREAT_MODEL.md`. Add dependency/SBOM/secret scans, renderer/IPC testing, import fuzzing, cross-account negative tests, no-public-listener checks, and package signature verification to CI/release pipelines.

## Release stages

1. **Developer demo:** synthetic data only; local MCP; no real vault/provider/import claims.
2. **Import-only internal alpha:** encrypted store and reviewed Japan parsers; local MCP; no public distribution.
3. **Provider sandbox alpha:** approved U.S. provider sandbox, multi-grant tests, no production customer data unless security gates pass.
4. **Connected private beta:** Secure MCP Tunnel for approved testers, explicit privacy notice, target isolation and lifecycle evidence.
5. **Accounting export beta:** validated mappings/encodings, approval and duplicate evidence, still manual import only.
6. **1.0 release candidate:** signed installer, all supported real-data paths, independent review, migration/recovery and incident exercises.

No stage label may imply production security or external service availability that has not been verified.

## Decisions and external blockers to resolve

| Decision/blocker | Why it matters | Required resolution |
| --- | --- | --- |
| Approved U.S. aggregation provider and authority | Real collection cannot be built safely or lawfully from assumptions. | Named provider, contract/approval, sandbox/production credentials, exact scopes, U.S. personal/company coverage. |
| Provider account semantics | A consent can expose multiple cards/accounts. | Stable provider identifiers, independent local account binding, revocation behavior, statement coverage. |
| Encrypted database and vault implementation | Current scaffolds often persist plaintext SQLite or environment secrets. | Reviewed library/design, DPAPI/user binding, migrations, key recovery/rotation, independent tests. |
| Official Japan format variants | CSV/Excel/PDF layouts vary by locale/product/time. | Sanitized official fixtures, parser version detectors, ambiguity and deprecation policy. |
| PDF scope | Scanned/changed layouts can make extraction unsafe. | Supported text-layout list; quarantine/manual review; decide whether isolated OCR is post-1.0. |
| FX source and policy | Converted totals require provenance and dates. | Approved source, update method, offline/stale behavior, rate-date and rounding rules. |
| QuickBooks/Money Forward exact templates | Import requirements change and differ by workflow. | Current official samples/test imports, per-format mappings, encoding/date/sign evidence. |
| Code-signing and update channel | Windows trust and supply-chain integrity depend on it. | Certificate custody, CI signing process, update/no-update decision, revocation plan. |
| OpenAI tunnel access | Permissions/availability are external. | Target organization/workspace, tunnel roles, runtime key, tested tunnel-client version; local-only fallback. |
| Data/raw-file/export retention | Privacy, recovery, and deletion behavior must be predictable. | Owner-facing defaults, configurable periods, uninstall/backups semantics, legal review. |

## Definition of done

The first release is done only when:

- every required workflow operates from a signed installer on a clean supported Windows 11 VM;
- storage encryption and Windows-protected secret references are verified on disk and under failure/recovery;
- at least two separately authorized U.S. accounts and multiple import-only Japan accounts can coexist without cross-account leakage, or real U.S. support is explicitly feature-gated because the named external authority is unavailable;
- all supported official import variants validate, reconcile, deduplicate, and preserve source metadata with fixture evidence;
- portfolios aggregate only selected accounts and retain attribution and FX provenance;
- anomaly/fraud output is explainable, review-only, and never performs an issuer action;
- all seven MCP tools require explicit targets, check readiness, are bounded/read-only, and pass negative isolation/capability tests;
- local mode works with no tunnel, and connected mode uses only the supervised outbound Secure MCP Tunnel without a public listener;
- every accounting file is preceded by an in-memory preview, duplicate review, and digest-bound owner approval, and no accounting posting code exists;
- installer, migration, backup/restore, uninstall retention, logs/audit, threat model, privacy caveats, and incident response are documented and tested;
- repository history and packaged artifacts contain no real secrets, credentials, account data, statements, exports, or logs;
- release evidence records versions and review dates for the provider, parsers, export templates, dependencies, tunnel-client, and official OpenAI documentation.
