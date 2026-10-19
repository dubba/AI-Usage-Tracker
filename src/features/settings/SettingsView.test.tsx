// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { SettingsView } from "./SettingsView";

describe("SettingsView accessibility", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  it("renders with a focusable h1 heading and labeled dropdowns", () => {
    app = mount(
      <SettingsView
        autostart={false}
        onToggleAutostart={vi.fn()}
        appSettings={{ accountRefreshMinutes: 15, automaticUpdatesEnabled: true, includeBetaUpdates: false } as any}
        refreshIntervalBusy={false}
        automaticUpdatesBusy={false}
        includeBetaUpdatesBusy={false}
        onAccountRefreshMinutesChange={vi.fn()}
        onAutomaticUpdatesChange={vi.fn()}
        onIncludeBetaUpdatesChange={vi.fn()}
        installedVersion="1.0.0"
        update={null}
        updateBusy={null}
        updateProgress={null}
        updateError={null}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onOpenLink={vi.fn()}
        bridge={null}
        bridgeBusy={false}
        integrationWindowBusy={false}
        onToggleBridge={vi.fn()}
        onViewBridgeWindow={vi.fn()}
      />,
    );

    const h1 = document.querySelector("h1.eyebrow")!;
    expect(h1).not.toBeNull();
    expect(h1.getAttribute("tabindex")).toBe("-1");

    const themeDropdown = document.querySelector("#setting-theme");
    expect(themeDropdown?.getAttribute("aria-label")).toBe("Theme");

    const refreshDropdown = [...document.querySelectorAll(".custom-dropdown-trigger")].find(
      (btn) => btn.getAttribute("aria-label") === "Refresh interval",
    );
    expect(refreshDropdown).not.toBeNull();
  });

  it("remembers whether the Advanced section is expanded or collapsed", () => {
    const makeView = () => (
      <SettingsView
        autostart={false}
        onToggleAutostart={vi.fn()}
        appSettings={{ accountRefreshMinutes: 15, automaticUpdatesEnabled: true, includeBetaUpdates: false } as any}
        refreshIntervalBusy={false}
        automaticUpdatesBusy={false}
        includeBetaUpdatesBusy={false}
        onAccountRefreshMinutesChange={vi.fn()}
        onAutomaticUpdatesChange={vi.fn()}
        onIncludeBetaUpdatesChange={vi.fn()}
        installedVersion="1.0.0"
        update={null}
        updateBusy={null}
        updateProgress={null}
        updateError={null}
        onCheckForUpdate={vi.fn()}
        onInstallUpdate={vi.fn()}
        onOpenLink={vi.fn()}
        bridge={null}
        bridgeBusy={false}
        integrationWindowBusy={false}
        onToggleBridge={vi.fn()}
        onViewBridgeWindow={vi.fn()}
      />
    );

    app = mount(makeView());
    const toggle = () => document.querySelector<HTMLButtonElement>(".settings-advanced-toggle")!;
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#settings-advanced-content")).toBeNull();

    // Click to expand
    act(() => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#settings-advanced-content")).not.toBeNull();

    // Remounting (e.g. switching to dashboard and back to settings) keeps it expanded
    app.unmount();
    app = mount(makeView());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("#settings-advanced-content")).not.toBeNull();

    // Click to collapse
    act(() => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#settings-advanced-content")).toBeNull();

    // Remounting keeps it collapsed
    app.unmount();
    app = mount(makeView());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#settings-advanced-content")).toBeNull();
  });
});
