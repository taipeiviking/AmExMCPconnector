# Security policy

This repository handles a design for sensitive local financial data. Do not open a public issue containing a vulnerability exploit, credential, OAuth token, account identifier, statement, transaction, log, database, export package, or diagnostic bundle.

Use a private GitHub Security Advisory for vulnerability reports. Include the smallest synthetic reproduction possible and remove machine/user paths. If private reporting is unavailable, open a metadata-only issue asking the maintainer to establish a private channel; do not include the security details there.

The current `0.x` repository is a runnable local alpha, not audited financial software. Use the synthetic test drive first. Its encrypted local persistence, Japan import, reviewed export packages, read-only MCP boundary, and Windows secret-resolution components have automated tests, but they have not received an independent production security audit. Live U.S. provider credentials must not be used until a named approved provider contract, exact read-only products/scopes, sandbox evidence, installer signing/update process, operational recovery, and threat-model controls are independently reviewed. The [Plaid Hosted Link document](docs/PLAID_HOSTED_LINK.md) is a future design, not an implemented connection or approval to use Plaid Production. Treat real statement testing as sensitive local evaluation and verify every preview row against the official source.

A future provider flow must keep API registrations in Windows-protected references, isolate each account's access token and Item/grant, open consent only in a validated external browser destination, and distinguish provider Item removal, institution-side revocation, local token removal, and local financial-data deletion. Do not place an Amex password, Plaid secret, Link/public/access token, real account data, or consent screen in `.env`, source control, screenshots, logs, or support reports.

Supported security fixes target the current `main` branch until the first signed release policy is published.
