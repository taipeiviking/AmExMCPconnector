# Future Plaid Hosted Link design for a U.S. personal card

Status: design and operator reference, reviewed against Plaid's official documentation on 2026-09-07

> **This flow is not implemented or enabled in the current app.** The installed alpha cannot connect a U.S. account through Plaid, and adding Plaid keys to configuration will not make it work. This document defines a candidate future path for **U.S. personal credit or charge cards only**. It is not a provider contract, production approval, affiliation, endorsement, or guarantee that an American Express account will be available.

## What the future owner experience should be

1. The app verifies the selected Plaid environment, protected credential references, provider approval, and local encrypted store before enabling **Connect with Plaid**.
2. The app creates one short-lived Hosted Link session and opens Plaid's returned `hosted_link_url` in the system browser. It never renders a bank-password field itself.
3. Plaid may send the owner to American Express's website or app for OAuth authentication and scoped consent. The owner checks the browser address, approves only the intended card and transaction access, or closes the browser to cancel.
4. Back in the app, **Check connection status** retrieves the outcome. A browser redirect or a closed browser is not proof of success.
5. The app requires exactly one returned personal credit or charge card, verifies the Plaid institution ID and exact name against deployment-reviewed American Express values, and shows the institution, account name, masked identifier, type, subtype, and requested product before the owner confirms the local account mapping. There is no guessed or built-in American Express institution ID, and a mask alone is not a unique identifier.
6. Only after that confirmation does the app exchange the short-lived public token, store the resulting Item and access token in the protected local boundary, and begin a read-only Transactions read.

Closing Hosted Link, declining consent, selecting no compatible card, timing out, or receiving an ambiguous result must leave the U.S. account unconnected. The app should offer **Try again** and a safe local path without silently creating a grant.

The desktop app must never ask for an American Express username, password, one-time code, security answer, PIN, CVV, or full card number. An expected external Plaid or American Express page may ask the owner to authenticate as part of its own flow. Do not paste those values into the desktop app, a support message, a screenshot, or a log.

## Sandbox is not Production

| Environment | Purpose | Data and enrollment | What it proves |
| --- | --- | --- | --- |
| Plaid Sandbox at `https://sandbox.plaid.com` | Integration development and failure testing | Plaid mock institutions, test credentials, Sandbox keys, and no real card data. Sandbox does not send Hosted Link by email or SMS. | The app's request, correlation, cancellation, token handling, and synthetic sync logic work against Plaid's test service. It does **not** prove American Express-specific behavior or Production coverage. |
| Plaid Production at `https://production.plaid.com` | Real account access | Separate Production credentials and real financial data. A Plaid paid plan or trial supplies Production access; a trial is not a sandbox. OAuth access and institution registration still depend on the Plaid account and client ID. | Only an approved, reviewed, real-data pilot can establish the exact account/product behavior for that deployment. It still does not guarantee continuing coverage, uptime, or data completeness. |

Never move a Sandbox `link_token`, `public_token`, `access_token`, Item, or mock record into Production. Bind every pending authorization and stored Item to its Plaid environment and local account. Start with Sandbox and synthetic identities; never enter real American Express credentials into a Sandbox test pane.

## External setup required before the UI can be enabled

The application owner—not an ordinary first-time app user—must complete Plaid's external setup:

1. Create and secure a Plaid developer account in the Plaid Dashboard. This is separate from a consumer account at `my.plaid.com`.
2. Obtain Sandbox API keys and test Hosted Link, OAuth-like exits, duplicate attempts, expiry, account selection, token exchange, sync, update mode, and removal using mock data.
3. Request Production access through the applicable paid or trial path. Complete the current application display information and company information requirements and, when applicable, the Plaid MSA, security questionnaire, and institution registration. Track approval in the Dashboard.
4. Request only the Plaid **Transactions** product for this design. Exclude Auth, Identity, Assets, Liabilities, Signal, Transfer, Payment Initiation, card controls, payments, and any other product that the app does not need.
5. In Plaid's Coverage Explorer and the OAuth institution status for the exact Production client ID, verify American Express, the Transactions product, U.S. credit/charge-card account types, consent duration, and any institution-specific conditions. Record the reviewed Plaid institution ID and exact name as deployment configuration and verify both through `/institutions/get_by_id`; do not guess or ship a universal default. Repeat before each release because coverage and requirements can change.
6. Review Plaid's contract, billing, privacy disclosures, subprocessors, incident process, retention/deletion duties, and end-user consent text. Production requests for initialized products can be billable.

Plaid's OAuth guide currently identifies American Express as an institution whose consent ordinarily needs refreshing every 12 months. The future app must read the actual `consent_expiration_time`, warn before expiry, and use Link update mode when reauthorization is required; documentation must not turn that current behavior into a permanent guarantee.

### Protected credential references

Plaid requires a `client_id` and environment-specific `secret` on its API calls. They belong in the privileged main-process/provider boundary, never the renderer, Hosted Link URL, command line, log, or repository.

