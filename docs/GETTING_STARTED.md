# Getting started on Windows

This guide is for safely evaluating the current Windows 11 local alpha. It is not a production release. Begin with the synthetic test path below. The app can then preview and import supported Japan statement files and create local accounting-import packages, but you must validate the results before relying on real financial data. Never enter an American Express password in this app.

## Install without a command line

No programming tools or terminal are needed for the UI test drive:

1. Open the repository's **Actions** page and choose the latest successful `CI` run for `main`.
2. Under **Artifacts**, download `unsigned-windows-installer`, then extract the downloaded ZIP.
3. Run the `.exe` only if it came from that successful repository run or another source you independently trust. The current test installer is unsigned; if Windows shows an unexpected or unverifiable warning, stop rather than disabling Windows protections.
4. Complete the installer, then open **Amex Local Finance Connector** from the Start menu. It will also appear in the Windows system tray.

The artifact normally expires after seven days and is for local evaluation only. A signed installer, verified update chain, and production release remain release gates.

## First launch

1. Start the app from a trusted test build. It opens in the Windows system tray; choose **Open dashboard** from the tray icon if the window is hidden.
2. Check the banner at the top of the dashboard. Demo mode must say that its data is synthetic. Normal mode starts with an empty encrypted database and an empty **Owner portfolio**; it does not add demo data.
3. Confirm that storage reports **unlocked**. The database is encrypted on disk and its key is protected for the signed-in Windows user when Windows secure storage is available. If secure storage is unavailable, the app must remain locked rather than save an unprotected key.
4. Leave connected sharing off for an initial test. No American Express provider connection or secure tunnel starts automatically.
5. Use **Lock** when stepping away. Locking closes decrypted local data and stops the local ChatGPT endpoint. Use **Exit** when finished; closing the dashboard can leave the tray app running.

The dashboard wires local account setup, owner-editable portfolio membership, two-phase Japan statement review/import, reviewed export-package creation, tunnel supervision, status, review-only alert dispositions, audit, lock, and local-data deletion. U.S. consent remains unavailable unless the owner separately configures an approved data provider.

## Choose the right account path

Each account is authorized or imported separately. Personal and company accounts never share credentials or silently inherit access from one another.

| Account path | Safe method | Current alpha status |
| --- | --- | --- |
| U.S. personal | Consent-based, read-only access through an independently approved data provider. The app never asks for or stores an Amex password. | **Configuration required.** A normalized provider/OAuth adapter is present, but no provider account, endorsement, or direct Amex connection is bundled. Authorization stays unavailable until all approved-provider settings and protected secret references validate. |
| U.S. company | The same approved read-only provider path, with separate consent and a company legal-entity label for each account. | **Configuration required.** Each company account gets its own local binding and token set; availability still depends on the owner's approved provider and its actual product coverage. |
| Japan personal | Import an official statement file that the account owner downloaded from Amex. No scraping and no Amex credential storage. | **Available locally.** Select a specific account, then review every candidate row (up to 1,000), signed totals, warnings, duplicates, reconciliation, and mapping fingerprint before choosing **Approve reviewed rows and import** or **Cancel preview**. |
| Japan company | Import an official statement while retaining the company legal entity, account class, and transaction context. | **Available locally**, through the same reviewed import path with separate account/entity attribution. |

Supported file type does not mean every issuer layout is recognized. Start with a copy, confirm the selected account and currency, inspect every parsed row and warning, and reconcile the transaction count and balances against the original statement. Scanned/image-only and encrypted PDFs are rejected; convert or OCR them outside this app and review the resulting data carefully.

## Understand the labels

- **Account name** is a safe display label for one source account. Use a nickname or masked ending, never a full card number.
- **Personal** and **company** are local classifications. They do not change Amex permissions or provide card controls.
- **Legal entity** identifies the person or company to which the account and expenses belong. It is separate from the display name.
- **Business purpose** is transaction-level context, especially for company expenses. It stays attached to the original transaction.

Changing a label must not merge accounts. Every transaction retains its source account, legal entity, country, currency, account class, and business-purpose metadata.

## Select an account or a portfolio

