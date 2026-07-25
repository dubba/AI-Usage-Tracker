# macOS credential migration

Paseo Usage Bridge 0.2.13 stores each provider account in one macOS Keychain item. Earlier releases reused the Windows chunked credential format on macOS, which could display several identical Keychain approval prompts for one account.

When an older chunked account is read successfully, the Bridge rewrites the account credential into the single-item format. The old chunk entries are intentionally left unused so migration does not trigger additional delete-approval prompts.

A stable Apple Developer ID signature is still required to preserve Keychain trust seamlessly across application updates.
