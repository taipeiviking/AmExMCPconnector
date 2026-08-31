# Threat Model

Status: release-gating design document
Last reviewed: 2026-08-31
Method: asset/trust-boundary analysis with STRIDE-style threat enumeration

## Executive summary

This application concentrates high-sensitivity financial records and long-lived access tokens on one Windows computer. Its most important security properties are: secrets remain protected by the current Windows user's security boundary; financial facts remain bound to their source account; remote access exists only through an explicitly enabled private tunnel while the tray app is running; and MCP cannot mutate financial, account, or accounting state.

The design materially reduces cloud and credential risk, but “local-first” is not the same as invulnerable. Malware or an administrator controlling the signed-in Windows session can observe decrypted data and can potentially alter the program. Likewise, data intentionally returned to ChatGPT is no longer confined to local storage. Those are residual risks that the UI and documentation must state plainly.

This document describes required controls. A scaffold or demo build must not be assumed to implement them. Real provider tokens, statements, or account data are prohibited until the applicable launch gates are verified.

## Scope

Included:

- Windows tray process, renderer/UI, IPC boundary, local MCP server, and optional tunnel-client child process;
- local encrypted database, Windows-protected secrets, imports, exports, logs, and audit records;
- U.S. consent/provider flow and read-only synchronization;
- Japan CSV, Excel, QIF, and PDF import pipeline;
- normalization, reconciliation, categorization, FX conversion, and anomaly review;
- account/portfolio selection and every read-only MCP tool;
- installer, update path, dependencies, backups, deletion, and operational recovery.

External systems are modeled at their trust boundary, not internally: American Express, an approved U.S. aggregation provider, OpenAI/ChatGPT and Secure MCP Tunnel, QuickBooks Online import, Money Forward Cloud Accounting import, Windows/DPAPI, and certificate/update infrastructure.

Out of scope as a solvable application property:

- a fully compromised Windows kernel, administrator, or user session;
- cameras, physical coercion, or an already-unlocked computer used by another person;
- defects or misuse inside OpenAI, the aggregation provider, Amex, QuickBooks, or Money Forward beyond contract selection, minimization, validation, and incident response;
- guaranteeing that a transaction is legitimate, fraudulent, tax-deductible, or correctly classified by an accounting authority.

These conditions remain important residual risks and are not ignored in release messaging.

## Security and privacy objectives

1. **Secret confidentiality:** OAuth refresh/access tokens, provider client secrets if any, tunnel runtime keys, database keys, and recovery material are never persisted or logged in plaintext.
2. **Financial-data confidentiality:** local statements, transactions, alerts, mappings, and exports are encrypted at rest and disclosed only to the signed-in owner and explicitly invoked MCP queries.
3. **Source integrity:** every statement and transaction retains immutable source, account, legal-entity, country, currency, import/sync lineage, and parser/provider-version attribution.
4. **Target authorization:** no account or portfolio query can fall back to an implicit scope, cross an authorization binding, or broaden after validation.
5. **Read-only remote capability:** remote MCP code has no reachable command for payments, card control, disputes, configuration, import, export, or accounting posting.
6. **Owner-controlled egress:** the owner explicitly enables the tunnel, chooses targets in queries, selects import files, and approves an exact export batch before files are created.
7. **Safe failure:** invalid authentication, ambiguous mapping, parser uncertainty, reconciliation failure, or integrity failure fails closed without partially committed data.
8. **Useful accountability:** security and business-process events are locally auditable with sensitive-value redaction and tamper evidence appropriate to a single-device product.
9. **Data minimization:** no Amex password, full PAN, CVV, PIN, security answers, unnecessary provider response, or raw secret enters the data model.
10. **Recoverability:** an owner can understand stale state, revoke access, restore a supported encrypted backup, and distinguish source data from derived or estimated data.

## Assets