An **account** is one separately authorized or imported source. Use account selection for its status, transactions, statement, or alerts.

A **portfolio** is an owner-controlled local view over selected accounts. It can total personal and company activity across U.S. dollars and Japanese yen, but it is not a shared ledger and does not grant new provider access. Source details remain attached to every transaction. Adding or removing an account from a portfolio changes the view; it does not delete the account.

In normal unlocked mode, open **Portfolio**, edit the portfolio name if desired, select or clear account checkboxes, and choose **Save portfolio selection**. New accounts are selected automatically. Disconnected accounts cannot be newly selected. Demo mode presents its fixed synthetic portfolio read-only. Review the selection before saving: portfolio reports and portfolio-scoped account/alert lists use that owner-controlled membership boundary. Desktop imports and exports still require an explicit account selection and never silently use a current account.

Every ChatGPT request must name one account or one portfolio as required by that tool. There is no automatic “all accounts” scope, and even listing accounts requires a selected portfolio. A portfolio report may be unavailable if one of its required accounts needs review or reauthorization.

## Local-only mode and connected mode

The encrypted database, credentials, imported data, exports, and audit records stay on this Windows computer. The app has no shared ledger, cross-device sync, or automatic cloud backup.

In **local-only mode**, ChatGPT cannot reach the app. In an explicitly configured **connected mode**, a workspace-supported Secure MCP Tunnel can make an outbound HTTPS connection while the app is running, without opening the local service to the public internet. The tray app supervises only an already provisioned protected client profile and starts it only after the executable/checksum, loopback endpoint, and reviewed non-secret arguments pass validation; otherwise the connection controls remain unavailable or fail closed. Raw credentials are rejected in arguments and the process environment. Availability also depends on the intended OpenAI product and workspace permissions; see OpenAI's current [custom MCP app setup and access guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).

Connected mode is not fully local: the specific results returned to ChatGPT leave the computer and are processed by OpenAI. It does not upload the entire database or give ChatGPT direct file access. Never publish the local endpoint, open an inbound firewall port for it, or place it behind a public forwarding service.

## What ChatGPT can read

When the app is unlocked, an approved connection is active, and the required account or portfolio is selected, ChatGPT has only these seven read-only capabilities:

- list accounts within a selected portfolio;
- get one account's authorization and sync status;
- list transactions for one account;
- get one statement;
- get a report for one portfolio;
- list review-only fraud or anomaly alerts for one account; and
- explain one alert and its evidence.

These queries read data already stored locally. They do not start a provider sync, import a statement, or resolve an alert. Queries are recorded through the audit-log seam.

## What ChatGPT cannot do

ChatGPT cannot:

- make payments or transfers;
- control, freeze, or replace a card;
- open or submit a dispute;
- add, authorize, reauthorize, disconnect, configure, or delete an account;
- start a provider sync or import a statement;
- change categories, business purposes, legal entities, portfolios, or alert status;
- read raw statement files or local file paths;
- approve or create QuickBooks or Money Forward files; or
- upload or post anything to an accounting system.

Fraud alerts are review aids, not fraud determinations. Contact Amex through an official channel for suspected fraud or urgent card action.

## Review an alert locally

Open **Fraud review** to see alerts for the current portfolio. An open alert offers three owner-only dispositions: **Mark reviewed**, **Dismiss**, or **Flag as suspicious**. Each choice is a local, audited note about your review; it does not alter the transaction, notify Amex, block a card, open a dispute, or establish that fraud occurred. ChatGPT may list or explain the stored alert, but it cannot choose or change a disposition. Use an official Amex channel for any real account action.

## Safe installer test drive

You can complete this checklist entirely in the dashboard; no terminal or programming tools are required:

1. Use Windows 11 on a disposable test profile or virtual machine if possible, and start only a trusted local-test build. This installer is not signed for production; do not dismiss an unexpected security warning for an unknown build.
2. On first launch, leave connected sharing and tunnel software off. Confirm normal mode starts with an empty owner portfolio.
3. In **Getting started**, read all four account paths and choose one. Do not enter an Amex password, real account number, token, statement, or accounting data.
4. On step 4, choose **Run safe local test**. Confirm every check passes, including encrypted storage, the private MCP posture, exactly seven read-only tools, synthetic parsing/reconciliation/alerts, and in-memory export validation. A normal packaged first run passes the MCP-posture check by confirming that MCP is safely disabled and no listener is open; an explicitly configured local development test passes by confirming a loopback-only listener. The dry-run records are discarded.
5. Open **Accounts**. Enter `Japan test`, enter `Personal test` as the owner, select **Japan · personal**, and choose **Add account**. The account should say that its first import is needed—not that live Amex connectivity exists.
6. Open **Portfolio**. Confirm `Japan test` is selected, optionally change the portfolio name, and choose **Save portfolio selection**. Clearing membership changes only the portfolio view; it does not delete the account or its encrypted history. Keep the test account selected for the remaining steps.
7. Open **Statement imports**, select that account, and choose **Save a synthetic test CSV**. Save it to a new local test folder. Choose **Choose statement and build preview**, then select that CSV. This first phase must not import anything: it displays every candidate row, up to the 1,000-row limit, with its date, description, signed amount, category, and business purpose. Also compare the signed per-currency totals, duplicate count, full warning list, reconciliation result, mapping match count/fingerprint, source fingerprint, and expiry notice.
8. Choose **Cancel preview** once and confirm no rows were committed. Preview the same file again. Choose **Approve reviewed rows and import** only when every row and summary is expected; approval is the separate second phase and commits the still-matching preview atomically. A changed file, account state, category mapping, expired preview, or blocking validation result requires a new preview.
9. Confirm the account now reports local import data. Re-selecting the same CSV should show duplicate rows rather than silently creating a second copy.
10. If an open item appears under **Fraud review**, inspect its evidence and try one local disposition: **Mark reviewed**, **Dismiss**, or **Flag as suspicious**. Confirm the UI labels it as an owner status and does not claim that Amex was contacted or that the card was changed.
11. Open **Export packages**, select the test account, choose **QuickBooks CSV**, and enter a non-sensitive local account reference such as `AMEX-TEST`. Choose **Preview and create files**, read the exact fingerprint/checksum/duplicate confirmation, approve once, and select a new empty destination folder.
12. Inspect the created data file and `manifest.json`. Confirm the manifest has checksums and the app says nothing was uploaded. Repeat with QBO/QFX or one of the three Money Forward formats only if you want to test their mapping and encoding fields.
13. Confirm **Lock** stops the local endpoint and **Exit** removes the tray icon. Disconnect the test account or use **Settings → Delete local financial data** after reading both confirmations. Do not rely on uninstalling to erase data; backups and copies outside app-owned paths remain your responsibility.

## Disconnect, revoke, remove, and delete

These are different actions:

- **Disconnect** stops future collection and connected reads for an account. It does not erase previously imported local history.
- **Revoke consent** ends access at the approved data provider. When provider access exists, revocation at the provider and local disconnection are separate steps.
- **Remove from portfolio** only removes the account from that local view.
- **Delete account data** is a destructive local action that should separately identify transactions, statements, alerts, audit history, staged files, exports, and protected-secret references before deletion. Deleting local data would not revoke remote provider consent, and revoking consent would not delete local history.

The app can disconnect an account after confirmation; this stops its future reads but retains encrypted history. It also offers a separate, two-confirmation cleanup for the exact encrypted database and app-marked import, export, and log paths after showing an inventory. That cleanup intentionally retains onboarding preferences and does not revoke provider consent, remove tunnel profiles, erase copies stored elsewhere, guarantee SSD/backup erasure, or delete one account selectively. Revoke U.S. consent through the configured provider's official controls as a separate step. Uninstalling must not be assumed to erase local data, and locking or exiting is not the same as revoking consent.

## Learn more

- [Windows setup and connected-mode boundaries](WINDOWS_SETUP.md)
- [Read-only ChatGPT tool contract](MCP_TOOLS.md)
- [Import and export limitations](IMPORT_EXPORT.md)
- [Threat model](THREAT_MODEL.md)
- [Implementation and release gates](IMPLEMENTATION_PLAN.md)
