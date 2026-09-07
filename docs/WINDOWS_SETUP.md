# Windows 11 setup

This is the administrator and developer setup reference. It is not required for the safe local test or Japan statement import. Most first-time users should begin with [Getting started on Windows](GETTING_STARTED.md). Built-in Plaid setup is available for a U.S. personal card, but no U.S. account or browser consent starts until the credential/readiness check passes; never try to enable it with an Amex password.

## Developer setup

Prerequisites:

- Windows 11 x64 with current security updates.
- Node.js 22.12 or newer and npm.
- Git and, for repository publishing, GitHub CLI authenticated to the intended account.
- No Amex credentials. Start with synthetic data during development and use only separately approved provider test credentials when exercising the optional U.S. adapter.

From PowerShell:

```powershell
git clone https://github.com/taipeiviking/AmExMCPconnector.git
Set-Location .\AmExMCPconnector
npm ci
Copy-Item .env.example .env
npm run verify
npm run dev:demo
```

The copied `.env` is ignored and is development configuration only. Leave all `_REF` placeholders unchanged unless the corresponding optional adapter is being configured. `npm run dev` starts with an empty local store; `npm run dev:demo` explicitly opts into synthetic accounts.

Runtime files default to `%LOCALAPPDATA%\AmexLocalFinanceConnector`, outside the repository. Use **Settings → Delete local financial data** to inventory and remove app-owned encrypted data/import/export/log paths after two confirmations; it deliberately does not erase external copies, backups, onboarding preferences, tunnel profiles, or provider-side consent. Do not make the runtime directory a Git working directory.

### Development-only UI screenshots

Windows content protection is enabled by default and must remain enabled for production and any real financial data. If a developer needs a screenshot for documentation, use only synthetic local data:

1. Exit every running app instance from the system tray; closing the dashboard is not enough.
2. Confirm that no real statement, account data, provider consent page, credential, token, log, or identifying local path will be visible.
3. Start the explicit screenshot run with `npm run dev:screenshots`. It enables demo data, uses the isolated `local-data/screenshot-development` directory, and disables content protection for that development run, so it cannot display the normal existing real-data store. If configuring the process manually, use `AMEX_APP_ENV=development`, `AMEX_DEMO_MODE=true`, an isolated `AMEX_DATA_DIR`, and `AMEX_SCREENSHOT_PROTECTION=false` only for that run.
4. Capture only the synthetic app UI, inspect the image before saving or sharing it, then exit the tray app.
5. Restore `AMEX_SCREENSHOT_PROTECTION=true` and restart before opening or importing real data.

The environment setting is read when the process starts. Production configuration rejects `false`. Windows content protection is defense in depth rather than protection from cameras or sufficiently privileged capture software, so sensitive screens still must not be captured.

Every packaged launch forces protection on, even if a process environment tries to disable it. The repository's `npm run package:win` path creates an explicitly marked **unsigned-alpha** artifact that then shows **Settings → Allow screenshots this session** for synthetic documentation work. Disabling requires a native confirmation and immediately displays a **Screenshots allowed** badge and persistent warning. Choose **Turn protection back on** when finished. The choice is never persisted, so fully exiting and relaunching the app restores protection. Future signed/production artifacts do not expose this control; a missing or invalid build-channel marker also hides it.

## Local-only mode

Packaged production starts with `AMEX_MCP_MODE=disabled`. To enable local MCP for persistent financial data, set `AMEX_MCP_MODE=local`, keep `AMEX_MCP_HOST=127.0.0.1`, leave `OPENAI_TUNNEL_ENABLED=false`, select `AMEX_MCP_AUTH_MODE=bearer`, and point `AMEX_MCP_BEARER_TOKEN_REF` to a strong random token in the current user's Windows Generic Credential store. The tray app then starts a bearer-protected loopback Streamable HTTP endpoint at `http://127.0.0.1:43121/mcp`. The endpoint exposes read-only financial queries; account setup, imports, exports, and approvals remain desktop-only. Development synthetic test mode may use `loopback-only`; production rejects it.

Do not create a Windows Firewall inbound allow rule, port forward, reverse proxy, or router mapping for the MCP port.

## Private ChatGPT connection with Secure MCP Tunnel

