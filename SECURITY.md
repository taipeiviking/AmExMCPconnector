# Security policy

This repository handles a design for sensitive local financial data. Do not open a public issue containing a vulnerability exploit, credential, OAuth token, account identifier, statement, transaction, log, database, export package, or diagnostic bundle.

Use a private GitHub Security Advisory for vulnerability reports. Include the smallest synthetic reproduction possible and remove machine/user paths. If private reporting is unavailable, open a metadata-only issue asking the maintainer to establish a private channel; do not include the security details there.

The current `0.x` repository is a development scaffold, not audited financial software. Live provider credentials and real financial data must not be used until the provider integration, Windows secret resolver, installer signing, update process, persistence adapters, and threat-model controls are independently reviewed.

Supported security fixes target the current `main` branch until the first signed release policy is published.
