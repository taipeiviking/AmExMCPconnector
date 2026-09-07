# Plaid Hosted Link for a U.S. personal card

Status: implemented local-alpha path and operator reference, reviewed against Plaid's official documentation on 2026-09-07

> The built-in path can be tested with the owner's own Plaid Sandbox app and fake data. Its Production option is implemented but **not verified as a live American Express connection**: it still requires the owner's Plaid Production approval and actual American Express Transactions coverage. This is for **U.S. personal credit or charge cards only**. It is not a provider contract, affiliation, endorsement, or availability guarantee.

## What the owner sees

1. Under **Accounts → Open step-by-step guide**, the owner chooses Sandbox or Production, enters a Plaid developer app client ID and matching environment secret, confirms the read-only boundary, and chooses **Check and save Plaid credentials**. The check creates no local account or consent.
2. After the check passes, the owner enters a local nickname and owner label and chooses **Continue to read-only consent**.
3. The app creates one short-lived Hosted Link session and opens Plaid's returned `hosted_link_url` in the system browser. It never renders a bank-password field itself.
4. In Sandbox, the owner chooses **First Platypus Bank**, enters Plaid's fake `user_good` / `pass_good` credentials, and selects its single credit card. In Production, Plaid may send the owner to American Express for OAuth authentication and scoped consent. The owner checks the browser address, approves only the intended card and transaction access, or closes the browser to cancel.
5. The app obtains the result through bounded `/link/token/get` polling. A browser redirect or a closed browser is not proof of success.
6. The app requires exactly one returned personal credit or charge card. It verifies the Item's returned institution ID with `/institutions/get_by_id` and requires the exact environment-allowed name: **First Platypus Bank** in Sandbox or **American Express** in Production. There is no guessed or universal built-in American Express institution ID, and a mask alone is not a unique identifier.
7. For a new connection, privileged code exchanges the short-lived public token, stores the resulting Item token and exact account binding in encrypted local storage, and begins a read-only Transactions sync. The account card reports **Consent stored** only after authorization succeeds.

Closing Hosted Link, declining consent, selecting no compatible card, timing out, or receiving an ambiguous result leaves the local account unconnected. Because the nickname is created before Hosted Link opens, the account card can remain; use **Reconnect** to retry or **Disconnect** to retire it. If a provider grant may exist after a local persistence failure, the app reports that remote cleanup was not confirmed and the owner must check the provider portal before retrying.

The desktop app must never ask for an American Express username, password, one-time code, security answer, PIN, CVV, or full card number. An expected external Plaid or American Express page may ask the owner to authenticate as part of its own flow. Do not paste those values into the desktop app, a support message, a screenshot, or a log.

## Sandbox is not Production

| Environment | Purpose | Data and enrollment | What it proves |
| --- | --- | --- | --- |
| Plaid Sandbox at `https://sandbox.plaid.com` | Integration development and failure testing | Plaid mock institutions, test credentials, Sandbox keys, and no real card data. Sandbox does not send Hosted Link by email or SMS. | The app's request, correlation, cancellation, token handling, and synthetic sync logic work against Plaid's test service. It does **not** prove American Express-specific behavior or Production coverage. |
| Plaid Production at `https://production.plaid.com` | Real account access | Separate Production credentials and real financial data. A Plaid paid plan or trial supplies Production access; a trial is not a sandbox. OAuth access and institution registration still depend on the Plaid account and client ID. | Only an approved, reviewed, real-data pilot can establish the exact account/product behavior for that deployment. It still does not guarantee continuing coverage, uptime, or data completeness. |

Never move a Sandbox `link_token`, `public_token`, `access_token`, Item, or mock record into Production. Bind every pending authorization and stored Item to its Plaid environment and local account. Start with Sandbox and synthetic identities; never enter real American Express credentials into a Sandbox test pane.

## External Plaid setup

