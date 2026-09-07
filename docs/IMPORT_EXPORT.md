# Import and Export Specification

Status: implemented local-alpha workflow plus production contract
Scope: desktop UI only; no MCP import/export and no accounting posting

The current alpha wires the owner-selected desktop workflow end to end. Japan CSV, bounded `.xlsx`, QIF, and text-based PDF files are parsed locally and bound to a selected account. Import is deliberately two-phase: the first action builds a review screen with every candidate row (up to 1,000), signed per-currency totals, warnings, duplicate and reconciliation results, and mapping/source fingerprints; only a separate explicit approval can commit the still-matching preview. Six accounting formats can be previewed and created in an explicit destination with a fingerprint-bound one-time approval, duplicate history, atomic writes, manifests, and SHA-256 checksums: QuickBooks CSV/QBO/QFX and Money Forward statement/journal/ledger CSV. The app has no accounting posting or upload client.

This is not certification of every official Amex layout or every current accounting import variant. The requirements below remain the production security and accuracy contract; real-format fixtures, target-product test imports, recovery testing, and release review must continue before production use.

## Core boundary

Imports and exports are privileged local commands owned by the Windows desktop application. The MCP server cannot select files, trigger a sync, change a mapping, approve a batch, create a package, reveal a package path, or send data to an accounting service.

The application has no QuickBooks Online or Money Forward Cloud Accounting posting client. It creates local import packages only after the owner reviews and approves the exact batch. Manual import into the target product remains a separate human action.

## Supported collection paths

| Region/source | First-release path | Credentials | Network behavior |
| --- | --- | --- | --- |
| U.S. Amex personal/company | Approved aggregation/provider consent with read-only scope | Provider/OAuth tokens in Windows-protected vault; never Amex passwords | Bounded provider sync initiated by desktop workflow/schedule, never by MCP |
| Japan Amex personal/company | Official owner-exported CSV, Excel, QIF, or PDF statement | None; never Amex credentials | No network required for parsing/import |

Unsupported collection paths include website scraping, browser automation, screen reading, password replay, email scraping, unofficial intercepted APIs, and owner-entered Amex usernames/passwords.

## Import state machine

```text
selected -> staged -> parsed -> validated -> awaiting_review -> committed
              |         |          |              |
              +-------> failed <----+--------------+
                                      -> rejected
```

- **Selected:** owner chooses one file and an intended local account in the desktop UI.
- **Staged:** app makes a private local snapshot and computes a content digest.
- **Parsed:** a versioned parser emits raw and normalized staging rows.
- **Validated:** structural, account, date, money, duplicate, and reconciliation checks finish.
- **Awaiting review:** UI shows the immutable batch digest, totals, issues, and proposed changes.
- **Committed:** owner confirmation still matches the staged digest and all committed rows are written atomically.
- **Failed/rejected:** no staging row becomes a queryable transaction.

No live data is updated during preview. A file modification, mapping change, account change, parser-version change, or validation-result change invalidates confirmation.

### Current alpha two-phase review screen

1. **Choose statement and build preview** reads the owner-selected file, validates its exact target account and format, and creates an expiring in-memory approval candidate. It does not commit transactions.
2. The preview table shows every candidate normalized row—not a sample—with source row, date, description, signed amount/currency, category, and business purpose. The first-release screen accepts at most 1,000 candidate rows; a larger file fails with a request to split it into smaller reviewed periods rather than hiding rows.
3. The same screen shows signed totals separately by currency, transaction count, exact duplicate count, the complete parser-warning list, reconciliation status/difference, local mapping match count, the category-rule file fingerprint when one is active, the source-file fingerprint, and the preview expiry time.
4. **Cancel preview** discards the pending candidate and writes no ledger records. **Approve reviewed rows and import** is a separate action that rechecks the preview/account/mapping baseline and then performs one atomic encrypted-store commit. An expired or changed candidate must be previewed again.

Only active Japan statement-import accounts selected in the owner’s current local portfolio are available as import targets. In normal unlocked mode, the owner can rename that portfolio and edit membership with account checkboxes under **Portfolio → Save portfolio selection**. Removing membership changes the view and future scoped workflows; it does not delete the account or its encrypted history.