ChatGPT cannot call `127.0.0.1` on this computer directly. The intended private design uses a workspace-authorized OpenAI Secure MCP Tunnel only while the desktop app is running. Public documentation reviewed for this alpha does not establish that the tunnel product or a Windows client is generally available, so connected mode must stay disabled unless the intended organization receives authoritative setup instructions:

1. Confirm through the intended OpenAI organization/workspace administrator that Secure MCP Tunnel is actually available and obtain the current authoritative role, provisioning, and client instructions. Do not infer role names or invent a Platform URL from this repository.
2. Associate only the intended organization and ChatGPT workspace. ChatGPT developer-mode/custom-app access is a separate workspace control described in the current [official custom MCP app guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta).
3. Obtain the exact tunnel client only through that authoritative channel. The public guide does not establish a stable, generally available Windows download or CLI contract, so this repository intentionally provides no guessed install command.
4. Provision and test a protected client profile outside this app, following the authoritative instructions supplied for that exact client build and account. Do not place a runtime key or other secret in command-line arguments, process environment variables, `.env`, or an app-managed profile.
5. Record the installed executable's absolute path and SHA-256, and review the non-secret arguments needed to point that already provisioned profile at `http://127.0.0.1:43121/mcp`. Configure only those values described in [Configuration](CONFIGURATION.md).
6. Start the tray app and confirm the local MCP endpoint is healthy. The app re-hashes the executable immediately before launch and rejects unreviewed placeholders, secret-looking arguments, public-listen flags, non-loopback local targets, or an incomplete configuration.
7. In the supported OpenAI product/workspace connection flow, select the intended tunnel and verify the seven expected read-only tools and their schemas before use.
8. Stop the private connection or exit the tray app when remote access is not needed. The application guarantees only that its local MCP listener stays on loopback and that the reviewed child launch plan is outbound-only; verify the actual client's network behavior independently before using financial data.

Tunnel credentials, OAuth tokens, and any `sk-...` value must never appear in `.env`, process environment variables, command-line arguments, PowerShell profiles/history, source files, screenshots, logs, or support bundles. The app records only tunnel status and non-secret IDs. Tray-managed start is fail-closed: all required settings, the loopback target, reviewed arguments, executable identity, and expected SHA-256 must validate. Auto-start remains off by default and should stay off until the operator has completed an environment-specific security review.

## U.S. account authorization

The local alpha includes a built-in Plaid Hosted Link path for one **U.S. personal credit or charge card** per consent. It also retains a distinct normalized `approved-provider-generic` adapter. Do not point the generic OAuth endpoints or `normalized_v1` paths at Plaid; the built-in path uses Plaid's fixed HTTPS API and exact schemas. Neither implementation is a direct Amex connection or an endorsement.

### First test: Plaid Sandbox

1. Create or open your own Plaid developer account and obtain its client ID and Sandbox secret.
2. In the Plaid Dashboard's Link customization, set **Account Select** to **Enabled for one account**.
3. In the app, open **Accounts → Open step-by-step guide**, select **Sandbox**, enter those two Plaid app credentials, confirm the read-only boundary, and choose **Check and save Plaid credentials**. The values are verified against Sandbox and written to the current Windows user's Generic Credential store; they are not written to `.env`, the database, logs, or Git.
4. Enter a nickname and owner, leave **U.S. · personal — guided setup** selected, and choose **Continue to read-only consent**.
5. In the external Plaid browser page choose **First Platypus Bank**, use the public fake credentials `user_good` / `pass_good`, and select its single credit card. Select exactly one account.
6. Return to the app and read its final status. The implementation requests only `products: ["transactions"]`, filters to `credit card` and `charge card`, rejects multiple Items/accounts, verifies the returned institution ID/name through `/institutions/get_by_id`, exchanges the short-lived public token in privileged code, and stores the per-Item access token under the encrypted local boundary.

Sandbox is mock data. It can test the application's Hosted Link, correlation, validation, sync, and failure handling, but cannot reproduce or prove American Express's Production OAuth behavior or Transactions coverage.

### Production prerequisites

Before selecting **Production — real account, Plaid approval required**:

1. Obtain Plaid Production access through the applicable paid or trial path and complete Plaid's current application, company, security, institution, and product requirements. A Plaid trial is Production and uses real financial data; it is not Sandbox.
2. Confirm in Plaid's current Coverage Explorer/Dashboard that the exact Production client is enabled for American Express and Transactions for the intended U.S. credit/charge-card account. A successful app-credential check does not prove this.
3. Review Plaid's contract, billing, privacy disclosure, subprocessors, retention/deletion duties, breach process, and owner consent text. Test consent, sync, update mode, revocation, error recovery, and deletion with an explicitly authorized pilot.
4. Use separate protected Production credentials. Never copy Sandbox Items/tokens/data into Production or reuse one account's Item/account binding for another.