| Asset | Sensitivity | Required protection |
| --- | --- | --- |
| U.S. OAuth/provider tokens | Critical | Windows-protected vault, least scope, per-grant isolation, revocation |
| Database encryption key | Critical | Random generation, user-bound wrapping, no config/log exposure, rotation/recovery plan |
| OpenAI tunnel runtime credential and tunnel ID | Critical/high | Vault reference, least organization permission, child-process-only access, revocation |
| Normalized transactions/statements/balances | High | Authenticated encryption, account scoping, minimized MCP responses |
| Raw and staged statement imports | High | Private ACLs, parser isolation, retention controls, secure cleanup |
| Legal-entity and business-purpose metadata | High | Same controls as transactions; can reveal business relationships |
| Fraud/anomaly alerts and evidence | High | Same controls as transactions; guarded presentation and review-only semantics |
| Export packages and manifests | High | Explicit destination, atomic creation, safe encoding, checksums, retention warning |
| Account configuration and portfolio membership | High | UI-only mutation, audit, stable local IDs, validation |
| Category/FX/reconciliation derivations | Medium/high | Provenance, versioning, no overwrite of source facts |
| Audit log | High | Redaction, append-only logic, hash chaining, access control, bounded retention |
| Application/installer/update metadata | High integrity | Code signing, pinned origin, checksum/signature verification, rollback protection |

## Actors and threat agents

- The legitimate single Windows user, who can make mistakes or be socially engineered.
- Another person using the same unlocked Windows profile.
- A standard local user attempting to read another profile's files.
- Malware running as the application user, an administrator, or kernel-level code.
- A remote attacker probing a network listener or possessing leaked tunnel credentials.
- A malicious or compromised MCP caller able to invoke allowed tools.
- Prompt injection embedded in merchant descriptions, memo fields, filenames, PDF text, or provider data.
- A malicious statement file crafted to exploit a parser or exhaust resources.
- A compromised, incorrect, or overprivileged aggregation provider integration.
- A compromised dependency, build pipeline, installer, update service, or code-signing key.
- An honest-but-buggy parser, category rule, FX feed, duplicate detector, or export mapping.

## Trust boundaries

### TB-1: User and renderer to privileged main process

The renderer presents untrusted strings and user inputs. Only a narrow, typed, allowlisted IPC bridge may reach privileged services. No arbitrary filesystem, process, SQL, shell, URL, or credential operation crosses this boundary.

### TB-2: Application process to Windows and persistent storage

Decrypted records and keys exist in process memory. At rest, the database and secret store rely on Windows user identity, filesystem ACLs, authenticated encryption, and key wrapping. The Windows administrator boundary is not treated as hostile-resistant.

### TB-3: Selected statement file to import staging

CSV, Excel, QIF, PDF, filenames, archive structures, formulas, encodings, and embedded metadata are attacker-controlled. Parsing occurs before the file can be trusted as an Amex statement.

### TB-4: Application to U.S. provider/authorization endpoints

Tokens and read-only data cross TLS. Callback parameters, account identifiers, pagination, webhook/poll results, schemas, and provider errors are untrusted until correlated and validated.

### TB-5: MCP transport to query service

Tool name, target, filters, pagination cursor, and caller behavior are untrusted. Tool metadata is not authorization. The query service must enforce schema, target, readiness, bounds, and row predicates.

### TB-6: Local MCP/tunnel-client to OpenAI-hosted tunnel and ChatGPT

The official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) uses an outbound connection to reach a private MCP server without an inbound public listener. The tunnel still carries selected request and response data outside the computer. Organization/workspace association, tunnel permissions, runtime key handling, and the user's OpenAI data controls remain separate concerns.

### TB-7: Export service to destination files and accounting importers

After explicit approval, sensitive files leave the encrypted application store. Destination ACLs, removable media, cloud-synced folders, email, and accounting-import behavior are outside application control and must be warned about.

## Required baseline controls

### Identity, authorization, and account isolation

- Generate opaque local account and portfolio IDs; never accept provider IDs directly as MCP targets.
- Require a discriminated account-or-portfolio target in every tool call; reject missing and ambiguous scope.
- Resolve portfolio membership once per request against a consistent snapshot; apply non-null `account_id` predicates to every financial query.
- Keep provider grants and secret references separate. Validate that every provider record belongs to the expected grant and local account before commit.
- Use least-privilege, read-only provider scopes and independent revocation/reauthorization state per grant.
- Do not disclose the existence of out-of-scope IDs in errors.