## Secure file intake

### Selection and staging

1. Use the native file picker. Do not accept arbitrary paths from renderer HTML, MCP, URLs, or clipboard automation.
2. Resolve the chosen file once and copy it into a private per-user staging directory with a random name. Do not continue reading the external path after staging.
3. Record SHA-256, original base filename (sanitized for display), size, detected type, selected account, selection time, and parser candidate. The full path is not logged.
4. Require extension, magic bytes, container structure, and declared parser to agree.
5. Apply configured limits before/during parsing: total bytes, archive expansion ratio, worksheets, rows, columns, cells, PDF pages/objects, field length, recursion, memory, and elapsed time.
6. Parse in a restricted worker/process where practical. The parser has no provider token, tunnel credential, export permission, shell access, or outbound network requirement.

### Active-content policy

- Never execute spreadsheet formulas, macros, scripts, external data connections, add-ins, links, or embedded objects.
- Reject macro-enabled or protected/encrypted Excel workbooks unless a future, separately reviewed data-only extractor can prove active content is inert. An old binary `.xls` variant is supported only when an official fixture and reviewed parser can safely extract values without macro execution.
- Never execute PDF JavaScript/actions, launch links, extract/execute attachments, or honor embedded network references.
- QIF and CSV fields are data, never commands or paths.
- Formula-looking cell content is stored as text/raw data; it is not recalculated.

### Raw-file retention

The owner chooses a documented policy:

- **Purge after commit (recommended default):** securely remove the private staged copy after commit/failure cleanup while keeping file digest, parser/version, raw extracted field values needed for lineage, and audit metadata.
- **Retain encrypted:** store the raw file inside application-managed encrypted storage for later verification.

The UI must explain that filesystem/SSD/backups may retain deleted copies and that the original selected file remains outside app control. Raw files are never committed to Git, logs, support bundles, or MCP responses.

## Format adapters

Each adapter has a unique parser ID and semantic version. A layout/header/date/encoding change produces a new parser version and fixtures; it must not be accepted by a “close enough” parser silently.

### CSV

- Detect BOM/encoding from an allowlist and let the user confirm when ambiguous.
- Detect delimiter/quote convention from a bounded sample, then require consistent row shape.
- Preserve raw header names and raw cell text.
- Reject NULs, control-character abuse, oversized fields, inconsistent quoting, and unexpected trailing data.
- Normalize Unicode deterministically without losing the raw value.
- Treat leading `=`, `+`, `-`, `@`, tab, and carriage return as untrusted text for downstream spreadsheet safety; a negative numeric field is parsed only in an expected money column under the selected schema.

### Excel

- Support only fixture-reviewed official Amex data layouts in `.xlsx` and, if required, reviewed data-only `.xls` variants.
- Select worksheet by exact versioned expectations, not the first sheet blindly.
- Read cached/displayed values as defined by the parser contract; never evaluate formulas.
- Reject unexpected macros, external links/connections, hidden data outside the accepted layout, excessive workbook structures, and ambiguous merged headers.
- Preserve workbook/sheet/parser lineage without retaining author/company metadata unless necessary.

### QIF

- Require a known statement/account-type header and recognized field codes.
- Parse record terminators and multiline fields with strict limits.
- Make date-format selection explicit (`MM/DD/YYYY`, `DD/MM/YYYY`, or locale-specific official variant); ambiguous dates fail review.
- Keep splits/categories as source hints. They do not override owner category rules automatically.

### PDF

- Support only sanitized, fixture-tested official Amex statement layouts.
- Extract from a text layer in a restricted parser. Validate expected issuer/layout markers, account mask, statement period, currency, page sequence, transaction table, and summary totals.
- Keep page number and bounded source-text locator for every extracted field.
- Quarantine any row with uncertain column alignment, wrapped-description ambiguity, missing glyphs, or summary mismatch.
- A scanned/image-only PDF is not guessed. If isolated OCR is later included to meet a verified official variant, every recognized row remains uncommittable until owner review and statement reconciliation succeed; OCR engine/version/confidence are stored in lineage.
- A PDF that merely resembles a statement is not treated as issuer-authenticated. Official source and reconciliation are still owner responsibilities.

