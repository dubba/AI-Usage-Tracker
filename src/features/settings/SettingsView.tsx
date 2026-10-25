import { useState } from "react";
import { ChevronIcon, DevicesIcon } from "../../shared/ui/icons";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import type { BridgeStatus } from "../../types";
import { isMobileDevice } from "../../shared/lib/platform";
import { SHORTCUTS, isMacPlatform, shortcutLabel } from "../shortcuts/shortcuts";
import { DataSection } from "./DataSection";
import { GeneralSection } from "./GeneralSection";
import { LocalApiSection } from "./LocalApiSection";
import { UpdatesSection } from "./UpdatesSection";
import { readSettingsAdvancedOpen, writeSettingsAdvancedOpen } from "./settings-view-state";

/**
 * The Settings page. The app settings and the update state it shows come from the contexts in
 * `settings-context.tsx`; the props are what only the app shell knows (the sidebar, the pairing
 * dialog, links, and the local API state).
 */
export function SettingsView({
  onToggleSidebar,
  sidebarOpen,
  onOpenPairing,
  onOpenLink,
  bridge,
  bridgeBusy,
  integrationWindowBusy,
  onToggleBridge,
  onViewBridgeWindow,
  onOpenUpdateNotes,
  onUsageCleared,
  onAllDataDeleted,
}: {
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
  onOpenPairing?: () => void;
  onOpenLink: (url: string) => void;
  bridge: BridgeStatus | null;
  bridgeBusy: boolean;
  integrationWindowBusy: boolean;
  onToggleBridge: (enabled: boolean) => void;
  onViewBridgeWindow: () => void;
  onOpenUpdateNotes?: () => void;
  onUsageCleared: () => void | Promise<void>;
  onAllDataDeleted: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(readSettingsAdvancedOpen);

  const toggleAdvanced = () => {
    setAdvancedOpen((prev) => {
      const next = !prev;
      writeSettingsAdvancedOpen(next);
      return next;
    });
  };
  return (
    <div className="content-scroll dashboard-content settings-style-content">
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? <MobileSidebarToggle onToggle={onToggleSidebar} open={sidebarOpen} /> : null}
            <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>App Settings</h1>
          </div>
        </div>
      </header>
      <div className="dashboard-scroll">
        <GeneralSection />

        <UpdatesSection onOpenLink={onOpenLink} onOpenUpdateNotes={onOpenUpdateNotes} />

        <h2 className="settings-section-title">Devices</h2>
        <section className="settings-card">
          <div className="settings-row">
            <div>
              <strong>Device Transfer</strong>
              <small>Sync accounts and credentials to another device securely.</small>
            </div>
            <button
              type="button"
              className="button primary settings-update-action"
              onClick={onOpenPairing}
            >
              <DevicesIcon className="settings-update-action-icon" />
              <span>Link Devices</span>
            </button>
          </div>
        </section>

        <h2 className="settings-section-title">
          <button
            type="button"
            className="settings-advanced-toggle"
            onClick={toggleAdvanced}
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-content"
          >
            <span>Advanced</span>
            <ChevronIcon className={`settings-advanced-chevron ${advancedOpen ? "open" : ""}`} />
          </button>
        </h2>

        {advancedOpen ? (
          <div id="settings-advanced-content" className="settings-advanced-group">
            <DataSection onUsageCleared={onUsageCleared} onAllDataDeleted={onAllDataDeleted} />
            <section className="settings-card">
              <div className="settings-row">
                <div>
                  <strong>Diagnostics</strong>
                  <small>Bug report with tokens, cookies, and emails removed.</small>
                </div>
                <CopyDiagnosticsButton compact className="button ghost settings-changelog-button" />
              </div>
            </section>
            <LocalApiSection
              bridge={bridge}
              bridgeBusy={bridgeBusy}
              integrationWindowBusy={integrationWindowBusy}
              onToggleBridge={onToggleBridge}
              onViewBridgeWindow={onViewBridgeWindow}
            />
            {!isMobileDevice() ? (
              <section className="settings-card settings-shortcuts-card" aria-labelledby="settings-shortcuts-heading">
                <div className="settings-row settings-shortcuts-row">
                  <div>
                    <strong id="settings-shortcuts-heading">Keyboard Shortcuts</strong>
                    <ul className="settings-shortcuts">
                      {SHORTCUTS.map((shortcut) => (
                        <li key={shortcut.action}>
                          <span>{shortcut.label}</span>
                          <span className="settings-shortcut-keys">
                            {shortcut.keys.map((k) => (
                              <kbd key={k}>{shortcutLabel(k, isMacPlatform())}</kbd>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
