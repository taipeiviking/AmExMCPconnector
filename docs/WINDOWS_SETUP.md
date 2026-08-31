# Windows 11 setup

## Developer setup

Prerequisites:

- Windows 11 x64 with current security updates.
- Node.js 22.12 or newer and npm.
- Git and, for repository publishing, GitHub CLI authenticated to the intended account.
- No Amex credentials. Use only synthetic data during development.

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

Runtime files default to `%LOCALAPPDATA%\AmexLocalFinanceConnector`, outside the repository. Remove development data from that exact directory through the app’s future reset control or a carefully scoped Windows operation; do not make it a Git working directory.

## Local-only mode

Set `AMEX_MCP_MODE=local`, keep `AMEX_MCP_HOST=127.0.0.1`, and leave `OPENAI_TUNNEL_ENABLED=false`. The tray app starts a loopback Streamable HTTP endpoint at `http://127.0.0.1:43121/mcp`. Only a client on this computer can reach it. The endpoint exposes read-only financial queries; account setup, imports, exports, and approvals remain desktop-only.

Do not create a Windows Firewall inbound allow rule, port forward, reverse proxy, or router mapping for the MCP port.

## Private ChatGPT connection with Secure MCP Tunnel

ChatGPT cannot call `127.0.0.1` on this computer directly. The supported private design uses OpenAI Secure MCP Tunnel only while the desktop app is running:

1. In [Platform tunnel settings](https://platform.openai.com/), create a tunnel under the intended Platform organization. The operator needs Tunnels Read + Manage; running/selecting it needs Read + Use.
2. Associate only the intended Platform organization and ChatGPT workspace. ChatGPT developer-mode access is a separate workspace permission.
3. Download the current verified `tunnel-client` release using the link in the official [Secure MCP Tunnel documentation](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Do not hard-code an old download URL into automation.
4. Start the tray app and confirm the local MCP endpoint is healthy.
5. In a temporary PowerShell session, provide the tunnel runtime API key without writing it to disk, then initialize and validate a profile. The official client currently documents the `CONTROL_PLANE_API_KEY` runtime variable and commands such as:

   ```powershell
   $env:CONTROL_PLANE_API_KEY = Read-Host "Tunnel runtime API key"
   & "C:\Program Files\OpenAI\tunnel-client.exe" init `
     --profile amex-local `
     --tunnel-id tunnel_REPLACE_WITH_YOUR_TUNNEL_ID `
     --mcp-server-url http://127.0.0.1:43121/mcp
   & "C:\Program Files\OpenAI\tunnel-client.exe" doctor --profile amex-local --explain
   & "C:\Program Files\OpenAI\tunnel-client.exe" run --profile amex-local
   ```

   `Read-Host` without `-AsSecureString` temporarily places the value in process memory and the environment; it avoids the filesystem but is not a full secret-management solution. Prefer the reviewed Windows secret-reference resolver before enabling tray-managed auto-start. Clear the session variable afterward: `Remove-Item Env:CONTROL_PLANE_API_KEY`.
6. In ChatGPT developer-mode app creation, choose **Tunnel** and select the associated tunnel. Verify the seven expected read-only tools and their schemas before use.
7. Stop `tunnel-client` or exit the tray app when remote access is not needed. There is no public listener; the client makes outbound HTTPS connections to OpenAI.

The tunnel runtime key, OAuth tokens, and any `sk-...` value must never appear in `.env`, PowerShell profiles, shell history, source files, screenshots, logs, or support bundles. The scaffold records only tunnel status and non-secret IDs. Auto-start is off by default until the Windows credential resolver and lifecycle controls are implemented and reviewed.

## U.S. account authorization

The first-release scaffold contains an adapter boundary, not a live provider integration. Before enabling one:

1. Contract with/obtain approval for a consent-based provider that supports the required U.S. Amex accounts and read-only account, transaction, and statement data.
2. Register a loopback OAuth redirect exactly matching `AMEX_US_AGGREGATOR_REDIRECT_URI`.
3. Store the client registration in the current user’s protected Windows secret store and configure only its `wincred:` references.
4. Review scopes to exclude payments, transfers, card controls, disputes, and accounting writes.
5. Test separate consent, refresh, revocation, and reauthorization for every account. Never reuse one account’s token or provider item as another’s.

The desktop UI must open the provider’s consent page. It must never display a form that asks for an Amex password. If a provider cannot offer approved consent-based access, leave the adapter disabled.

## Japan statement import

Use statement files exported from the official American Express site/app. The current desktop chooser checks the selected file's extension, regular-file status, and size, then reports it for preview; it does not yet stage or commit the file. CSV/QIF parser foundations exist, while target-account binding, Excel/PDF parsing, encoding validation, normalized preview, duplicate/reconciliation review, and confirmed encrypted commit remain release gates.

Never automate sign-in, scrape the Amex site, save browser profiles, or place real statements inside the repository. PDF OCR is off by default; a future OCR engine must run locally and must be explicitly configured.

## Build and installer

```powershell
npm run verify
npm run package:win
```

The unsigned NSIS artifact is placed under `release\` and is suitable only for local testing. Production distribution requires an organization-controlled code-signing certificate, protected signing process, versioned release provenance, malware scanning, and an update policy. Certificate files and passwords are ignored and must never enter this repository or CI logs.

## Operational checks

- Exit the tray app and confirm the MCP port closes.
- Confirm no listener is bound to `0.0.0.0`, a LAN address, or IPv6 any-address.
- Lock Windows and verify the app closes/locks decrypted state according to policy.
- Review sync/account authorization independently for each account.
- Review unresolved reconciliation issues and anomaly alerts before relying on reports.
- Preview export mappings and duplicate warnings; approve only the exact generated package.
- Periodically review the local audit log and retention settings.