### U.S. provider records

- Validate provider response schema/version, grant, provider-account ID, pagination/cursor, currency, timestamp, and status before staging.
- Store the provider's stable transaction/statement identifier encrypted or as a protected source reference; expose only local IDs.
- Treat pending and posted versions as related versions, not automatically separate expenses.
- Retry idempotently with bounded backoff. Rate limit/outage does not become reauthorization unless the provider explicitly requires new consent or refresh is irrecoverable.
- Preserve source response fields needed for audit/reconciliation but do not retain unnecessary personal/provider metadata.

## Normalized field requirements

This section describes the fuller 1.0 evidence model. The runnable alpha retains the source account/entity/country/class/currency, signed amount, dates, description, optional merchant country, statement/file fingerprint, import fingerprint, category/purpose result, and timestamps in its encrypted transaction model. It does not yet retain every source cell, pending/supersession lineage, or source-category text; never infer those fields from an alpha export.

Every committed transaction must resolve or explicitly mark review state for:

- local source `account_id`;
- source authorization grant/import-only binding;
- legal entity at collection time;
- country (`US` or `JP` in 1.0);
- account class (`personal` or `company`);
- source and normalized transaction date, plus posted instant when available;
- source currency and normalized non-negative minor-unit amount plus debit/credit direction;
- original description/merchant text and normalized search text;
- statement/provider/import lineage and source row/page locator;
- source category, local category assignment/version, and owner override if any;
- business-purpose value/review state;
- pending/posted/superseded status;
- exact/possible duplicate state;
- reconciliation state.

Missing optional data remains `null`/unreviewed. The app must not fill legal entity, business purpose, category, merchant, currency, or dates from an unrelated account or silently invent a value.

## Validation and reconciliation

### Structural validation

- Recognized issuer/export format and exact parser variant.
- Required headers/sections/record markers.
- Valid field counts, types, lengths, encodings, dates, currency codes, and decimal scales.
- Consistent statement/account mask, period, and currency.
- Monotonic page/record boundaries where the format promises them.

### Account binding

The owner selects the destination account first. Parsed masks/entity/country/currency are compared with its configuration. Any mismatch requires a deliberate mapping correction in the desktop UI and a new validation run. An import can never auto-create or switch an account merely because a similar mask/name appears.

### Money and sign validation

- Parse source amount and direction under the exact format contract.
- Convert to non-negative integer minor units using the currency exponent and checked decimal arithmetic.
- Record normalized debit/credit separately from the raw source sign/type.
- Reject excess precision, invalid thousands/decimal separators, contradictory credit markers, overflow, `NaN`, and scientific notation unless the official format explicitly requires it.
- Use currency-specific, documented reconciliation tolerances; never hide a rounding difference in a transaction.

### Statement reconciliation

When the source provides enough information, calculate and store:

- opening balance;
- total debits/charges;
- total credits/payments/refunds;
- fees/interest/adjustments when separately reported;
- computed and reported closing balance;
- transaction count and skipped/quarantined row count;
- difference, tolerance, and issue codes.

`reconciled` requires the exact documented equation within tolerance and no unexplained row loss. Otherwise the batch is warning/failed and needs owner review. Imported data can be retained with an explicit unresolved status only under a deliberate policy; portfolio/report/export output must label or exclude it according to the owner's choice.

## Duplicate and version handling

Duplicate detection never crosses account boundaries merely because amount/date/merchant match.

Use evidence in this order:

1. exact provider transaction/statement ID under the same grant/account;
2. exact raw file digest plus source row/page identity under the same account;
3. stable normalized fingerprint under the same account: date(s), direction, minor units, currency, normalized description, and statement context;
4. scored possible match using bounded date/description/amount rules;
5. owner decision for ambiguous candidates.

Exact duplicates are idempotent and reference the existing source fact. Possible duplicates are presented side by side; they are not silently discarded or merged. A pending record that becomes posted is linked/superseded using provider evidence and reversible heuristics. Corrections create new source versions and lineage rather than editing history in place.

## Category, business-purpose, and FX derivation

Current alpha behavior is intentionally narrow:

