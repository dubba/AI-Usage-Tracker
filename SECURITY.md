# Security policy

## Supported versions

Only the latest release receives security fixes. Update through the in-app updater, or install the newest release from the [Releases page](https://github.com/dubba/AI-Usage-Tracker/releases).

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: **Security** tab, then **Report a vulnerability** ([direct link](https://github.com/dubba/AI-Usage-Tracker/security/advisories/new)). Include the affected version and platform, steps to reproduce, and the impact you observed. Do not include real tokens, cookies, or API keys; redact them.

You can expect an acknowledgement within a few days. Fixes ship in a normal release, and the changelog notes user-relevant security fixes under `Security`.

## Threat model summary

AI Usage Tracker is a client-only app with no server. It holds provider credentials (OAuth tokens, API keys, session cookies) for the accounts you add.

- Credentials live only in the native credential store (Windows Credential Manager, macOS Keychain, or Android Keystore-sealed files) and are never sent to the user interface, logs, or the local API.
- The optional Paseo integration listens on loopback only, requires a bearer token, and returns sanitized usage data.
- Device pairing transfers credentials directly between your own devices using ephemeral X25519 key agreement, authenticated encryption, and a visual verification code that you compare on both devices.
- Quota data comes from provider endpoints that are not documented as stable; the app treats their responses as untrusted.

In scope: credential exposure, authentication or authorization bypass of the local API or pairing, update-integrity bypass, code execution, and unsafe handling of provider responses.

Out of scope: attacks that need an already-compromised operating system account or a rooted or jailbroken device, and issues in the provider services themselves.

Contributors and automated agents: see `docs/AUDIT_PROTOCOL.md` for the audit process.
