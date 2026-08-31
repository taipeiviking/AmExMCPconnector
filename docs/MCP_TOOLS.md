# Read-Only MCP Tool Contract

Contract version: `2026-08-31`
Status: target first-release specification

The runnable scaffold enforces the seven-tool/explicit-target/read-only boundary and returns minimized allowlisted DTOs, but it does not yet implement every filter, freshness field, reconciliation field, authenticated cursor, or reporting option below. The registered runtime schemas and the development-status section in the README are authoritative for the current scaffold; closing that gap is a 1.0 release gate.

## Capability boundary

The connector exposes exactly seven tools:

1. `list_accounts`
2. `get_account_status`
3. `list_transactions`
4. `get_statement`
5. `get_portfolio_report`
6. `list_fraud_alerts`
7. `explain_alert`

They read a consistent snapshot of the local database. They do not contact Amex, refresh provider data, launch authorization, import a file, create an export, change an alert, or mutate financial/configuration state. A redacted access-audit record and operational metric are the only intentional local writes associated with a call.

The contract uses the observable MultiMCP-style shape: one registered connector, multiple separately authorized local accounts, and a required target discriminator on each tool invocation. No implementation relies on an undocumented MultiMCP service or implicit account-selection state.

There are no tools for payments, transfers, card controls, disputes, accounting posting, account/portfolio configuration, synchronization, consent, statement upload, export generation, category changes, or alert acknowledgement. Those capabilities must not be registered under alternate names or hidden behind generic “execute,” “action,” SQL, filesystem, browser, or shell tools.

All tools should publish MCP annotations equivalent to:

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Annotations are descriptive hints, not the enforcement boundary. Read-only enforcement comes from module capability separation, read transactions, schema validation, tests, and code review.

OpenAI's current [MCP and Connectors guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) is the integration reference. Private connected mode uses the official [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels); no tool accepts OpenAI credentials or tunnel configuration as input.

## Common conventions

### Explicit target on every call

Every input has one required `target`. There is no omitted target, `null`, empty object, global target, wildcard, implicit current account, default portfolio, or “all accounts” shorthand.

```ts
type AccountTarget = {
  kind: "account";
  account_id: string; // opaque local ID
};

type PortfolioTarget = {
  kind: "portfolio";
  portfolio_id: string; // opaque local ID
};

type Target = AccountTarget | PortfolioTarget;
```

Allowed target kinds are intentionally narrow:

| Tool | Account target | Portfolio target |
| --- | --- | --- |
| `list_accounts` | No | Yes |
| `get_account_status` | Yes | No |
| `list_transactions` | Yes | Yes |
| `get_statement` | Yes | No |
| `get_portfolio_report` | No | Yes |
| `list_fraud_alerts` | Yes | Yes |
| `explain_alert` | Yes | Yes |

The server rejects the wrong target kind. It never broadens it. An alert ID must also belong to the selected account or to a current member of the selected portfolio.

### IDs, dates, instants, and money

- All IDs are opaque local identifiers. Provider IDs, raw account numbers, tokens, and secret references are never exposed.
- Calendar dates are ISO `YYYY-MM-DD` and retain their source/reporting time-zone semantics.
- Instants are RFC 3339 UTC strings ending in `Z`.
- Currency codes are uppercase ISO 4217 codes when the source is a recognized currency.
- Monetary values are canonical decimal strings, never JSON floating-point numbers.
- In MCP outputs, `amount` uses owner cash-flow sign: a charge/outflow is negative and a payment/refund/inflow is positive. `direction` is also present so sign is never the only semantic signal.

```ts
type Money = {
  currency: string;
  amount: string; // e.g. "-123.45", "5000" for JPY
};

type Direction = "debit" | "credit";
```

Source amounts/signs remain in local lineage but are returned only when needed to explain normalization; accounting-target signs are never used in MCP responses.

### Read options

Data tools accept optional read behavior:

```ts
type ReadOptions = {
  completeness?: "require_complete" | "allow_partial"; // default require_complete
  freshness?: "allow_local" | "require_current";       // default allow_local
};
```