- Statement/QIF category and business-purpose fields are untrusted source metadata and are ignored as owner classifications; the parser emits a warning when they appear.
- An optional owner-authored version-1 mapping file applies deterministic priority rules during the import preview. The review table shows the resulting category/purpose for every row, and approval is bound to the file's SHA-256; changing it requires a new preview.
- The account's owner-controlled business-purpose default may be inherited when no reviewed rule supplies a value.
- Original amounts and currencies remain canonical. Reports group exact totals by currency and perform no implicit FX conversion in the current alpha.

Versioned post-import reclassification, per-row owner overrides, source-category lineage, and provenance-backed FX conversion remain later release work and must not be inferred from the current UI.

## Review-only anomaly/fraud alerts

After commit, deterministic/versioned analyzers may create review signals such as unusual amount relative to that account's history, new merchant, rapid repeats, foreign/cross-border indication, near duplicate, or reconciliation inconsistency.

Alerts retain source account, transaction, model/rule version, evidence, comparison window, and reason codes. They do not change a transaction, block a card, contact Amex, or start a dispute. For an open signal, the desktop UI lets the owner choose **Mark reviewed**, **Dismiss**, or **Flag as suspicious**. These are audited local review dispositions only: even “flagged as suspicious” is not an issuer fraud finding and triggers no external/card/dispute action. ChatGPT may list or explain the stored signal but cannot change its disposition. “No alert” is never presented as proof that activity is legitimate.

## Export principles

1. Export is initiated from the desktop UI only.
2. A target profile belongs to one local account and legal entity, or to an explicitly partitioned group whose output is split by account/entity as the target format requires.
3. Original and derived data are selected from a consistent local snapshot.
4. Preview exists only in application memory/UI before approval; no destination or temporary export file is created yet.
5. Duplicate detection and all validation finish before approval.
6. Approval is explicit and bound to an immutable digest of selection, source versions, mappings, duplicate decisions, encoding, format, totals, and warnings.
7. Immediately before materialization, the service revalidates that digest in a transaction. Any change invalidates approval.
8. Only after valid approval does it write a temporary file in the selected destination, verify bytes/checksum, and atomically rename to final package.
9. The service never uploads, posts, emails, or opens an authenticated accounting session.

## Export state machine

```text
draft -> preview_validated -> awaiting_approval -> approved -> materializing -> created
           |                       |                  |
           +-> invalid             +-> invalidated    +-> failed
created -> superseded (a later corrected package; original manifest remains)
```

An `approved` record is not proof of accounting import. A `created` record means only that a local package passed application checks. The application does not claim `posted`, `accepted`, or `reconciled_in_target` without owner-supplied evidence; 1.0 has no target-system connection.

## Export profiles and mapping

Each versioned `ExportProfile` includes:

- target family and format/version;
- local account and legal entity;
- target account/card/accounting identifiers entered by the owner (masked in general UI/logs);
- date range/selection rules and pending/unreconciled policy;
- sign/direction and transaction-type mapping;
- local category/business purpose to target account/tax/memo mappings;
- currency and multi-currency policy;
- date format, delimiter, quote, line ending, text encoding, BOM, and newline behavior;
- description/payee/reference length and sanitization rules;
- stable transaction ID policy where the format supports it;
- profile version, creator/update time, and audit lineage.

Profiles are never mutated by MCP. Changing a profile creates a new version for later batches and cannot alter an existing package manifest.

## QuickBooks Online packages

First release can materialize owner-selected transaction import packages in:

- CSV;
- QBO;
- QFX.

The exact field set, headers, account/card mapping, dates, signs, encoding, and supported transaction types are versioned against current QuickBooks import evidence and golden test imports. Do not assume that one template works for every QuickBooks account type or locale.

Where QBO/QFX supports a stable financial-institution transaction identifier, derive a deterministic non-secret identifier from the local account namespace and immutable source identity so re-created packages do not invent a new identity. Never embed tokens, full PAN, database IDs with security meaning, or raw provider credentials.

CSV values are quoted/escaped and protected from spreadsheet formula injection. A description that begins with spreadsheet control syntax remains literal data. The manifest states the chosen encoding and whether a BOM is present.

## Money Forward Cloud Accounting packages

