# Getting started on Windows

This guide is for the installed Windows 11 app. The current build is a local alpha, so begin with the built-in test before using a real statement or provider. The safe test, Japan statement import, and a Plaid Sandbox path for one U.S. personal card are included. A real U.S. connection still requires your own approved Plaid Production app and confirmed American Express Transactions coverage.

**Never enter an American Express password, one-time code, security answer, or full card number in this app.** Japan setup uses a statement file you downloaded yourself. A ready U.S. setup uses a provider's separate consent page, not an Amex password form inside this app.

## What you can use now

| Path | Status | What happens |
| --- | --- | --- |
| Safe local test | **Ready—start here** | Seven checks run with fake transactions in memory. No account or transaction is saved, no sign-in opens, and nothing connects to Amex or an accounting service. |
| Japan personal or company | **Ready now** | Create a nickname-only local account, choose an official CSV, Excel, QIF, or text-based PDF statement, review every parsed row, then approve or cancel. |
| U.S. personal | **Sandbox setup included** | Supply your own Plaid Sandbox app credentials, then connect exactly one fake credit card through Plaid Hosted Link in your browser. Production is conditional and has not been live verified. |
| U.S. company | **Not in this test release** | The choice remains disabled and no consent starts. |

## Your first five minutes

1. Start **Amex Local Finance Connector**. If its window is hidden, open the Windows system-tray icon and choose **Open dashboard**.
2. On **Getting started → Welcome**, choose **Start the safe test**.
3. The app opens **Test** and runs seven checks. Confirm that all seven show a check mark: encrypted storage, private local MCP posture, the read-only ChatGPT boundary, synthetic Japan parsing, validation/duplicate/balance checks, review-only alerts, and human-reviewed accounting exports.
4. The fake data is discarded. The test creates no account, file, or saved transaction.
5. To try a Japan statement, choose **Start over**, then **Continue**. Select **Japan personal card** or **Japan company card** and choose **Continue to my plan**.
6. Read the plan, continue past the completed test, and choose **Finish and add my Japan account**. The app opens **Accounts** and places the cursor in the first account field.

If you only want to explore with no real data, choose **Continue to finish** after the test, then **Finish and explore locally**.

If a safe-test check fails, do not use a real statement yet. Confirm the local store is unlocked, exit the tray app, and start it again. If the same check still fails, keep the app local and empty until the problem is fixed.

## Add a Japan account

On **Accounts**:

1. Enter a nickname such as `Japan travel card` in **Account label**. Do not enter a full account or card number.
2. Enter a useful label such as `Personal` or your company name in **Owner or company**.
3. Choose **Japan · personal — ready** or **Japan · company — ready**.
4. Choose **Create local Japan account**.

This creates an encrypted, import-only record on this PC. It does not contact Amex or claim a live connection. A new active account joins the local portfolio by default; you can change that later under **Portfolio** without deleting it.

## Choose, review, and import a Japan statement

Use a copy of an official statement export. Supported inputs are CSV, `.xlsx`, QIF, and text-based PDF. A supported extension does not guarantee every issuer layout will parse correctly, so compare the preview with the original. Scanned/image-only and encrypted PDFs are rejected.

1. On the new account card, choose **Choose statement**.
2. Select the statement in the Windows file picker. Cancelling the picker changes nothing.
3. The app preselects that account, opens **Official statement imports**, builds the preview, and moves focus to the visible review panel.
4. Check the file and format, row count, signed total by currency, duplicates, reconciliation, local mappings, source fingerprint, warnings, and expiry time.
5. Review every row, especially its date, description, amount sign, currency, category, and business purpose. A preview contains at most 1,000 candidate rows.
6. Use the buttons directly below the preview:
   - **Cancel preview** discards it and stores no transactions.
   - **Approve reviewed rows and import** commits the still-matching rows to the encrypted local store in one operation.
7. After approval, compare the imported, parsed, duplicate, and warning counts with what you expected.

For optional balance reconciliation, open **Statement imports** before choosing the file. Enter the period start, period end, opening balance, and closing balance together, or leave all four blank.

For a no-risk practice run of the visible review screen, choose **Save a synthetic test CSV**, save it in a temporary folder, and select that file. Try **Cancel preview** once, reopen it, and approve only after checking the rows and summary.

## Where approval appears