The application owner must complete Plaid's external setup; the installer does not supply a Plaid account or API credentials:

1. Create and secure a Plaid developer account in the Plaid Dashboard. This is separate from a consumer account at `my.plaid.com`.
2. In the Link customization used by the app, set **Account Select** to **Enabled for one account**. Obtain Sandbox keys and test Hosted Link exits, expiry, exact account selection, token exchange, sync, update mode, and removal using mock data.
3. In the app choose **Sandbox**, enter that app's client ID and Sandbox secret, and run **Check and save Plaid credentials**. For the end-to-end browser test choose **First Platypus Bank**, enter `user_good` / `pass_good`, and select its single credit card. These are public fake Plaid test credentials, never an Amex login.
4. Request Production access through the applicable paid or trial path. Complete the current application display information and company information requirements and, when applicable, the Plaid MSA, security questionnaire, and institution registration. Track approval in the Dashboard.
5. Use only the Plaid **Transactions** product for this app. Exclude Auth, Identity, Assets, Liabilities, Signal, Transfer, Payment Initiation, card controls, payments, and every other unnecessary product.
6. In Plaid's Coverage Explorer and OAuth institution status for the exact Production client ID, verify American Express, Transactions, U.S. credit/charge-card account types, consent duration, and any institution-specific conditions. The app verifies the Item's returned institution ID through `/institutions/get_by_id` and requires the exact name `American Express`; it does not ship a guessed universal institution ID. Repeat the external coverage check before each release because availability can change.
7. Review Plaid's contract, billing, privacy disclosures, subprocessors, incident process, retention/deletion duties, and end-user consent text. Production requests for initialized products can be billable.

Plaid's OAuth guide currently identifies American Express as an institution whose consent ordinarily needs refreshing every 12 months. The app reads the actual `consent_expiration_time` when supplied and uses owner-visible Link update mode when the provider requires reauthorization; do not turn the current 12-month description into a permanent guarantee.

### Protected credential references

Plaid requires a `client_id` and environment-specific `secret` on its API calls. They belong in the privileged main-process/provider boundary, never the renderer, Hosted Link URL, command line, log, or repository.

The built-in wizard resolves `AMEX_US_AGGREGATOR_CLIENT_ID_REF` and `AMEX_US_AGGREGATOR_CLIENT_SECRET_REF`, whose defaults point to distinct fixed Windows Generic Credential targets. **Check and save Plaid credentials** verifies the submitted pair against the chosen environment before overwriting those Windows entries. The environment and optional redirect are non-secret settings; the client ID and secret are not written to `.env`, the app database, logs, or Git. Disconnect active U.S. accounts before changing environment or app credentials so Items cannot be mixed across Plaid apps or environments.

Plaid Item `access_token` values are separate per connection and are stored in the app's encrypted token store with their environment, local account, and exact provider account binding. They are not environment variables or operator-managed Windows credentials. Rotate a compromised Plaid app secret at Plaid, disconnect affected Items according to policy, and replace the protected Windows entry through the setup UI.

### Optional Production OAuth return URL

The built-in desktop flow opens Hosted Link in an external browser. Plaid's OAuth guidance says web integrations can function without `redirect_uri`, but a reviewed URL is recommended and a particular Plaid tenant or institution setup may require it. If applicable, enter **OAuth return URL (optional on desktop)** or set `AMEX_US_PLAID_REDIRECT_URI` to an owned plain HTTPS URL already listed in the Plaid Dashboard's Allowed redirect URIs. The app rejects credentials, query parameters, and fragments. This OAuth return URL is distinct from Hosted Link's `completion_redirect_uri`; neither a redirect nor returning to the app proves authorization succeeded.

## Exact Hosted Link API profile used by the app

The official Plaid API reference remains canonical. The shapes below identify the fields this implementation sends and consumes; unrelated Plaid product fields are intentionally omitted.

### 1. `POST /link/token/create`

