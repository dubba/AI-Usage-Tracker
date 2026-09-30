# macOS credential migration

AI Usage Tracker stores each provider account in one macOS Keychain item. Version 0.2.13, released under the former Paseo Usage Bridge name, introduced this behavior. Earlier releases reused the Windows chunked credential format on macOS, which could display several identical Keychain approval prompts for one account.

When an older chunked account is read successfully, the app rewrites the account credential into the single-item format.

New credentials are stored under the `ai-usage-tracker` Keychain service name. On first successful read, items still stored as `paseo-usage-bridge` are copied into the current name. After that write is verified, the legacy Keychain items are deleted. If delete fails, the new copy is kept and the leftover legacy item is ignored.

After a credential is unlocked, it is kept in memory for the rest of the process so usage refreshes do not prompt again. The Keychain item is rewritten only when the saved secret actually changes.

Desktop debug builds (`tauri dev`, `cargo test`) store credentials in private application files and never access the Keychain. A stable Apple Developer ID signature is still required for production desktop builds so Keychain trust is preserved across application updates.