### Secret and data protection

- Generate encryption keys with the operating-system CSPRNG and use a reviewed authenticated-encryption/database-encryption implementation.
- Wrap the database key to the current Windows user. Store tokens/keys in a Windows-protected vault or encrypted records; persist only opaque secret references in ordinary configuration.
- Apply private per-user ACLs to database, import staging, backups, logs, crash storage, and export staging.
- Zero or promptly release secret buffers where supported; never place secrets on command lines, environment dumps, URLs, or renderer IPC.
- Redact authorization headers, tokens, cookies, full account numbers, raw provider payloads, transaction details, and user-selected paths from logs by default.
- Disable or sanitize crash dumps that could contain decrypted data and secrets.

### Desktop and IPC hardening

- Enable Electron context isolation and renderer sandboxing; disable renderer Node.js integration and remote module behavior.
- Expose an allowlisted, versioned IPC API with schema validation on both sides.
- Use a restrictive CSP; prevent arbitrary navigation, popups, external protocol execution, and untrusted HTML injection.
- Open authorization pages only after origin allowlist validation and always show the destination host to the user.
- Hide sensitive notification content by default and clear clipboard data only if the app deliberately writes it.

### MCP and tunnel hardening

- Bind HTTP transport only to loopback or use stdio; reject non-loopback forwarded-host/origin patterns and defend against DNS rebinding/CSRF where HTTP is used.
- Register only the seven approved read tools and make the MCP process depend only on query interfaces.
- Mark each tool read-only, but enforce the boundary with module capabilities, database read transactions, code review, and tests.
- Bound dates, page sizes, response bytes, execution time, and concurrency; use opaque authenticated cursors.
- Start the pinned and verified `tunnel-client` only after explicit enablement. Terminate it with the tray host and revoke leaked runtime credentials.
- Do not log child-process environment or raw tunnel traffic.
- Audit tool, target hash, time, status, and row count—not returned financial payloads.

### Import and export hardening

- Check extension, magic bytes, MIME, structure, size, page/row/cell count, archive expansion ratio, parser timeout, and memory budget.
- Never execute macros, scripts, external links, formulas, embedded files, or PDF actions. Reject unsupported encrypted/macro-enabled files.
- Parse in a restricted worker where practical and pin parser versions.
- Treat formulas beginning with spreadsheet control characters as text on import and neutralize CSV/spreadsheet formula injection on export.
- Normalize Unicode and encoding deterministically, but preserve raw source values for audit.
- Require account/currency/period confirmation, reconciliation results, and duplicate review before commit.
- Build export preview in memory, bind approval to a batch digest, rerun duplicate checks, then create files atomically.
- Fail on unrepresentable Shift-JIS characters rather than silently replacing financial descriptions.

### Supply-chain and operational hardening

- Lock dependencies; scan production dependencies and packaged artifacts; create an SBOM for releases.
- Code-sign installer and executable; verify update signatures and origin; protect signing keys outside the repository.
- Test install/upgrade/uninstall on supported Windows 11 builds and document whether uninstall retains encrypted data.
- Keep application, Windows, parser, tunnel-client, and provider SDK versions supportable and patchable.
- Provide local security-status and revoke/disconnect actions that do not depend on MCP.

## Threat register

Ratings are qualitative. “Residual” assumes the listed controls are implemented and verified.