The Windows file picker only chooses a file. After selection, the app returns to **Official statement imports** and shows the complete preview in that page. **Cancel preview** and **Approve reviewed rows and import** appear immediately below it.

If the file, selected account, account data, or category mapping changes—or the preview expires—the old approval is rejected. Choose the statement again and review the new preview.

## Test a U.S. personal card with Plaid Sandbox

Plaid is a separate service, so first create your own Plaid developer account and obtain its **client ID** and **Sandbox secret** from **Plaid Dashboard → Developers → Keys**. In the Plaid Dashboard's Link customization, set **Account Select** to **Enabled for one account**. Do not use an Amex password, card number, or consumer Plaid login in the app's credential fields.

Then, in the app:

1. Open **Accounts** and choose **Open step-by-step guide**.
2. Leave **Connection environment** on **Sandbox — fake account, recommended first**.
3. Enter your Plaid client ID and Sandbox secret. Read the boundary statement, check its box, then choose **Check and save Plaid credentials**. This verifies your Plaid app credentials and stores them for this Windows user in Windows Credential Manager. It does not create an account, contact Amex, or grant consent.
4. Enter a nickname and owner in **Account label** and **Owner or company**. Leave **U.S. · personal — guided setup** selected, then choose **Continue to read-only consent**.
5. The app creates the local account and opens Plaid Hosted Link in your normal browser. Choose **First Platypus Bank**, enter Plaid's public fake credentials `user_good` / `pass_good`, and select its single credit card. Select exactly one card.
6. Complete the Plaid page and return to the app. The app checks the Hosted Link result, accepts only one personal credit or charge card from the expected Sandbox institution, saves its protected per-account grant, and attempts the initial Transactions sync. The account card shows **Consent stored** when authorization succeeds. If consent succeeds but the first sync does not, choose **Check & sync** to retry without reopening consent.

Closing or cancelling the browser does not make the local account usable. Because the local nickname is created before the browser opens, its account card can remain in the app; choose **Resume consent** when the original correlation remains recoverable, **Reconnect** after a confirmed cancellation, or **Disconnect** to retire it. Never infer success from a browser redirect or closed window—only the app's final status counts.

If the app exits or loses network access while a new Hosted Link session is still unresolved, it retains that one pending correlation only in the encrypted local vault. Reopen the app and choose **Resume consent** on the account card; the app checks the same session instead of creating a duplicate Plaid Item. **Disconnect** explicitly discards the pending local recovery record. If the app says provider cleanup is unconfirmed, also review and revoke the connection through official Plaid or institution controls before retrying.

The desktop app itself never asks for an Amex username, password, one-time code, security answer, or full card number. A genuine external Plaid or American Express page may request authentication during Production consent; inspect the browser address before entering anything. The app requests only Plaid Transactions for one credit or charge card—no payment, transfer, account/routing-number Auth, card control, or dispute capability.

### Moving from Sandbox to Production

Production is not unlocked by passing the Sandbox test. Apply for Plaid Production access, complete Plaid's current business, security, institution, and product requirements, and verify that the exact Plaid app is approved for American Express and Transactions. In the Plaid Dashboard, use **Developers → Keys** to collect the same team client ID and the separate **Production secret**. Coverage, consent behavior, and individual-card availability can change. This alpha has no verified live Production guarantee.

Choose **Production — real account, Plaid approval required**, use that Plaid app's Production secret, and configure **OAuth return URL (optional on desktop)** when your Plaid tenant or institution setup requires it. For this external-browser desktop flow Plaid can support OAuth without a redirect URI, but an applicable URI is recommended and must be an owned plain HTTPS URL already allowlisted in the Plaid Dashboard, with no query or fragment. Do not guess one.

The Plaid credential check proves only that the submitted app registration reaches the selected environment; it does not prove American Express is enabled or that Transactions will be available. The later consent flow performs the account and institution checks. Sandbox data is fake, while a Plaid Production trial uses real financial data.

### Reconnect, disconnect, and delete

If an account card says **Reconnect needed**, choose **Reconnect**. Plaid Hosted Link opens in update mode for the same Item and account binding; complete the owner-visible repair or consent refresh. The app does not silently create a replacement account. If you already disconnected the account, add a new separately identified local account instead.