- `require_complete` fails a portfolio data query if any member cannot be safely queried.
- `allow_partial` queries only ready members and returns an explicit omitted-account list and `partial: true`. It never silently omits an account.
- `allow_local` can return an authorized account's last committed local snapshot even when it exceeds the preferred stale threshold; the response must say so.
- `require_current` requires the local snapshot to meet the configured threshold. It does not cause a live sync.
- A provider account in `reauthorization_required`, `authorizing`, `disconnected`, or account-binding error is never made queryable by either option.
- Diagnostic tools (`list_accounts`, `get_account_status`) return status even when data tools would fail, so the caller can explain the required owner action.

### Pagination and resource bounds

List/detail tools use opaque cursors. The cursor is authenticated and bound to tool, target, filters, sort order, schema version, and a short-lived read-snapshot/version marker. Clients must not construct or modify it.

```ts
type PageInput = {
  page_size?: number; // default 50, minimum 1, maximum 200
  cursor?: string;
};
```

Unless a stricter tool limit is documented:

- `page_size` defaults to 50 and is capped at 200;
- a transaction or alert date range is required and cannot exceed 366 days per request;
- responses are capped by configured serialized byte and execution-time limits;
- `next_cursor` is `null` when complete;
- sort order is deterministic with local ID as the final tiebreaker.

Changing a filter or target requires starting without the previous cursor. Invalid/expired/mismatched cursors return `CURSOR_INVALID`, not partial data.

### Common response envelope

Every successful tool returns structured content with this envelope:

```ts
type ToolResponse<T> = {
  schema_version: "2026-08-31";
  request_id: string;
  target: Target;
  generated_at: string;
  partial: boolean;
  freshness: AccountFreshness[];
  warnings: Warning[];
  data: T;
  next_cursor: string | null;
};

type AccountFreshness = {
  account_id: string;
  source_kind: "us_provider" | "jp_statement_import";
  authorization_state: string;
  data_state: "current" | "stale" | "not_ready" | "error";
  data_as_of: string | null;
  last_successful_collection_at: string | null;
};

type Warning = {
  code: string;
  message: string;
  account_id?: string;
};
```

For a portfolio, `freshness` contains one entry per included or omitted member without revealing any account outside the selected portfolio. Warnings are safe summaries and exclude provider payloads, statement contents, paths, stack traces, secrets, and raw identifiers.

### Error envelope

Expected failures are returned as an MCP tool error with safe structured details:

```ts
type ToolError = {
  schema_version: "2026-08-31";
  request_id: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    owner_action: "none" | "open_desktop_app" | "reauthorize_in_desktop_app" |
                  "sync_in_desktop_app" | "import_in_desktop_app" |
                  "reduce_query" | "retry_later";
  };
};
```