| ID | Threat and impact | Initial | Principal mitigations | Residual |
| --- | --- | --- | --- | --- |
| T-01 | Offline theft of database or computer exposes financial history. | High | Authenticated encryption, user-wrapped key, private ACLs, Windows device encryption guidance, locked session. | Medium: an unlocked/compromised user session can decrypt. |
| T-02 | Tokens or database key leak through `.env`, config, logs, crash dump, command line, or source control. | Critical | Vault references, startup secret scan, redaction tests, sanitized crash policy, repository scanning, no command-line secrets. | Low/medium: process-memory inspection remains possible. |
| T-03 | A renderer exploit obtains filesystem, vault, or process access. | Critical | Sandboxed renderer, context isolation, no Node integration, strict CSP, narrow schema-checked IPC. | Medium: privileged-process defects remain possible. |
| T-04 | OAuth login CSRF, callback interception, code replay, or malicious redirect binds the wrong grant. | High | State correlation, PKCE, nonce where applicable, exact redirect URI, one-time callback, TLS, system browser, timeout. | Low/medium: provider/OS/browser compromise remains. |
| T-05 | Application accidentally stores an Amex password or accepts a phishing credential field. | Critical | No password fields/interfaces, provider-only consent allowlist, UI tests, log scanning, security review. | Low: a malicious external page can still phish; show origin and educate user. |
| T-06 | Provider token/account confusion imports one card's records into another local account. | Critical | Per-grant binding, provider-account mapping confirmation, response correlation, account invariant constraints, reconciliation. | Low/medium: provider can return incorrect metadata. |
| T-07 | Revoked/expired consent is repeatedly retried or causes unnecessary reauthorization/phishing fatigue. | Medium | Explicit state machine, bounded refresh, distinguish transient errors, UI-only reauthorization. | Low. |
| T-08 | Crafted CSV/Excel/QIF/PDF exploits a parser or executes active content. | Critical | Magic/limit checks, no macros/formulas/actions/external links, restricted worker, patched parsers, adversarial corpus. | Medium: parser zero-days remain possible. |
| T-09 | Decompression bomb, huge PDF, pathological rows, or query exhausts memory/CPU/disk. | High | Size/expansion/page/row limits, timeouts, quotas, cancellation, staging cleanup, MCP response bounds. | Low/medium. |
| T-10 | File is changed between preview and commit. | High | Private staging copy, SHA-256 digest, open-by-handle/copy-on-select, bind confirmation to digest. | Low. |
| T-11 | CSV/Excel formula injection executes when an export is opened. | High | Escape/neutralize leading `=`, `+`, `-`, `@`, tab/CR as appropriate; format-specific tests; warning. | Low/medium: importer behavior varies. |
| T-12 | Missing/forged target or portfolio broadening leaks another account's data. | Critical | Mandatory target union, opaque IDs, consistent membership snapshot, row predicates, negative isolation tests. | Low. |
| T-13 | A supposedly read-only MCP tool reaches import/export/configuration/payment code. | Critical | Separate query module/database capability, exact allowlist, no command adapters, architectural and call-graph tests. | Low, subject to regression review. |
| T-14 | Stolen tunnel runtime key or mis-associated organization permits unauthorized queries. | Critical | Vault storage, least tunnel roles/associations, rotation/revocation, runtime-only child access, access audit, UI status. | Medium: legitimate OpenAI context compromise remains. |
| T-15 | Public listener, generic reverse proxy, or firewall rule accidentally exposes MCP. | Critical | stdio/loopback binding assertion, startup fail-closed, firewall/network tests, Secure MCP Tunnel only, no public proxy mode. | Low. |
| T-16 | Replay or cursor tampering retrieves data outside approved range. | High | TLS/tunnel protections, short-lived authenticated opaque cursors bound to tool/target/filter, request idempotence, limits. | Low. |
| T-17 | Prompt injection in merchant memo, filename, or PDF instructs ChatGPT or the parser to reveal/change data. | High | Treat all data as inert fields, structured outputs, no instruction interpretation, encode content, read-only capability boundary. | Medium: a model may still be influenced in narrative output, but cannot gain new tools. |
| T-18 | A legitimate broad query discloses more financial data to ChatGPT than the owner intended. | High | Explicit target/date filters, bounded defaults, field minimization, connected-mode notice, query audit, optional confirmation policy. | Medium: approved responses intentionally leave the device. |
| T-19 | Full financial payloads enter logs, telemetry, analytics, or support bundles. | High | No remote telemetry by default, structured allowlist logging, redaction, local support-bundle preview, automated secret/PII tests. | Low/medium. |
| T-20 | Tampering with transactions, mappings, reconciliation, or alert evidence produces false reports. | High | Immutable source rows, lineage, constraints, authenticated encryption, transactional writes, audit chain, reconciliation. | Medium: local admin can rewrite application and verification state. |
| T-21 | Duplicate detection drops a legitimate transaction or fails to catch a duplicate. | High | Exact IDs/digests first, scored candidates separate from decisions, owner review for ambiguity, reversible linkage. | Medium. |
| T-22 | Wrong entity/account/export mapping causes incorrect accounting import. | High | Per-account/entity profiles, preview totals, batch digest approval, mapping snapshot, validation, no automatic posting. | Medium: human import can still be wrong. |
| T-23 | Prior-export duplicate detection gives false assurance about the target accounting system. | High | Clearly scope detection to local history/input, include manifest, permit target-history comparison only when supplied, warn before export. | Medium/high: no live target ledger verification. |
| T-24 | Silent Shift-JIS replacement, date ambiguity, decimal rounding, or sign inversion corrupts output. | High | Strict codecs, locale-specific fixtures, integer minor units/decimal math, explicit direction, round-trip/golden tests, fail closed. | Low/medium. |
| T-25 | FX or category data is stale/incorrect and cross-currency/business totals mislead. | High | Preserve originals, provenance/version/time, explicit reporting currency, “estimated/derived” labels, override and review. | Medium. |
| T-26 | Fraud/anomaly model misses fraud or creates harmful false accusations. | High | Review-only language, explainable factors, no card/dispute action, confidence/limitations, owner verification with issuer. | High for guarantee: the tool cannot guarantee detection. |
| T-27 | Export, backup, or raw import in a synced/shared folder leaks data. | High | Destination warning/detection where feasible, explicit selection, default private directory, encryption option for backups, retention UI. | Medium: owner can deliberately copy files. |
| T-28 | Audit log is erased or forged to hide access. | High | Append-only API, sequence/hash chain, restricted ACL, integrity verification, backup option, alert on discontinuity. | Medium/high: no independent remote anchor; admin can forge. |
| T-29 | Compromised dependency, installer, update, or signing key executes code as the user. | Critical | Lockfile, SBOM, scans, provenance, signed artifacts/updates, protected signing, staged rollout, rollback controls. | Medium. |
| T-30 | Sensitive data appears in tray notifications, recent-file lists, clipboard, thumbnails, or Windows search index. | Medium | Generic notifications, private directories, no automatic clipboard use, file attribute/indexing guidance, UI privacy review. | Low/medium. |
| T-31 | Clock rollback or timezone confusion changes token, statement, audit, or duplicate logic. | Medium | Store UTC instants plus source local date/zone, monotonic durations for timeouts, detect major clock changes, explicit period rules. | Low/medium. |
| T-32 | Disconnect/uninstall is mistaken for secure deletion, leaving tokens or data behind. | High | Separate revoke/disconnect/delete semantics, deletion preview, vault cleanup, uninstall retention disclosure, verification. | Medium: SSD/backup remanence can persist. |