The current provider-agnostic configuration already defines `AMEX_US_AGGREGATOR_CLIENT_ID_REF` and `AMEX_US_AGGREGATOR_CLIENT_SECRET_REF`. If the future Plaid implementation deliberately reuses that contract, each value must be only a distinct `wincred:<target>` locator and the corresponding Sandbox or Production value must live in a Windows Generic Credential for the current user. Do not put the actual values in `.env`. Use different targets for Sandbox and Production, and rotate them at Plaid before updating the protected Windows entry.

That mapping is not implemented today. The future code must explicitly resolve and consume the references; merely setting the variables does not configure Plaid. Plaid Item `access_token` values are separate per connection and should be stored in the app's encrypted token store with their `item_id`, environment, local account, provider account IDs, and consent state—not as environment variables or operator-managed credentials.

## Exact Hosted Link API profile for this design

The official Plaid API reference remains canonical. The shapes below identify the fields this app should send and consume; unrelated Plaid product fields are intentionally omitted.

### 1. `POST /link/token/create`

Send to the chosen environment host with `Content-Type: application/json`. Plaid permits the API credentials in the body, but this design must use the `PLAID-CLIENT-ID` and `PLAID-SECRET` request headers so they cannot be mixed into a user-visible payload.

```json
{
  "client_name": "Amex Local Finance Connector",
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
    "url_lifetime_seconds": 1800,
    "is_mobile_app": false
  }
}
```

Contract details:

- `client_name` is required and has a 30-character maximum. `language` and at least one `country_codes` entry are required.
- This ordinary single-owner profile supplies `user.client_user_id`: a stable, random, non-personal local identifier. Never use an email address, phone number, name, card number, or local account label. Plaid's newer User API flows can instead require `user_id`; adopting those flows would be a separate reviewed design change.
- A new Item requires at least one `products` entry. `transactions` is the minimum product for this read-only transaction use case. Plaid says initialized products affect institution availability and Production billing and cannot later be removed from an Item.
- `account_filters.credit.account_subtypes` accepts the exact values `credit card` and `charge card`. With account filters, omitted account types are excluded. OAuth institutions may still show broader choices on their own consent screen; Plaid applies the filter after OAuth and can reject an incompatible result.
- `transactions.days_requested` accepts `1` through `730`, defaults to `90`, and has a Production minimum of 30 days even if a smaller number is sent. Once Transactions is initialized on an Item, the requested history window cannot be changed on that Item.
- Sending the `hosted_link` object enables Hosted Link; it may be empty. This desktop profile sets `is_mobile_app` to `false`. A positive `url_lifetime_seconds` cannot exceed 21 days; without Plaid Link Delivery, the default is 30 minutes, so this design makes that 30-minute lifetime explicit.
- Do not set `hosted_link.delivery_method`. It is a Link Delivery beta option, requires separate enablement plus an email address or phone number, and is ignored in Sandbox. This local desktop design opens the returned URL itself and does not give Plaid owner contact details for delivery.
- `link_customization_name` may be supplied only when it names a reviewed Plaid Dashboard customization whose language and country settings match this request.
- `webhook` is optional in the API schema but Plaid strongly recommends it for Hosted Link. The current candidate core deliberately has no public receiver and uses bounded `/link/token/get` polling as a local-only tradeoff; a loopback webhook cannot receive Plaid's service calls. Production review must explicitly accept that tradeoff or add a reviewed public HTTPS webhook receiver before launch.
- Plaid OAuth `redirect_uri` and Hosted Link `completion_redirect_uri` are different fields. If either is introduced, use an owned, reviewed destination and follow the Dashboard allowlist rules. A Production OAuth `redirect_uri` must be HTTPS, contain no query parameters, and cannot be a localhost HTTP callback. A completion redirect is only navigation and never proves authorization succeeded.

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

The app must reject a response with no `hosted_link_url`, keep the `link_token` in privileged short-lived state, associate it with exactly one local owner/account attempt and environment, and open only the validated Plaid HTTPS URL. Never expose the `link_token` to logs or support output.

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

Plaid's legacy `on_success` and `on_exit` session fields are deprecated; use `results.item_add_results` and `exit`. The result array can contain multiple Items and accounts, but this personal-card profile requires exactly one Item and exactly one returned account. A successful result still requires account-mapping confirmation, validation that the account `type` is `credit` and its `subtype` is `credit card` or `charge card`, and verification of the returned Item's institution through `/institutions/get_by_id` against the deployment-reviewed institution ID and exact name. Plaid documents `mask` as the last 2–4 characters and explicitly warns that it may be non-unique or differ from what the bank displays.

No `finished_at`, a non-null exit/error, a null result, an empty result, an unexpected environment/institution/account, or an expired correlation must be shown as pending, cancelled, or failed—not connected. Detailed session data remains available for up to six hours after a session ends, so polling must be bounded and recovery must allow creation of a fresh Link token rather than reusing stale state. Hosted Link has no frontend `onSuccess` callback available to this desktop app.

