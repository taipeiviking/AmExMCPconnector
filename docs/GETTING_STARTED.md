# Getting started on Windows

This guide is for safely evaluating the current Windows 11 scaffold. It is not a production release. Use synthetic demo data only: do not enter an American Express password, import a real statement, or connect a real accounting file yet.

## Install without a command line

No programming tools or terminal are needed for the UI test drive:

1. Open the repository's **Actions** page and choose the latest successful `CI` run for `main`.
2. Under **Artifacts**, download `unsigned-windows-installer`, then extract the downloaded ZIP.
3. Run the `.exe` only if it came from that successful repository run or another source you independently trust. The current test installer is unsigned; if Windows shows an unexpected or unverifiable warning, stop rather than disabling Windows protections.
4. Complete the installer, then open **Amex Local Finance Connector** from the Start menu. It will also appear in the Windows system tray.

The artifact expires after seven days and is for synthetic local evaluation only. A signed installer, verified update chain, and production release remain release gates.

## First launch

1. Start the app from a trusted test build. It opens in the Windows system tray; choose **Open dashboard** from the tray icon if the window is hidden.
2. Check the banner at the top of the dashboard. Demo mode must say that its data is synthetic. Normal mode starts with an empty encrypted database and an empty **Owner portfolio**; it does not add demo data.
3. Confirm that storage reports **unlocked**. The database is encrypted on disk and its key is protected for the signed-in Windows user when Windows secure storage is available. If secure storage is unavailable, the app must remain locked rather than save an unprotected key.
4. Leave connected sharing off for an initial test. No American Express provider connection or secure tunnel starts automatically.
5. Use **Lock** when stepping away. Locking closes decrypted local data and stops the local ChatGPT endpoint. Use **Exit** when finished; closing the dashboard can leave the tray app running.

The dashboard is currently a scaffold. Some buttons explain planned behavior without completing the action.

## Choose the right account path

Each account is authorized or imported separately. Personal and company accounts never share credentials or silently inherit access from one another.

| Account path | Intended safe method | Current scaffold status |
| --- | --- | --- |
| U.S. personal | Consent-based, read-only access through an approved data provider. The app must never ask for or store an Amex password. | **Unavailable.** No approved provider or production consent flow is configured. The dashboard only explains this limitation. |
| U.S. company | The same approved read-only provider path, with separate consent and a company legal-entity label for each account. | **Unavailable.** Company consent and provider mapping are not implemented. |
| Japan personal | Import an official statement file that the account owner downloaded from Amex. No scraping and no Amex credential storage. | **Local account setup plus file preview only.** You can save an encrypted nickname/owner classification, but the chooser does not yet commit imported transactions. CSV and QIF parser foundations exist but are not certified against production Amex formats. Excel and PDF parsing are not implemented. |
| Japan company | Import an official Amex statement, then retain the company legal entity, account class, and transaction business purpose. | **Local account setup plus file preview only**, with the same parser and release-gate limitations as Japan personal accounts. |

Do not treat the presence of CSV, Excel, QIF, or PDF in the file chooser as production support. Real-statement import remains blocked until format fixtures, reconciliation, error handling, and end-to-end import review pass the release gate.

## Understand the labels

- **Account name** is a safe display label for one source account. Use a nickname or masked ending, never a full card number.
- **Personal** and **company** are local classifications. They do not change Amex permissions or provide card controls.
- **Legal entity** identifies the person or company to which the account and expenses belong. It is separate from the display name.
- **Business purpose** is transaction-level context, especially for company expenses. It stays attached to the original transaction.

Changing a label must not merge accounts. Every transaction retains its source account, legal entity, country, currency, account class, and business-purpose metadata.

## Select an account or a portfolio

An **account** is one separately authorized or imported source. Use account selection for its status, transactions, statement, or alerts.

A **portfolio** is an owner-controlled local view over selected accounts. It can total personal and company activity across U.S. dollars and Japanese yen, but it is not a shared ledger and does not grant new provider access. Source details remain attached to every transaction. Adding or removing an account from a portfolio changes the view; it does not delete the account.

Every ChatGPT request must name one account or one portfolio as required by that tool. There is no automatic “all accounts” scope, and even listing accounts requires a selected portfolio. A portfolio report may be unavailable if one of its required accounts needs review or reauthorization.

## Local-only mode and connected mode

The encrypted database, credentials, imported data, exports, and audit records stay on this Windows computer. The app has no shared ledger, cross-device sync, or automatic cloud backup.

In **local-only mode**, ChatGPT cannot reach the app. In a future configured **connected mode**, a supported [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) can make an outbound-only connection while the app is running, without opening the local service to the public internet. The current scaffold does not start or manage that tunnel for you.

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

## Safe installer test drive

You can complete this checklist entirely in the dashboard; no terminal or programming tools are required:

1. Use Windows 11 on a disposable test profile or virtual machine if possible, and start only a trusted local-test build. This installer is not signed for production; do not dismiss an unexpected security warning for an unknown build.
2. On first launch, leave connected sharing and tunnel software off. Confirm normal mode starts with an empty owner portfolio.
3. In **Getting started**, read all four account paths and choose one. Do not enter an Amex password, real account number, token, statement, or accounting data.
4. On step 4, choose **Run safe local test**. Confirm all four checks pass: encrypted storage, loopback-only MCP, exactly seven read-only tools, and a discarded synthetic CSV dry-run.
5. Open **Accounts** and confirm any supplied demo build explicitly says **Synthetic demo data**. Demo accounts are fictional. A normal build remains empty until you create a local Japan nickname; doing so still imports no transaction data.
6. Select **Check local status**. A newly created Japan account must say that its first import is still needed, not that live Amex connectivity exists.
7. Treat statement selection and export actions as placeholders. Verify that no real file is committed and no accounting package is created.
8. Confirm **Lock** stops the local endpoint and **Exit** removes the tray icon. Do not rely on uninstalling to erase data; backup, recovery, key rotation, secure deletion, code signing, and the update chain remain release work.

## Disconnect, revoke, remove, and delete

These are different actions:

- **Disconnect** stops future collection and connected reads for an account. It does not erase previously imported local history.
- **Revoke consent** ends access at the approved data provider. When provider access exists, revocation at the provider and local disconnection are separate steps.
- **Remove from portfolio** only removes the account from that local view.
- **Delete account data** is a destructive local action that should separately identify transactions, statements, alerts, audit history, staged files, exports, and protected-secret references before deletion. Deleting local data would not revoke remote provider consent, and revoking consent would not delete local history.

The current scaffold can disconnect a local Japan import-only account after confirmation; this stops its future reads but retains encrypted history. It also offers a separate, two-confirmation cleanup for the exact encrypted database and app-marked import, export, and log paths after showing an inventory. That cleanup intentionally retains onboarding preferences and does not revoke provider consent, remove tunnel profiles, erase copies stored elsewhere, guarantee SSD/backup erasure, or delete one account selectively. Live-provider revocation, per-account data deletion, and a complete secure-wipe workflow remain release gates. Uninstalling must not be assumed to erase local data, and locking or exiting is not the same as revoking consent. Use synthetic data only in this scaffold.

## Learn more

- [Windows setup and connected-mode boundaries](WINDOWS_SETUP.md)
- [Read-only ChatGPT tool contract](MCP_TOOLS.md)
- [Import and export limitations](IMPORT_EXPORT.md)
- [Threat model](THREAT_MODEL.md)
- [Implementation and release gates](IMPLEMENTATION_PLAN.md)
