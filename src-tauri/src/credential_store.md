# macOS credential migration

AI Usage Tracker stores each provider account in one macOS Keychain item. Version 0.2.13, released under the former Paseo Usage Bridge name, introduced this behavior. Earlier releases reused the Windows chunked credential format on macOS, which could display several identical Keychain approval prompts for one account.

When an older chunked account is read successfully, the app rewrites the account credential into the single-item format. The old chunk entries are intentionally left unused so migration does not trigger additional delete-approval prompts.

New credentials are stored under the `ai-usage-tracker` Keychain service name. On first successful read, items still stored as `paseo-usage-bridge` are copied into the current name so existing users keep their accounts after the public rename.

A stable Apple Developer ID signature is still required to preserve Keychain trust seamlessly across application updates.
