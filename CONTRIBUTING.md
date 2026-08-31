# Contributing

Use synthetic data only. Never add a real statement, account number, merchant history, credential, token, encrypted local database, or export package—even to a private branch or test fixture.

Before a pull request:

```powershell
npm ci
npm run verify
```

Security boundaries are part of the product contract:

- MCP remains read-only and every financial query is explicitly account- or portfolio-scoped.
- Desktop-only commands handle authorization, configuration, imports, review, and export approval.
- The server binds only to `127.0.0.1`; private remote access uses the outbound Secure MCP Tunnel design.
- U.S. access uses an approved consent provider and never captures Amex passwords.
- Japan uses official statement exports and never scraping.
- Export code creates files only after duplicate checks and one exact human approval; it never posts to an accounting service.

Add tests for authorization failures, cross-account isolation, duplicate detection, financial precision, encoding, parser rejection, and secret/log redaction when touching those areas.