For this desktop external-browser Hosted Link flow, Plaid documents that web OAuth can function without `redirect_uri`. A reviewed Production redirect is nevertheless recommended and may be required by the Plaid tenant or institution setup. If used, enter it as **OAuth return URL (optional on desktop)** or configure `AMEX_US_PLAID_REDIRECT_URI`; it must be an owned plain HTTPS URL already present in the Plaid Dashboard's Allowed redirect URIs, with no credentials, query, or fragment. Do not confuse this OAuth return URL with Hosted Link's `completion_redirect_uri`; a redirect is not proof that consent succeeded.

Production remains conditional even after configuration. This repository does not supply Plaid access, and the maintainers have not verified a live Production Amex connection. Coverage, consent duration, individual-card availability, data completeness, and uptime can change.

### Consent lifecycle and cleanup

The desktop opens Hosted Link in the system browser and checks completion through bounded `/link/token/get` polling. It never displays a form for an Amex password. A genuine external Plaid or Amex page may ask the owner to authenticate; inspect the address and never copy credentials, codes, card numbers, Link/public/access tokens, or consent screens into this app, logs, screenshots, or support messages.

Use **Reconnect** when an active account says **Reconnect needed**. The Plaid path creates an update-mode Link token with the existing Item access token and keeps the same exact account binding; it does not silently create a replacement Item. If that protected Item/binding is missing, the repair fails closed. A disconnected local account cannot be reactivated; create a separately identified account if the owner intentionally connects again.

Use **Disconnect** to stop local reads, remove the local protected token/binding, and request Plaid `/item/remove`. Treat provider revocation as confirmed only when the app reports it; otherwise also revoke through official Plaid or institution controls. Disconnect retains encrypted transaction history. **Settings → Delete local financial data** is a separate two-confirmation local cleanup and cannot revoke Plaid/Amex consent or erase external copies. After all active U.S. accounts are disconnected, **Settings → Remove Plaid app credentials** removes only the saved developer client ID and secret from Windows Credential Manager.

Plaid Transactions supports transaction data, but Plaid Statements is for depository accounts rather than credit cards. The built-in U.S. path therefore returns no statement documents and never represents a transaction feed as an official statement. See [Plaid Hosted Link setup and technical boundary](PLAID_HOSTED_LINK.md) for API and security details.

## Japan statement import

Use statement files exported from the official American Express site/app. The desktop flow requires a specific Japan account, accepts bounded CSV, `.xlsx`, QIF, and text-based PDF files, parses locally, shows validation/duplicate/reconciliation results, and asks for an explicit confirmation before one atomic encrypted-store commit. Cancellation or a blocking mismatch commits no transactions. Supported extension does not guarantee every issuer layout will parse correctly, so use a copy and compare every preview against the original statement.

Never automate sign-in, scrape the Amex site, save browser profiles, or place real statements inside the repository. The app rejects scanned/image-only and encrypted PDFs; OCR is not built in.

## Build and installer

```powershell
npm run verify
npm run package:win
npm run smoke:packaged
```

The packaged smoke test uses its own temporary Electron profile and encrypted data directory, verifies the unpacked production executable reaches its encrypted controller with MCP disabled by default, exits through the app's normal shutdown path, and removes only that temporary test directory. The unsigned NSIS artifact is placed under `release\` and is suitable only for local testing. Production distribution requires an organization-controlled code-signing certificate, protected signing process, versioned release provenance, malware scanning, and an update policy. Certificate files and passwords are ignored and must never enter this repository or CI logs.

## Operational checks

- Exit the tray app and confirm the MCP port closes.
- Confirm no listener is bound to `0.0.0.0`, a LAN address, or IPv6 any-address.
- Lock Windows and verify the app closes/locks decrypted state according to policy.
- Review sync/account authorization independently for each account.
- Review unresolved reconciliation issues and anomaly alerts before relying on reports.
- Preview export mappings and duplicate warnings; approve only the exact generated package.
- Periodically review the local audit log and retention settings.
