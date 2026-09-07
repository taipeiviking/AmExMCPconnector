# Windows 11 setup

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

The local alpha contains a normalized, provider-agnostic OAuth/read adapter, not a provider contract, provider account, endorsement, or direct/live Amex integration. Before enabling it:

1. Contract with/obtain approval for a consent-based provider that supports the required U.S. Amex accounts and read-only account, transaction, and statement data.
2. Register a loopback OAuth redirect exactly matching `AMEX_US_AGGREGATOR_REDIRECT_URI`.
3. Store the client registration in the current user’s protected Windows secret store and configure only its `wincred:` references.
4. Review scopes to exclude payments, transfers, card controls, disputes, and accounting writes.
5. Configure the approved provider's exact HTTPS endpoints and normalized response mapping, then test separate consent, refresh, revocation, pagination, response limits, and reauthorization for every account. Never reuse one account’s token or provider item as another’s.

The desktop UI must open the provider’s consent page. It must never display a form that asks for an Amex password. If a provider cannot offer approved consent-based access, leave the adapter disabled.

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