**Disconnect** first stops local reads, removes the local protected token and exact-account binding, and then asks Plaid to remove the Item. Read the result: if remote revocation is not confirmed, also revoke access through the official Plaid or institution controls. Existing encrypted transaction history remains until you separately use **Settings → Delete local financial data**. That deletion removes inventoried app-owned local data after two confirmations; it does not revoke provider consent or erase Plaid, Amex, backup, export, or other external copies.

To remove only the Plaid developer app client ID and secret from Windows Credential Manager, disconnect every active U.S. account, then choose **Settings → Remove Plaid app credentials**. This does not close your Plaid developer account or erase external copies.

Plaid Transactions supplies transaction data, not credit-card statement documents. The app therefore reports statements unavailable for this connection; use a separately reviewed official statement source when a PDF is required. See [Plaid Hosted Link setup and technical boundary](PLAID_HOSTED_LINK.md) and [Windows setup](WINDOWS_SETUP.md#us-account-authorization).

## Back out, retry, or recover

| Situation | Safe action | Result |
| --- | --- | --- |
| Wrong guide option | Choose **Back** or **Start over**. | Choosing a path creates nothing. |
| Guide was closed | Choose **Getting started** in the sidebar, or **Settings → Getting started**. | You can restart it at any time. |
| Wrong file | Cancel the file picker or choose **Cancel preview**. | No transactions are stored. |
| Preview expired or source changed | Cancel and choose the statement again. | A fresh preview must be reviewed. |
| Wrong target account | Choose **Cancel preview**, select the correct Japan account, and rebuild it. | The cancelled preview cannot be committed. |
| Plaid setup values are wrong | Choose **Hide setup**, correct the Plaid app/environment values, and run **Check and save Plaid credentials** again. | No U.S. account or Amex consent is created by the credential check. |
| Plaid browser flow was interrupted or cancelled | Return to the account card and choose **Resume consent** when shown, otherwise **Reconnect**; choose **Disconnect** to retire the pending local account. | A browser window alone does not make the account authorized. |
| U.S. account says **Reconnect needed** | Choose **Reconnect** and finish Plaid's update-mode flow for that same account. | The existing Item/account binding is repaired without silently replacing it. |
| Stepping away | Choose **Settings → Lock local data**. | Decrypted local state and the local endpoint close where supported. |
| Finished | Use **Exit** from the tray menu. | Closing only the dashboard may leave the tray app running. |

**Disconnect** retains encrypted history. For Plaid accounts it also requests provider Item removal, but you must read whether remote revocation was confirmed. **Remove from portfolio** only changes combined reports. **Settings → Delete local financial data** is the separate destructive cleanup: it inventories app-owned paths and asks for two confirmations, but cannot erase external copies or backups or revoke provider-side consent. Do not assume uninstalling deletes data.

## After your first import

- **Portfolio** controls which accounts appear in combined reports; it does not merge or delete them.
- **Fraud review** statuses are local notes only. They do not contact Amex, block a card, or open a dispute.
- **Export packages** creates reviewed local QuickBooks or Money Forward files; it never uploads them automatically.
- Leave **ChatGPT connection** off unless an administrator has provisioned and verified it. Japan import works in local-only mode.

ChatGPT's seven tools can read only explicitly selected account/portfolio data and explain review alerts. They cannot pay, transfer, control a card, dispute, authorize, sync, import, approve, export, change data, delete, or upload anything.

## Development screenshots

The unsigned local-alpha installer shows **Allow screenshots** in the top bar and the equivalent **Settings → Allow screenshots this session** control for synthetic documentation testing. Use it only when every visible value is fake. Read and confirm the native warning, check for the **Screenshots allowed** badge and persistent warning, take the minimum necessary capture, then choose **Turn protection back on**. The choice is not saved; exiting and relaunching the app restores protection.

Never disable protection or take a screenshot while a real statement, account, provider page, credential, token, personal local path, or other financial data is visible. Future signed/production builds do not expose this control. Source developers should follow [the isolated screenshot-run instructions](WINDOWS_SETUP.md#development-only-ui-screenshots).

## Learn more

- [Windows setup and connected-mode boundaries](WINDOWS_SETUP.md)
- [Import and export details](IMPORT_EXPORT.md)
- [Read-only ChatGPT tool contract](MCP_TOOLS.md)
- [Threat model](THREAT_MODEL.md)