Send to the chosen environment host with `Content-Type: application/json`. Plaid permits API credentials in the body, but this implementation sends `PLAID-CLIENT-ID` and `PLAID-SECRET` request headers so they are not mixed into a user-visible payload.

```json
{
  "client_name": "Amex Local Connector",
  "language": "en",
  "country_codes": ["US"],
  "user": {
    "client_user_id": "opaque-local-owner-id"
  },
  "products": ["transactions"],
  "account_filters": {
    "credit": {
      "account_subtypes": ["credit card", "charge card"]
    }
  },
  "transactions": {
    "days_requested": 730
  },
  "hosted_link": {
    "url_lifetime_seconds": 1800
  },
  "redirect_uri": "https://optional-owned-allowlisted.example/plaid-return"
}
```

Contract details:

- `client_name` is required and has a 30-character maximum. `language` and at least one `country_codes` entry are required.
- This ordinary single-owner profile supplies `user.client_user_id`: a stable, random, non-personal local identifier. Never use an email address, phone number, name, card number, or local account label. Plaid's newer User API flows can instead require `user_id`; adopting those flows would be a separate reviewed design change.
- A new Item requires at least one `products` entry. `transactions` is the minimum product for this read-only transaction use case. Plaid says initialized products affect institution availability and Production billing and cannot later be removed from an Item.
- `account_filters.credit.account_subtypes` accepts the exact values `credit card` and `charge card`. With account filters, omitted account types are excluded. OAuth institutions may still show broader choices on their own consent screen; Plaid applies the filter after OAuth and can reject an incompatible result.
- `transactions.days_requested` accepts `1` through `730`, defaults to `90`, and has a Production minimum of 30 days even if a smaller number is sent. Once Transactions is initialized on an Item, the requested history window cannot be changed on that Item.
- Sending the `hosted_link` object enables Hosted Link; it may be empty. The built-in desktop profile sends a 30-minute `url_lifetime_seconds` and does not request Link Delivery. Plaid's API permits a positive lifetime up to 21 days; without Plaid delivery, its default is also 30 minutes.
- The app does not set `hosted_link.delivery_method`. It is a Link Delivery beta option, requires separate enablement plus an email address or phone number, and is ignored in Sandbox. This local desktop path opens the returned URL itself and does not give Plaid owner contact details for delivery.
- Configure the selected Dashboard Link customization with **Account Select → Enabled for one account**. The built-in runtime does not currently send a `link_customization_name`; if one is introduced, it must name that reviewed customization and match the request's language/country settings.
- `webhook` is optional in the API schema but Plaid strongly recommends it for Hosted Link. This local desktop implementation has no public receiver and instead uses bounded `/link/token/get` polling; a loopback webhook cannot receive Plaid's service calls. Any Production review must explicitly accept that tradeoff or add a separately reviewed public HTTPS receiver.
- The shown `redirect_uri` is omitted unless a Production value is configured. Plaid OAuth `redirect_uri` and Hosted Link `completion_redirect_uri` are different fields. The app does not use `completion_redirect_uri`; it trusts only the polled session result. A configured Production OAuth URI must be an owned HTTPS Dashboard-allowlisted URL with no credentials, query, or fragment.

A Hosted Link-enabled response has this relevant schema:

```text
{
  link_token: string,
  expiration: string,          // ISO 8601 date-time
  request_id: string,
  hosted_link_url: string,
  user_id?: string             // only when the Plaid User API flow supplies it
}
```

The app rejects a response with no `hosted_link_url`, keeps the `link_token` in privileged short-lived state, associates it with exactly one local account attempt and environment, and opens only the validated Plaid HTTPS URL. It never exposes the `link_token` to logs or support output.

### 2. `POST /link/token/get`

Send the same credential headers and exactly this request body to the same environment that created the token:

```json
{
  "link_token": "link-..."
}
```

For this Transactions Item-add flow, the relevant current response schema is:

```text
{
  link_token: string,
  created_at: string | null,   // ISO 8601 date-time
  expiration: string | null,   // ISO 8601 date-time
  link_sessions: Array<{
    link_session_id: string,
    started_at: string,
    finished_at: string | null,
    events: Array<object>,
    exit: object | null,
    results: {
      item_add_results: Array<{
        public_token: string,
        accounts: Array<{
          id: string,
          name: string,
          mask: string | null,
          type: string,
          subtype: string,
          verification_status: string | null
        }>,
        institution: {
          name: string,
          institution_id: string
        } | null
      }>
    } | null
  }>,
  metadata: {
    initial_products: Array<string>,
    webhook: string | null,
    country_codes: Array<string>,
    language: string | null,
    account_filters: object,
    redirect_uri: string | null,
    client_name: string | null
  },                            // original create arguments
  request_id: string
}
```

Plaid's legacy `on_success` and `on_exit` session fields are deprecated; the app reads `results.item_add_results` and `exit`. The result array can contain multiple Items and accounts, but this personal-card profile requires exactly one Item and exactly one returned account. It validates that the account `type` is `credit` and its `subtype` is `credit card` or `charge card`, then verifies the Item's returned institution ID through `/institutions/get_by_id` and requires the exact environment-allowed name. Plaid documents `mask` as the last 2–4 characters and warns that it may be non-unique or differ from what the bank displays, so the encrypted exact provider account ID—not the mask—is the binding.

No `finished_at`, a non-null exit/error, a null result, an empty result, an unexpected environment/institution/account, or an expired correlation is treated as connected. Detailed session data remains available for up to six hours after a session ends, so polling is bounded and a retry creates a fresh Link token rather than reusing stale state. Hosted Link has no frontend `onSuccess` callback available to this desktop app.

### 3. Exchange and store the result

For a validated new-Item result, privileged code exchanges the single accepted `public_token` within its 30-minute lifetime:

```text
POST /item/public_token/exchange
headers: PLAID-CLIENT-ID, PLAID-SECRET
body:     { public_token: string }
response: { access_token: string, item_id: string, request_id: string }
```

Plaid access tokens do not expire by default and this flow does not invent a refresh token. The app stores the `access_token` securely with its `item_id`; it never displays or logs it. The adapter uses `/transactions/get` because the app's normalized read contract needs bounded date/offset snapshots: it sends the exact validated Plaid `account_id`, excludes pending transactions, validates `total_transactions`, and keeps paging until the requested result is complete. It preserves local account attribution; if the first sync fails after consent was stored, the UI asks the owner to use **Check now** rather than silently reauthorize.

### 4. Update-mode reconnect

When an existing active account requires repair or renewed consent, **Reconnect** creates `/link/token/create` with that Item's existing `access_token`. Plaid update mode omits the initial `products`, transaction-history request, and account filters. After Hosted Link succeeds, the app rechecks the same Item, institution, and exact provider account binding; it does not exchange a new public token or silently create a replacement Item. If the protected access token or existing provider account binding is missing, reconnect fails closed and tells the owner not to mix history with a different source account.

## Read-only consent and product limits

For this path, “read-only” means the app requests only Plaid Transactions data and exposes no payment, transfer, routing/account-number Auth, card-control, dispute, or write operation. Plaid does not use the generic `AMEX_US_AGGREGATOR_SCOPES` string as the Hosted Link product contract; the built-in implementation enforces the exact `products`, account filters, endpoints, and consent result in code.

Scoped OAuth consent belongs to the owner. Plaid can recommend permissions based on initialized products, but the institution lets the owner choose what to share. If required transaction or account permission is withheld, the app remains unconnected and reports the failure. It never broadens the request on retry without a new owner-visible consent step.

