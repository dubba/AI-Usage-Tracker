# Supplemental manual review notes

## Confirmed shipping IPC and permissions review

- `Sources/Helper/HelperService.swift:64,129,272-318` builds a release code-signing requirement pinning the GUI bundle identifier and Team ID, then applies it to the privileged NSXPCListener. `Sources/Helper/HelperService.swift:932-1005,1010-1031` reauthorizes each request using XPC effective UID plus persisted owner/console-admin policy. `Sources/GUI/App/HelperClient.swift:1045-1063` connects to the privileged Mach namespace. This is a sound root-helper authentication boundary for the shipped release.
- The shipping GUI has no web content and no `dangerouslySetInnerHTML`/HTML injection sink. SwiftUI renders text directly; no confirmed XSS path exists.
- `Sources/Helper/HelperService.swift:873-882` stores an arbitrary DoH URL without application-level scheme validation. This is a policy weakness, but macOS ATS may still reject cleartext HTTP; therefore plaintext exfiltration was not dynamically confirmed.
- The GUI and helper are intentionally not sandboxed because they manage PF, launchd, and a root DNS proxy. The release app has only network client/server and the expected app-group entitlements (`project.yml:57-71`); the helper has no sandbox entitlement (`Sources/Helper/Helper.entitlements`).

## Optional, non-shipping Network Extension risks

The `Sources/NetExt/**` code is not in the published v0.2.4 bundle (confirmed by mounted release inspection) but is part of `project-netext.yml` and should be fixed before distribution.

- **Medium, conditional:** `Sources/Shared/IPCConnection.swift:79-91` accepts every connection to the extension's Mach service without a code-signing requirement. The service name is public (`Sources/Shared/Models.swift:411`). A local process that can connect first may replace `currentConnection`, receive flow prompts, and return allow/deny decisions. The legitimate GUI connection later replaces it. Fix: set a Team-ID + bundle-ID signing requirement on the incoming NSXPCConnection before exporting interfaces, and validate the caller from the audit token.
- **Medium, conditional:** `Sources/Shared/SharedRuleBridge.swift:22-43` stores the trusted extension ruleset as plain JSON in the user-writable app-group container and the extension rereads it every two seconds (`Sources/NetExt/FilterDataProvider.swift:135-142`). A same-user process able to write the group container can replace it with permissive rules or a huge payload, causing firewall bypass or memory pressure. Fix: keep authoritative rules in the root helper and send a signed/authenticated snapshot over XPC; otherwise use a protected location, atomic writes, ownership/type checks, size bounds, and an authenticated HMAC/key held outside the user-writable container.
- **Low, optional:** `Sources/Shared/RuleMatcher.swift:28-30` treats `processPath` as a prefix, so `/usr/bin/foo` also matches `/usr/bin/foobar`. Use an exact match or a path-component boundary.
- The optional extension intentionally fails open if the GUI is unavailable or a decision times out (`Sources/NetExt/FilterDataProvider.swift:71-80`). This is documented behavior, but it should be surfaced in the UI as reduced protection.

## GUI privacy and integrity observations

- **Medium privacy/documentation mismatch:** `Sources/GUI/Views/NetworkMonitor.swift:235-252` embeds SwiftUI `Map`/`MapKit` on macOS 14+, which loads Apple Maps content and uses Apple's Maps service. Apple's Maps privacy documentation says map requests send request time, device/software information, the visible map boundary, interactions, and network/performance data to Apple. The app's `README.md:124,278` says network access is limited to blocklist refreshes and optional DNS proxy traffic, and the table says telemetry is `none` (`README.md:256`). No packet capture was performed, so runtime requests were not dynamically confirmed, but the source-level use of MapKit conflicts with the categorical network-access statement. Fix: disclose Apple Maps/MapKit requests and data handling prominently, or replace the map with a fully local rendering that does not contact Apple.
- **Low/Informational:** `Sources/GUI/App/PureFenceApp.swift:42-68` compiles a `PUREFENCE_DEMO=1` mode that seeds synthetic traffic, rules, and country data and skips optional Network Extension activation. It changes only GUI state, not root enforcement, but shipping this debug/demo switch can make the production UI display synthetic monitoring data. Fix: compile demo support only in Debug, or add an unmistakable persistent demo banner.
- No confirmed path traversal, arbitrary file write, WebView script injection, or arbitrary URL execution was found in the GUI. The only user-supplied URL reaches the authorized helper's DoH setting; SwiftUI text rendering is not an HTML sink.

## Release and binary checks performed by the coordinator

- Downloaded v0.2.4 DMG SHA-256: `97c9e7f7c0db47f97855a99c6a868940c30306178e70b64084295790ea08910f`, matching GitHub release API and current Homebrew cask.
- `codesign --verify --deep --strict`: valid and satisfies designated requirement.
- App and helper: Developer ID team `H3WXHVTP97`, hardened runtime flag set.
- `spctl -a -vvv -t exec`: accepted, source `Notarized Developer ID`.
- `xcrun stapler validate`: succeeded.
- Both executables are universal arm64/x86_64 and link only Apple/system libraries; no third-party dylib or rpath payload was present.
- Mounted app contained only the signed app and embedded helper/launchd plist; no System Extension bundle was present.
- `./Scripts/test_hardening.sh`: all 18 project hardening regression checks passed (one Swift concurrency warning).
- No obvious suspicious credential, reverse-shell, shell download, credential-access, clipboard, camera, or keychain strings were present in the release executables.