Normative codes:

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` | Input does not match the published schema. |
| `TARGET_NOT_FOUND` | Selected local target is unavailable; do not reveal other targets. |
| `TARGET_KIND_NOT_ALLOWED` | Tool does not accept that target kind. |
| `ACCOUNT_DISABLED` | Owner disabled/disconnected the selected account. |
| `AUTHORIZATION_NOT_READY` | Consent is in progress/failed or account binding is incomplete. |
| `REAUTHORIZATION_REQUIRED` | Provider has indicated fresh owner consent is required. MCP never launches it. |
| `SOURCE_TEMPORARILY_UNAVAILABLE` | Authorized source is temporarily unavailable; local data may be queried only if options permit. |
| `DATA_NOT_READY` | No committed local data exists for this query. |
| `DATA_STALE` | `require_current` was requested and the local snapshot is stale. |
| `PORTFOLIO_INCOMPLETE` | Complete data was required but at least one selected member is unavailable. |
| `STATEMENT_NOT_FOUND` | No statement in the selected account matches the selector. |
| `ALERT_NOT_FOUND` | No alert in the explicit target matches the ID. |
| `CURSOR_INVALID` | Cursor is invalid, expired, or bound to different input. |
| `RANGE_TOO_LARGE` | Date/report range exceeds the tool limit. |
| `RESULT_LIMIT` | Query exceeds response/time/resource bounds; narrow or paginate. |
| `RATE_LIMITED` | Local connector throttled the caller. |
| `INTERNAL_ERROR` | Redacted unexpected failure; inspect local audit/logs. |

Errors must not distinguish “ID exists but belongs elsewhere” from “ID does not exist.” `REAUTHORIZATION_REQUIRED` is used only when the account state machine has evidence that refresh/recovery cannot continue without owner consent; transient provider/network errors use another state.

## Authorization and readiness algorithm

Every request executes this order before reading financial rows:

1. Validate the complete input schema and resource bounds.
2. Resolve the exact target inside this installation.
3. For a portfolio, take a consistent membership snapshot and enumerate only its account IDs.
4. For every selected account, load local enablement, source kind, authorization/import state, and last committed data freshness.
5. Fail or mark partial according to `read_options`; never start provider refresh, import, consent, or reauthorization.
6. Open a read snapshot scoped to the resolved account ID set.
7. Execute parameterized queries that require non-null account predicates.
8. Build the minimized response and verify its byte/count limits.
9. Append a redacted audit event after the financial read. Audit failure is surfaced according to policy but never causes a financial mutation retry.

For U.S. provider accounts, query-ready authorization is `ready` or an explicitly modeled valid-but-temporarily-unavailable state with permissible cached data. For Japan accounts, query readiness is based on `import_ready`/staleness, not OAuth. `get_account_status` exposes this distinction.

## Tool specifications

### `list_accounts`

Lists accounts currently included in one explicitly selected portfolio. It is not a global account enumerator.

Input:

```ts
{
  target: PortfolioTarget;
  include_disabled?: boolean; // default false; statuses only, no disabled financial data
  page_size?: number;
  cursor?: string;
}
```

Output `data`:

```ts
{
  portfolio: {
    portfolio_id: string;
    display_name: string;
  };
  accounts: Array<{
    account_id: string;
    display_name: string;
    masked_identifier: string | null;
    legal_entity: { legal_entity_id: string; display_name: string };
    country: "US" | "JP";
    currency: string;
    account_class: "personal" | "company";
    source_kind: "us_provider" | "jp_statement_import";
    business_purpose_default: string | null;
    enabled: boolean;
    authorization_state: string;
    data_state: "current" | "stale" | "not_ready" | "error";
    last_successful_collection_at: string | null;
  }>;
}
```

Sort: owner-defined portfolio order, then `account_id`. The tool never returns provider grant IDs, token state details, full card/account numbers, or accounts outside the portfolio.

### `get_account_status`

Returns diagnostic and freshness state for exactly one account. It remains callable when reauthorization or import is required.

Input:

```ts
{
  target: AccountTarget;
}
```

Output `data`:

```ts
{
  account: {
    account_id: string;
    display_name: string;
    masked_identifier: string | null;
    legal_entity: { legal_entity_id: string; display_name: string };
    country: "US" | "JP";
    currency: string;
    account_class: "personal" | "company";
    source_kind: "us_provider" | "jp_statement_import";
    enabled: boolean;
  };
  authorization: {
    state: string;
    checked_at: string;
    reauthorization_required: boolean;
    reason_code: string | null;
    owner_action: "none" | "open_desktop_app" | "reauthorize_in_desktop_app" |
                  "import_in_desktop_app" | "retry_later";
  };
  data: {
    state: "current" | "stale" | "not_ready" | "error";
    data_as_of: string | null;
    last_successful_collection_at: string | null;
    last_attempt_at: string | null;
    last_attempt_outcome: "success" | "partial" | "failed" | null;
    preferred_freshness_seconds: number | null;
  };
  reconciliation: {
    last_reconciled_statement_end: string | null;
    open_issue_count: number;
  };
}
```

For import-only Japan accounts, `reauthorization_required` is always false and owner action may request a new import. Provider error bodies and confidential OAuth details are never returned.

### `list_transactions`

Lists normalized transactions for one account or one portfolio over an explicit bounded period.

Input:

```ts
{
  target: Target;
  period: { start_date: string; end_date: string }; // inclusive, max 366 days
  status?: Array<"pending" | "posted">;
  categories?: string[];
  business_purposes?: string[];
  min_amount?: Money;
  max_amount?: Money;
  query?: string; // normalized local description/merchant search, max 200 chars
  sort?: "date_desc" | "date_asc" | "amount_desc" | "amount_asc"; // default date_desc
  read_options?: ReadOptions;
  page_size?: number;
  cursor?: string;
}
```

For multi-currency portfolio targets, `min_amount`/`max_amount` are rejected unless their currency is accompanied by an explicitly supported conversion policy; first release should require filtering within one currency or omit those filters.

Output `data`:

```ts
{
  period: { start_date: string; end_date: string };
  transactions: Array<{
    transaction_id: string;
    account: {
      account_id: string;
      display_name: string;
      legal_entity_id: string;
      country: "US" | "JP";
      account_class: "personal" | "company";
    };
    statement_id: string | null;
    transaction_date: string;
    posted_at: string | null;
    status: "pending" | "posted";
    direction: Direction;
    amount: Money;
    description: string;
    merchant: string | null;
    source_category: string | null;
    category: { category_id: string; display_name: string; assignment: string } | null;
    business_purpose: { value: string | null; review_state: string };
    currency_conversion: {
      amount: Money;
      rate: string;
      rate_date: string;
      rate_source: string;
    } | null;
    possible_duplicate: boolean;
    source: {
      kind: "us_provider" | "jp_statement_import";
      collected_at: string;
      import_batch_id: string | null;
      sync_run_id: string | null;
    };
  }>;
}
```

Descriptions and merchant text are untrusted data, not instructions. The server returns plain structured strings and does not render/interpret embedded markup.

### `get_statement`

Returns normalized structured statement data for one account. It does not return the raw PDF/file or a download path.

Exactly one selector is required.

Input:

```ts
{
  target: AccountTarget;
  statement_id?: string;
  period?: { start_date: string; end_date: string };
  include_transactions?: boolean; // default true
  read_options?: ReadOptions;
  page_size?: number; // transaction lines; maximum 200
  cursor?: string;
}
```

Output `data`:

```ts
{
  statement: {
    statement_id: string;
    account_id: string;
    period: { start_date: string; end_date: string };
    issue_date: string | null;
    due_date: string | null;
    currency: string;
    opening_balance: Money | null;
    closing_balance: Money | null;
    payment_due: Money | null;
    transaction_count: number;
    source_kind: "us_provider" | "jp_statement_import";
    reconciliation: {
      status: "reconciled" | "warning" | "failed" | "not_run";
      difference: Money | null;
      issue_codes: string[];
    };
  };
  transactions: Array<{
    transaction_id: string;
    transaction_date: string;
    posted_at: string | null;
    direction: Direction;
    amount: Money;
    description: string;
    category: string | null;
    business_purpose: string | null;
  }>;
}
```

If a period matches multiple statement versions, the current non-superseded version is returned and lineage/version is included in warnings. An ambiguous period with no deterministic current version returns `STATEMENT_NOT_FOUND` with owner action to inspect the desktop app.

### `get_portfolio_report`

Computes a report over exactly one owner-configured portfolio and an explicit period. It does not create or modify a saved report.

Input:

```ts
{
  target: PortfolioTarget;
  period: { start_date: string; end_date: string }; // max 366 days for 1.0
  reporting_currency: string;
  group_by?: Array<"account" | "legal_entity" | "country" | "source_currency" |
                  "account_class" | "category" | "business_purpose" | "month">;
  include_pending?: boolean;       // default false
  include_unreconciled?: boolean;  // default true, always labeled
  read_options?: ReadOptions;
}
```

Output `data`:

```ts
{
  portfolio: { portfolio_id: string; display_name: string };
  period: { start_date: string; end_date: string };
  reporting_currency: string;
  coverage: {
    included_account_ids: string[];
    omitted_accounts: Array<{ account_id: string; reason_code: string }>;
    reconciled_transaction_count: number;
    unreconciled_transaction_count: number;
    missing_fx_transaction_count: number;
  };
  totals: {
    outflows: Money;
    inflows: Money;
    net: Money;
  };
  groups: Array<{
    dimensions: Record<string, string | null>;
    outflows: Money;
    inflows: Money;
    net: Money;
    transaction_count: number;
    account_ids: string[];
    derived: boolean;
  }>;
  fx: {
    policy: string;
    rate_sources: string[];
    rate_date_policy: string;
    missing_rate_count: number;
  };
}
```

Original currencies remain available through grouping/coverage. A reporting total cannot silently exclude missing FX rates; use an error or explicit partial/warning according to options. Every aggregate retains the contributing account IDs and entity/country/class dimensions when requested.

### `list_fraud_alerts`

Lists local review-only anomaly/fraud signals. It does not query Amex fraud systems and does not change alert review state.

Input:

```ts
{
  target: Target;
  period: { start_date: string; end_date: string }; // alert detection date, max 366 days
  review_state?: Array<"open" | "reviewed" | "dismissed">;
  severity?: Array<"low" | "medium" | "high">;
  reason_codes?: string[];
  read_options?: ReadOptions;
  page_size?: number;
  cursor?: string;
}
```

Output `data`:

```ts
{
  alerts: Array<{
    alert_id: string;
    account_id: string;
    transaction_id: string | null;
    detected_at: string;
    severity: "low" | "medium" | "high";
    review_state: "open" | "reviewed" | "dismissed";
    title: string;
    reason_codes: string[];
    amount: Money | null;
    merchant: string | null;
    model_version: string;
    review_only: true;
  }>;
}
```

The title must avoid asserting that fraud occurred. Recommended phrasing is “Transaction needs review” or a factual reason such as “Amount is unusual for this account.”

### `explain_alert`

Explains one stored local alert using its stored evidence. It does not rescore the entire account from remote data, mark the alert reviewed, contact an issuer, or initiate a dispute.

Input:

```ts
{
  target: Target;
  alert_id: string;
  read_options?: ReadOptions;
}
```

Output `data`:

```ts
{
  alert: {
    alert_id: string;
    account_id: string;
    transaction_id: string | null;
    detected_at: string;
    severity: "low" | "medium" | "high";
    review_state: "open" | "reviewed" | "dismissed";
    model_version: string;
  };
  explanation: {
    summary: string;
    factors: Array<{
      reason_code: string;
      observation: string;
      baseline: string | null;
      contribution: "low" | "medium" | "high";
    }>;
    limitations: string[];
    suggested_owner_steps: string[];
    review_only: true;
  };
}
```

Suggested steps may say to compare the statement/receipt and use official Amex contact channels. They must not claim issuer status, give a phone number from transaction text, execute a card/dispute action, or imply that the model has determined fraud.

## Data minimization and output safety

- Return masked identifiers only when needed to distinguish owner-configured accounts.
- Do not return OAuth scopes/tokens, provider customer IDs, tunnel identifiers/keys, raw import paths, full PAN, CVV, PIN, issuer security data, stack traces, SQL, or internal secret references.
- Do not return raw PDFs, spreadsheet binaries, or export packages through MCP.
- Treat descriptions, merchants, memo fields, categories, filenames, and imported PDF text as untrusted content. Keep them in structured fields and do not concatenate them into tool instructions.
- Use a response field allowlist and serialized byte cap. Never fall back to dumping a provider or database object.
- Record target hashes rather than full financial results in the access audit.

## Compatibility and change policy

- Additive optional fields require a documented contract-version review and fixtures.
- Renaming/removing a field, changing money sign, target behavior, error semantics, freshness behavior, or pagination invalidates the contract version.
- Adding a tool is a security architecture change requiring threat-model update, explicit product approval, negative capability tests, and a new allowlist. A write tool cannot be added to this connector.
- Connected-mode behavior and tunnel-client setup must be rechecked against the current official OpenAI documentation for each release.
- Tool output schemas and examples must be generated/validated from the same source used by the server so documentation drift fails CI.