## Abuse cases and security tests

The automated suite must include at least:

- requests with no target, both target kinds, malformed/foreign IDs, stale portfolio cursors, and ID enumeration attempts;
- portfolio queries where one account is revoked, unavailable, import-only, or removed during a request;
- proof that every MCP entry point lacks import, export, config, authorization-launch, payment, dispute, and card-control dependencies;
- OAuth state/PKCE/callback replay, wrong-account callback, expired state, and token-redaction cases;
- malicious CSV formulas, mixed encodings, overlong fields, duplicate headers, Unicode confusables, and delimiter attacks;
- Excel macros/external links, archive bombs, excessive worksheets/cells, and disguised file types;
- malformed/cyclic/oversized PDFs, embedded actions/files, OCR ambiguity, and parser timeout;
- import file replacement after preview, crash during commit, and retry/idempotency behavior;
- exact and near duplicate transactions across files, providers, accounts, currencies, and prior export batches;
- sign, decimal, rounding, timezone, leap-day, JPY/zero-decimal, UTF-8, and Shift-JIS golden cases;
- formula-safe QBO/CSV and Money Forward outputs with checksum and mapping snapshots;
- tunnel disabled/stopped/restarted, child crash, leaked-key revocation, loopback-binding assertion, and no-inbound-port checks;
- log, audit, crash, environment, error, and support-bundle secret/financial-data scanning;
- renderer XSS, navigation, IPC fuzzing, CSP enforcement, and external-protocol handling;
- database ciphertext-at-rest checks, wrong-Windows-user access, key loss, backup/restore, migration interruption, and audit-chain discontinuity.

