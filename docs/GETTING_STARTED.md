# Getting started on Windows

This guide is for the installed Windows 11 app. The current build is a local alpha, so begin with the built-in test before using a real statement. The safe test and Japan statement import work now. U.S. connection stays unavailable until a separately approved read-only provider is configured and the app's readiness check passes.

**Never enter an American Express password, one-time code, security answer, or full card number in this app.** Japan setup uses a statement file you downloaded yourself. A ready U.S. setup uses a provider's separate consent page, not an Amex password form inside this app.

## What you can use now

| Path | Status | What happens |
| --- | --- | --- |
| Safe local test | **Ready—start here** | Seven checks run with fake transactions in memory. No account or transaction is saved, no sign-in opens, and nothing connects to Amex or an accounting service. |
| Japan personal or company | **Ready now** | Create a nickname-only local account, choose an official CSV, Excel, QIF, or text-based PDF statement, review every parsed row, then approve or cancel. |
| U.S. personal or company | **Unavailable until readiness passes** | An unconfigured app adds no U.S. account and opens no sign-in page. An administrator must arrange and configure a separately approved read-only provider first. |

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

## If you choose a U.S. account

In a normal test installation, U.S. cards say **Not available yet**. Selecting one offers **Use the safe local path instead** and **Show what U.S. access needs**. Until the readiness check says **Ready for consent**, you cannot continue through the U.S. path, the U.S. choices on **Accounts** remain disabled, no account is added, and no browser sign-in opens. Reinstalling or entering an Amex password will not enable it.

Plaid Hosted Link is being evaluated as a future **U.S. personal card** path, but it is not implemented in this build. Adding Plaid keys will not enable it. The intended future experience is: choose **Connect with Plaid**, review the read-only Transactions request, continue in the system browser, authenticate and choose exactly one intended card on the external Plaid/American Express pages, return to the app, inspect the verified institution and masked account, then confirm the local mapping. Closing or cancelling the browser must leave the account unconnected.

The app itself must never ask for an Amex password or one-time code. An expected external Plaid or American Express page may ask you to authenticate as part of its own consent flow; check the browser address and never paste those values into this app. Only transaction access is in the proposed scope—no payment, transfer, card control, dispute, or Plaid statement-PDF access. Plaid currently documents Statements for depository accounts, not credit cards.

Sandbox uses mock institutions and cannot prove that a real American Express card will work. Production uses real financial data and requires separate Plaid access, registration, protected credentials, and a completed security/privacy review. Even after implementation, provider coverage and consent can change and no live connection can be guaranteed. See the [future Plaid Hosted Link design](PLAID_HOSTED_LINK.md) for the planned owner flow, external enrollment, cancellation/recovery, and revoke/delete distinctions. Administrators should also read [Windows setup](WINDOWS_SETUP.md#us-account-authorization) and [environment and secret configuration](CONFIGURATION.md#us-aggregation-variables).

## Back out, retry, or recover

| Situation | Safe action | Result |
| --- | --- | --- |
| Wrong guide option | Choose **Back** or **Start over**. | Choosing a path creates nothing. |
| Guide was closed | Choose **Getting started** in the sidebar, or **Settings → Getting started**. | You can restart it at any time. |
| Wrong file | Cancel the file picker or choose **Cancel preview**. | No transactions are stored. |
| Preview expired or source changed | Cancel and choose the statement again. | A fresh preview must be reviewed. |
| Wrong target account | Choose **Cancel preview**, select the correct Japan account, and rebuild it. | The cancelled preview cannot be committed. |
| Stepping away | Choose **Settings → Lock local data**. | Decrypted local state and the local endpoint close where supported. |
| Finished | Use **Exit** from the tray menu. | Closing only the dashboard may leave the tray app running. |

**Disconnect** retains encrypted history. **Remove from portfolio** only changes combined reports. **Settings → Delete local financial data** is the separate destructive cleanup: it inventories app-owned paths and asks for two confirmations, but cannot erase external copies or backups or revoke provider-side consent. Do not assume uninstalling deletes data.

## After your first import

- **Portfolio** controls which accounts appear in combined reports; it does not merge or delete them.
- **Fraud review** statuses are local notes only. They do not contact Amex, block a card, or open a dispute.
- **Export packages** creates reviewed local QuickBooks or Money Forward files; it never uploads them automatically.
- Leave **ChatGPT connection** off unless an administrator has provisioned and verified it. Japan import works in local-only mode.

ChatGPT's seven tools can read only explicitly selected account/portfolio data and explain review alerts. They cannot pay, transfer, control a card, dispute, authorize, sync, import, approve, export, change data, delete, or upload anything.

## Development screenshots

The unsigned local-alpha installer may show **Settings → Allow screenshots this session** for synthetic documentation testing. Use it only when every visible value is fake. Read and confirm the native warning, check for the **Screenshots allowed** badge and persistent warning, take the minimum necessary capture, then choose **Turn protection back on**. The choice is not saved; exiting and relaunching the app restores protection.

Never disable protection or take a screenshot while a real statement, account, provider page, credential, token, personal local path, or other financial data is visible. Future signed/production builds do not expose this control. Source developers should follow [the isolated screenshot-run instructions](WINDOWS_SETUP.md#development-only-ui-screenshots).

## Learn more

- [Windows setup and connected-mode boundaries](WINDOWS_SETUP.md)
- [Import and export details](IMPORT_EXPORT.md)
- [Read-only ChatGPT tool contract](MCP_TOOLS.md)
- [Threat model](THREAT_MODEL.md)