First release can materialize owner-selected packages for the applicable supported workflow:

- transaction statement import;
- CSV journal import;
- CSV ledger import.

Each format has a separate versioned mapping/template. Account/entity, debit/credit account, subaccount, department/business purpose, tax category, currency, memo, date, and identifier fields are mapped only when the selected template supports them. Missing required mappings block approval.

Encoding is an explicit profile field:

- use UTF-8 (and BOM only when the current template requires/accepts it) for a UTF-8 target;
- use strict Shift-JIS/Windows-31J only for a target/template that requires it;
- preflight every string and fail approval/materialization when characters are unrepresentable;
- never replace text with `?` or silently normalize away legally/accounting-significant text;
- use the exact target delimiter, quote, CRLF, header, and date conventions established by golden tests.

If a transliterated/shortened memo is desired, show original and proposed output in preview and require an owner-approved mapping rule. Preserve the original locally.

## Duplicate detection before export

The export preview checks:

- duplicate source transaction IDs within the selection;
- pending/posted/superseded versions;
- exact/possible normalized duplicates under the same account;
- transactions already present in a prior locally created export manifest for the same target profile;
- stable QBO/QFX/import identifier collisions;
- owner-supplied target-history file, if a future reviewed comparison importer is explicitly invoked.

Each candidate is `exclude`, `include_with_warning`, or `needs_owner_decision`; default ambiguous behavior is `needs_owner_decision`. Decisions are part of the approval digest and manifest.

This is not a guarantee that the transaction is absent from QuickBooks or Money Forward. The app has no live target ledger and cannot detect transactions imported by another computer, user, file, feed, manual entry, or changed target identifier. The preview and package README must state this limitation.

## Approval and materialization

The UI preview includes at least:

- target product/format/profile/version and output encoding;
- source account(s), legal entity, period, source snapshot, and transaction count;
- included/excluded/ambiguous duplicates;
- debits/credits/net totals by original currency and target mapping;
- pending, unreconciled, unclassified, unreviewed-purpose, missing-FX, and unencodable counts;
- mapping summary and any value truncation/transliteration;
- warning that creation does not post or validate against the target ledger;
- digest that changes when any material input changes.

Approval requires an affirmative owner action in the desktop UI. It is not a remembered checkbox, timer, tray background action, MCP approval, or generic confirmation for future batches.

Materialization creates a package directory/archive containing, as applicable:

```text
data.<csv|qbo|qfx>
manifest.json
README.txt
```

`manifest.json` includes schema version, batch ID, created/approved times, profile/version, source account/entity, selection period, source snapshot IDs, transaction count/totals, encoding/newline settings, duplicate decisions, warnings accepted, and SHA-256 for each package file. The manifest and README are sensitive financial metadata and receive the same destination warning as the data file.

Audit events record preview validation, approval digest/owner action, invalidation, materialization outcome, destination classification (not a sensitive full path), and package checksum. They do not record transaction rows or target credentials.

## Corrections and re-exports

- A created package is immutable. A correction creates a new batch and manifest referencing the superseded package.
- Re-exporting the same exact batch uses the same stable transaction identities and is highlighted as a likely duplicate operation.
- Changing a category, business purpose, FX policy, mapping, date range, duplicate choice, or source version requires a new preview and approval.
- Deleting a package from disk does not erase its local export-history manifest automatically; keeping the manifest is necessary for duplicate warnings. A separate privacy deletion workflow explains the tradeoff.
- The owner records target import success/failure manually if desired. That note is not treated as independently verified accounting state.

## Privacy and accuracy warnings

- Import files, staged content, export packages, and manifests contain sensitive financial and business data. Do not place them in Git repositories, ordinary email, shared/cloud-synced folders, logs, or support tickets.
- The application cannot authenticate that a chosen file truly came from Amex; it validates supported structure and reconciliation only.
- Imported/provider records, category mappings, FX conversion, anomaly signals, and accounting mappings can be incomplete or wrong. Human review is required.
- Accounting import behavior changes over time. Validate every release against current target documentation/test imports and record the review date/profile version.
- Creating a package does not constitute accounting advice, tax treatment, posting, reconciliation in the target, or duplicate-free assurance.