## Privacy and financial-data caveats

- The database is local, but MCP responses intentionally sent through Secure MCP Tunnel are processed outside the computer by the selected OpenAI product. The owner must review applicable OpenAI workspace, retention, and data-control settings. This design does not make remote query results “local-only.”
- The U.S. aggregation provider will necessarily process consent and account data. Provider selection, user disclosures, retention/deletion, subprocessor review, breach handling, and regional availability require legal and security due diligence.
- Imported statements and exported accounting packages are highly sensitive. Once copied, emailed, placed in a cloud-synced folder, or imported elsewhere, this application cannot enforce their retention or access controls.
- Store only masked account identifiers such as last four digits when display requires them. Avoid PAN and never store CVV, PIN, or passwords. This threat model is not a PCI DSS, SOC, privacy-law, or other compliance certification.
- Reconciliation reduces errors but cannot establish issuer truth. Category, business-purpose, tax, FX, anomaly, and fraud outputs are derived aids requiring human review.
- A “fraud alert” is a local review signal, not an issuer fraud notice. The owner should use official Amex channels to verify activity. The app must not imply that absence of an alert means an account is safe.

## Residual-risk statement

The following cannot be eliminated by this architecture:

1. A compromised administrator, Windows kernel, or unlocked user session can access decrypted data and impersonate the owner.
2. Selected MCP response data leaves the local trust boundary, and a legitimate caller may request sensitive but authorized data.
3. Providers and external products can be unavailable, compromised, wrong, or subject to policy changes.
4. Parsers and dependencies can contain unknown vulnerabilities despite isolation and patching.
5. Locally anchored audit evidence cannot prove integrity against a determined administrator.
6. Duplicate, accounting, FX, category, and fraud analysis can be wrong and requires human verification.
7. Deleted data can persist in backups, filesystem snapshots, SSD behavior, crash artifacts, or copies outside the app.

The release UI and documentation must not obscure these limitations.

## Incident response outline

For suspected credential or data compromise:

1. Stop connected mode and terminate `tunnel-client`.
2. Revoke/rotate the affected OpenAI tunnel runtime credential and reduce tunnel associations if needed.
3. Revoke affected provider consents using official provider/issuer mechanisms; do not trigger unrelated account reauthorization.
4. Disconnect network collection, preserve a redacted copy of local audit/integrity evidence, and record system time.
5. Verify executable/installer signatures, dependency integrity, database/audit integrity, and recent exports/imports.
6. Rotate local database/secrets keys after the cause is contained; invalidate old encrypted backups as policy requires.
7. Notify affected parties according to provider contracts and applicable law with qualified counsel.
8. Re-enable one authorization and the tunnel only after root cause, patch, and validation are complete.

## Release security gates

No production-data release until all are true:

- an approved U.S. provider and exact least-privilege scopes are documented;
- at-rest encryption and Windows-bound secret storage pass independent review and recovery tests;
- all renderer/IPC, import-parser, target-isolation, MCP read-only, tunnel, logging, and export tests pass;
- the tunnel-client version and official OpenAI setup/permission requirements are verified against current documentation;
- supported Japan statement variants have sanitized golden fixtures and ambiguity/reconciliation behavior;
- installer/executable are signed, dependencies are scanned, an SBOM exists, and update behavior is defined;
- privacy, provider, financial-accuracy, alert, backup, delete/uninstall, and remote-query disclosures are included in the product;
- a documented manual security review finds no unresolved critical/high issue or records explicit owner acceptance with a remediation date.

Review this threat model whenever a provider, file parser, MCP tool, transport, export format, encryption mechanism, installer/update path, or data-retention behavior changes, and at least once per release.
