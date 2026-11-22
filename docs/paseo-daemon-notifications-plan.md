# Paseo daemon notifications

**Status:** not built. The v0.3.0 tracker that used to live here (research against `getpaseo/paseo` at `b4ab0d9`, dated 2026-07-13) is retired.

Usage-limit alerts ship through the app's own notifier. Agent-lifecycle events from the Paseo daemon, Windows notification interception, and ntfy phone delivery were not built.

Shipped notification surfaces are listed in [notifications-and-paseo-daemon-integration.md](notifications-and-paseo-daemon-integration.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

Do not implement a daemon client from the old plan. The local API path `GET /v1/paseo-usage` and the LAN bridge token are not that client.