### 3. Exchange and store the result

After the owner confirms the mapping, exchange each accepted `public_token` within its 30-minute lifetime:

```text
POST /item/public_token/exchange
headers: PLAID-CLIENT-ID, PLAID-SECRET
body:     { public_token: string }
response: { access_token: string, item_id: string, request_id: string }
```

Plaid access tokens do not expire by default and this flow does not invent a refresh token. Store the `access_token` persistently and securely with its `item_id`; never display or log it. The candidate adapter uses `/transactions/get` because the app's normalized read contract needs stable date/offset snapshots: it sends the exact validated Plaid `account_id`, excludes pending transactions, validates `total_transactions`, and keeps paging until the requested bounded result is complete. Preserve account attribution and do not mark the account ready until the first read and mapping checks succeed.

## Read-only consent and product limits

For this design, “read-only” means the app requests only Plaid Transactions data and exposes no payment, transfer, routing/account-number Auth, card-control, dispute, or write operation. Plaid does not use the current generic `AMEX_US_AGGREGATOR_SCOPES` string as the Hosted Link product contract; the future implementation must enforce the exact `products`, account filters, endpoints, and consent result in code.

Scoped OAuth consent belongs to the owner. Plaid can recommend permissions based on initialized products, but the institution lets the owner choose what to share. If required transaction or account permission is withheld, the app must explain the missing permission and remain unconnected. It must never broaden the request on retry without a new owner-visible consent step.

Plaid's Transactions product supports credit accounts such as credit cards. Plaid's **Statements** product currently supports only depository accounts such as checking and savings. Therefore this design must not request `statements`, promise American Express statement PDFs, or represent a Transactions feed as an official statement. The existing `get_statement` MCP capability needs a different reviewed source or must report unavailable for such an account.

## Disconnect, revoke, and delete are separate actions

A future **Disconnect Plaid** action should stop sync and call:

```text
POST /item/remove
headers: PLAID-CLIENT-ID, PLAID-SECRET
body:     { access_token: string }
response: { request_id: string }
```

For current Plaid API versions, success returns `request_id`; the old `removed` boolean is legacy. `/item/remove` invalidates the Item's access token and related processor/bank tokens and is the recommended disconnect action. Plaid requires Item removal to stop subscription billing for Transactions unless the owner already revoked permission through a provider control such as `my.plaid.com`.

These outcomes must be reported separately:

- **Remote Item removal:** Plaid accepted `/item/remove` and future API reads stop. If it fails, show **revocation not confirmed**, never claim disconnection completed, and direct the owner to the official provider/institution controls and the reviewed retry policy.
- **Institution/provider consent:** the owner can also review or revoke sharing through official American Express controls and `my.plaid.com`. Plaid notes that a removed Item can still appear in some institution OAuth permission managers, so the app must not claim those screens were cleared.
- **Local token removal:** after remote outcome handling, remove the protected access token and Item binding from the app. This does not erase financial rows already copied locally.
- **Local financial-data deletion:** a separate, destructive, confirmed action removes the app-owned account history and artifacts. It cannot erase Plaid/American Express records, external exports, backups, filesystem snapshots, or copies elsewhere.

If the owner revokes an account or Item externally, stop using it, reflect `ITEM_LOGIN_REQUIRED` or revocation state, and apply the current contract/privacy retention rule. Do not silently relink it. Reauthorization uses a new owner-visible Link update-mode session; American Express consent expiration currently requires periodic refresh according to Plaid's OAuth guide.

## No-live-connection guarantee

Before any release enables this flow, it still needs implementation, sandbox tests, provider contract and Production approval, exact credential-reference wiring, redirect/webhook decision, institution and product coverage evidence, privacy/security review, UI consent and account-mapping review, sync/recovery tests, revocation/deletion tests, signed packaging, and a real-data pilot approved by the owner.

Even after those gates, neither a successful Sandbox run nor Plaid's general American Express/OAuth documentation guarantees that a particular card, transaction, statement period, consent flow, or ongoing connection will work. The app must show observed environment, last successful sync, consent expiry, product/account availability, and errors without labeling configuration alone as a live connection.

## Official Plaid references

- [Hosted Link](https://plaid.com/docs/link/hosted-link/)
- [Link API: `/link/token/create` and `/link/token/get`](https://plaid.com/docs/api/link/)
- [Link flow overview](https://plaid.com/docs/link/)
- [OAuth guide, registration, scoped consent, expiry, and revocation](https://plaid.com/docs/link/oauth/)
- [Sandbox](https://plaid.com/docs/sandbox/)
- [Items API: token exchange, Item status, token rotation, and removal](https://plaid.com/docs/api/items/)
- [Transactions](https://plaid.com/docs/transactions/)
- [Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Statements support](https://plaid.com/docs/statements/)
- [Production launch checklist](https://plaid.com/docs/launch-checklist/)

Plaid's API and enrollment requirements can change. Recheck these sources and the exact Plaid Dashboard configuration immediately before implementation and before each Production release.