Plaid's Transactions product supports credit accounts such as credit cards. Plaid's **Statements** product currently supports only depository accounts such as checking and savings. The built-in path therefore does not request `statements`, promise American Express statement PDFs, or represent a Transactions feed as an official statement. `get_statement` reports unavailable for a Plaid credit-card connection; an official statement document requires a different reviewed source.

## Disconnect, revoke, and delete are separate actions

The account-card **Disconnect** action stops local reads, removes the protected local token/binding, and then requests:

```text
POST /item/remove
headers: PLAID-CLIENT-ID, PLAID-SECRET
body:     { access_token: string }
response: { request_id: string }
```

For current Plaid API versions, success returns `request_id`; the old `removed` boolean is legacy. `/item/remove` invalidates the Item's access token and related processor/bank tokens and is the recommended disconnect action. Plaid requires Item removal to stop subscription billing for Transactions unless the owner already revoked permission through a provider control such as `my.plaid.com`.

These outcomes remain separate:

- **Remote Item removal:** Plaid accepted `/item/remove` and subsequent API reads stop. If it fails, the app reports **revocation not confirmed** and directs the owner to official provider/institution controls.
- **Institution/provider consent:** the owner can also review or revoke sharing through official American Express controls and `my.plaid.com`. Plaid notes that a removed Item can still appear in some institution OAuth permission managers, so the app must not claim those screens were cleared.
- **Local token removal:** the app removes the protected access token and Item binding before the remote request so local reads stop even if Plaid is unavailable. This does not erase financial rows already copied locally.
- **Plaid app-credential removal:** after every active U.S. account is disconnected, **Settings → Remove Plaid app credentials** removes the developer client ID and secret from Windows Credential Manager. It does not close the Plaid account or erase external copies.
- **Local financial-data deletion:** a separate, destructive, confirmed action removes the app-owned account history and artifacts. It cannot erase Plaid/American Express records, external exports, backups, filesystem snapshots, or copies elsewhere.

If the owner revokes an account or Item externally, the app stops using it when Plaid reports `ITEM_LOGIN_REQUIRED` or another authorization error and marks the account for reconnect. It does not silently relink. Reauthorization uses a new owner-visible Link update-mode session; American Express consent expiration currently requires periodic refresh according to Plaid's OAuth guide.

## No live Production guarantee

The Plaid provider core, credential wiring, setup UI, system-browser Hosted Link, bounded polling, exact account/institution validation, Transactions read, update mode, and Item-removal path are present in the local alpha. Production use still needs the owner's provider contract/access, current American Express/Transactions coverage evidence, privacy/security and billing review, signed packaging, operational recovery, revocation/deletion testing, and an explicitly authorized real-data pilot.

Even after those gates, neither a successful Sandbox run nor Plaid's general American Express/OAuth documentation guarantees that a particular card, transaction, statement period, consent flow, or ongoing connection will work. The app must show observed environment, last successful sync, consent expiry, product/account availability, and errors without labeling configuration alone as a live connection.

## Official Plaid references

- [Hosted Link](https://plaid.com/docs/link/hosted-link/)
- [Link API: `/link/token/create` and `/link/token/get`](https://plaid.com/docs/api/link/)
- [Link flow overview](https://plaid.com/docs/link/)
- [Link customization and Account Select](https://plaid.com/docs/link/customization/)
- [Link update mode](https://plaid.com/docs/link/update-mode/)
- [OAuth guide, registration, scoped consent, expiry, and revocation](https://plaid.com/docs/link/oauth/)
- [Sandbox](https://plaid.com/docs/sandbox/)
- [Items API: token exchange, Item status, token rotation, and removal](https://plaid.com/docs/api/items/)
- [Transactions](https://plaid.com/docs/transactions/)
- [Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Statements support](https://plaid.com/docs/statements/)
- [Production launch checklist](https://plaid.com/docs/launch-checklist/)

Plaid's API and enrollment requirements can change. Recheck these sources and the exact Plaid Dashboard configuration before each Production test and release.
