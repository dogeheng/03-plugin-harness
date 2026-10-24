# Security

This preview is intended for one local macOS user. Keep the daemon on loopback; do not expose it through a reverse proxy or port forward. Review plugin manifests and requested scopes before installation. Development plugins run from a mutable source directory and should only be used with code you trust.

The runtime uses a capability broker, Node permissions, macOS Seatbelt, authenticated local APIs and sandboxed panel frames. These controls are defense in depth, not a guarantee against every malicious plugin or operating-system vulnerability. API keys belong in Keychain. Test-only in-memory secrets are not persistent storage.

For a suspected vulnerability, use [private vulnerability reporting](https://github.com/dogeheng/03-plugin-harness/security/advisories/new). Include a minimal reproduction with fake credentials and remove local paths or private data from logs. Only the latest main branch is maintained.
