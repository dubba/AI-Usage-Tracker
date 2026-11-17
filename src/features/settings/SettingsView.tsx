import { useEffect, useRef } from "react";
import { DevicesIcon } from "../../shared/ui/icons";
import { MobileSidebarToggle } from "../../shared/ui/MobileSidebarToggle";
import type { BridgeStatus } from "../../types";
import { SETTINGS_DESCRIPTION } from "../../shared/lib/constants";
import { isMobileDevice } from "../../shared/lib/platform";
import { SHORTCUTS, isMacPlatform, shortcutLabel } from "../shortcuts/shortcuts";
import { DataSection } from "./DataSection";
import { GeneralSection } from "./GeneralSection";
import { LocalApiSection } from "./LocalApiSection";
import { UpdatesSection } from "./UpdatesSection";
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
  onAllDataDeleted: () => void;
  jumpTarget?: { section: SettingsSectionId; seq: number } | null;
  onActiveSectionChange?: (section: SettingsSectionId) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const suppressScrollSpyRef = useRef(false);

  useEffect(() => {
    if (!jumpTarget) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const targetSection = SETTINGS_JUMP_SECTIONS.find((entry) => entry.id === jumpTarget.section);
    if (!targetSection) return;
    const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reducedMotion ? "auto" : "smooth";
    let clearTimer: number | null = null;
    const clearSuppression = () => {
      suppressScrollSpyRef.current = false;
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
        clearTimer = null;
      }
      scroller.removeEventListener("scrollend", clearSuppression);
    };

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetSection.elementId);
      if (!target) return;
      const anchor = target.closest(".settings-card") ?? target;
      const top = Math.max(0, scroller.scrollTop + (anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top) - 18);
      if (typeof scroller.scrollTo === "function") {
        if (behavior === "smooth") {
          suppressScrollSpyRef.current = true;
          scroller.addEventListener("scrollend", clearSuppression, { once: true });
          clearTimer = window.setTimeout(clearSuppression, 700);
        }
        scroller.scrollTo({ top, behavior });
      } else {
        scroller.scrollTop = top;
      }
      onActiveSectionChange?.(jumpTarget.section);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      clearSuppression();
    };
  }, [jumpTarget]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !onActiveSectionChange) return;

    const releaseProgrammaticLock = () => {
      suppressScrollSpyRef.current = false;
    };

    const updateActiveFromScroll = () => {
      if (suppressScrollSpyRef.current) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleSections = SETTINGS_JUMP_SECTIONS.filter((entry) => document.getElementById(entry.elementId) !== null);
      if (visibleSections.length === 0) return;

      // Interpolate the focal line from near the top (at scrollTop = 0) to near the bottom
      // (at maxScroll) so sections in the lower half still activate sequentially even when
      // they cannot scroll all the way to the top edge of the viewport.
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const progress = maxScroll > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / maxScroll)) : 0;
      const anchorOffset = 48 + progress * Math.max(0, scroller.clientHeight - 96);

      let current: SettingsSectionId = visibleSections[0]!.id;
      for (const entry of visibleSections) {
        const heading = document.getElementById(entry.elementId)!;
        if (heading.getBoundingClientRect().top - scrollerRect.top <= anchorOffset) {
          current = entry.id;
        }
      }
      onActiveSectionChange(current);
    };

    scroller.addEventListener("wheel", releaseProgrammaticLock, { passive: true });
    scroller.addEventListener("touchstart", releaseProgrammaticLock, { passive: true });
    scroller.addEventListener("pointerdown", releaseProgrammaticLock, { passive: true });
    scroller.addEventListener("scroll", updateActiveFromScroll, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", releaseProgrammaticLock);
      scroller.removeEventListener("touchstart", releaseProgrammaticLock);
      scroller.removeEventListener("pointerdown", releaseProgrammaticLock);
      scroller.removeEventListener("scroll", updateActiveFromScroll);
    };
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

        <section className="settings-card">
          <h2 id="settings-section-devices" className="settings-card-heading">Devices</h2>
          <div className="settings-row">
            <div>
              <strong>Device Sync</strong>
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

        <DataSection onAllDataDeleted={onAllDataDeleted} />

        <LocalApiSection
          bridge={bridge}
          bridgeBusy={bridgeBusy}
          integrationWindowBusy={integrationWindowBusy}
          onToggleBridge={onToggleBridge}
          onViewBridgeWindow={onViewBridgeWindow}
        />

        {!isMobileDevice() ? (
          <section className="settings-card settings-shortcuts-card" aria-labelledby="settings-section-shortcuts">
            <h2 id="settings-section-shortcuts" className="settings-card-heading">Keyboard Shortcuts</h2>
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
    </div>
  );
}
