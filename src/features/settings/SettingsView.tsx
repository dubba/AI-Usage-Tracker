import { useEffect, useRef, useState } from "react";
import { ChevronIcon, DevicesIcon } from "../../shared/ui/icons";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import type { BridgeStatus } from "../../types";
import { SETTINGS_DESCRIPTION } from "../../shared/lib/constants";
import { isMobileDevice } from "../../shared/lib/platform";
import { SHORTCUTS, isMacPlatform, shortcutLabel } from "../shortcuts/shortcuts";
import { DataSection } from "./DataSection";
import { GeneralSection } from "./GeneralSection";
import { LocalApiSection } from "./LocalApiSection";
import { UpdatesSection } from "./UpdatesSection";
import { readSettingsAdvancedOpen, writeSettingsAdvancedOpen } from "./settings-view-state";
import { SETTINGS_JUMP_SECTIONS, type SettingsSectionId } from "./settings-sections";
import "./settings-layout.css";

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
  jumpTarget,
  onActiveSectionChange,
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
  jumpTarget?: { section: SettingsSectionId; seq: number } | null;
  onActiveSectionChange?: (section: SettingsSectionId) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(readSettingsAdvancedOpen);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toggleAdvanced = () => {
    setAdvancedOpen((prev) => {
      const next = !prev;
      writeSettingsAdvancedOpen(next);
      return next;
    });
  };

  useEffect(() => {
    if (!jumpTarget) return;
    if (jumpTarget.section === "advanced" && !advancedOpen) {
      setAdvancedOpen(true);
      writeSettingsAdvancedOpen(true);
    }
    const scroller = scrollRef.current;
    if (!scroller) return;
    const targetSection = SETTINGS_JUMP_SECTIONS.find((entry) => entry.id === jumpTarget.section);
    if (!targetSection) return;
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetSection.elementId);
      if (!target) return;
      const top = Math.max(0, target.offsetTop - 18);
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ top, behavior });
      } else {
        scroller.scrollTop = top;
      }
      onActiveSectionChange?.(jumpTarget.section);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [jumpTarget]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !onActiveSectionChange) return;

    const updateActiveFromScroll = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
      if (nearBottom && scroller.scrollTop > 0) {
        onActiveSectionChange("advanced");
        return;
      }
      let current: SettingsSectionId = "general";
      for (const entry of SETTINGS_JUMP_SECTIONS) {
        const heading = document.getElementById(entry.elementId);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top - scrollerRect.top <= 48) {
          current = entry.id;
        }
      }
      onActiveSectionChange(current);
    };

    scroller.addEventListener("scroll", updateActiveFromScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", updateActiveFromScroll);
  }, [onActiveSectionChange]);

  return (
    <div className="content-scroll dashboard-content settings-style-content">
      <header className="dashboard-header">
        <div>
          <div className="dashboard-title-row">
            {onToggleSidebar ? <MobileSidebarToggle onToggle={onToggleSidebar} open={sidebarOpen} /> : null}
            <h1 className="eyebrow" tabIndex={-1} style={{ outline: "none" }}>App Settings</h1>
          </div>
          {/* A full sentence, like the other pages' subtitles; the top bar tooltip uses the same words without the period. */}
          <p className="dashboard-description">{SETTINGS_DESCRIPTION}.</p>
        </div>
      </header>
      <div ref={scrollRef} className="dashboard-scroll">
        <GeneralSection />

        <UpdatesSection onOpenLink={onOpenLink} onOpenUpdateNotes={onOpenUpdateNotes} />

        <h2 id="settings-section-devices" className="settings-section-title">Devices</h2>
        <section className="settings-card">
          <div className="settings-row">
            <div>
              <strong>Device Transfer</strong>
              <small>Sync accounts &amp; credentials to another device securely.</small>
            </div>
            <button
              type="button"
              className="button primary settings-update-action"
              onClick={onOpenPairing}
            >
              <DevicesIcon className="settings-update-action-icon" />
              <span>Sync Devices</span>
            </button>
          </div>
        </section>

        <h2 id="settings-section-advanced" className="settings-section-title">
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
              <h3 className="settings-card-heading">Diagnostics</h3>
              <div className="settings-row">
                <div>
                  <strong>Diagnostics Report</strong>
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
                <h3 id="settings-shortcuts-heading" className="settings-card-heading">Keyboard Shortcuts</h3>
                <div className="settings-row settings-shortcuts-row">
                  <div>
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
