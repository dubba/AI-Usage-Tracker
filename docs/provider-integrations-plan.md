# Provider integrations

This file used to be the v0.2 implementation plan. Those providers have shipped, and later ones were added the same way. The plan's second half, a direct Paseo daemon connection targeted at v0.3.0, was not built.

Add a provider by following [ADDING_A_PROVIDER.md](ADDING_A_PROVIDER.md). There is deliberately no provider trait.

Fields that are saved, paired, or published by the local API are covered in [DATA_COMPATIBILITY.md](DATA_COMPATIBILITY.md). Credentials, OAuth, and the local API's trust boundaries are in [THREAT_MODEL.md](THREAT_MODEL.md).

Do not implement anything from the old plan text. Provider endpoints live as fixed `https://` constants in `src-tauri/src/providers/`.
