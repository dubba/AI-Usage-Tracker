// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { AppSettings, AppUpdateStatus, BridgeStatus } from "../../types";
import { SettingsView } from "./SettingsView";
import { AppSettingsContext, AppUpdateContext, type AppSettingsState, type AppUpdateState } from "./settings-context";

function settingsState(overrides: Partial<AppSettingsState> = {}): AppSettingsState {
  return {
    appSettings: { accountRefreshMinutes: 15, automaticUpdatesEnabled: true, includeBetaUpdates: false } as AppSettings,
    autostart: false,
    refreshIntervalBusy: false,
    automaticUpdatesBusy: false,
    includeBetaUpdatesBusy: false,
    reloadFromBackend: vi.fn(),
    saveAccountRefreshMinutes: vi.fn(async () => {}),
    saveAutomaticUpdatesEnabled: vi.fn(async () => {}),
    saveIncludeBetaUpdates: vi.fn(async () => {}),
    toggleAutostart: vi.fn(async () => {}),
    ...overrides,
  };
}

function updateState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    installedVersion: "1.0.0",
    appUpdate: null,
    updateBusy: null,
    updateProgress: null,
    updateError: null,
    updateMessage: null,
    updateNotesOpen: false,
    setUpdateNotesOpen: vi.fn(),
    pendingUpdateVersion: null,
    checkForUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    ...overrides,
  };
}

function available(version = "1.2.0"): AppUpdateStatus {
  return { currentVersion: "1.0.0", available: true, availableVersion: version, date: null, body: null, error: null };
}

type ViewProps = Partial<Parameters<typeof SettingsView>[0]>;

function view(
  { settings = settingsState(), update = updateState(), props = {} }: { settings?: AppSettingsState; update?: AppUpdateState; props?: ViewProps } = {},
): ReactElement {
  return (
    <AppSettingsContext.Provider value={settings}>
      <AppUpdateContext.Provider value={update}>
        <SettingsView
          onOpenLink={vi.fn()}
          bridge={null}
          bridgeBusy={false}
          integrationWindowBusy={false}
          onToggleBridge={vi.fn()}
          onViewBridgeWindow={vi.fn()}
          onUsageCleared={vi.fn()}
          onAllDataDeleted={vi.fn()}
          {...props}
        />
      </AppUpdateContext.Provider>
    </AppSettingsContext.Provider>
  );
}

let app: Mounted | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label)!;
/** The Advanced section remembers being open between mounts, so open it only if it is closed. */
function openAdvanced() {
  if (document.querySelector("#settings-advanced-content")) return;
  act(() => document.querySelector<HTMLButtonElement>(".settings-advanced-toggle")!.click());
}
const toggleLabelled = (id: string) => document.querySelector<HTMLButtonElement>(`button[role=switch][aria-labelledby="${id}"]`)!;

describe("SettingsView accessibility", () => {
  it("renders with a focusable h1 heading and labeled dropdowns", () => {
    app = mount(view());

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

  it("names every switch by its visible label", () => {
    app = mount(view());
    for (const id of ["setting-autostart-label", "setting-auto-update-label", "setting-beta-label"]) {
      expect(document.getElementById(id), id).not.toBeNull();
      expect(toggleLabelled(id), id).not.toBeNull();
    }
  });

  it("puts the data controls in Advanced, above Diagnostics", () => {
    app = mount(view());
    expect(document.body.textContent).not.toContain("Refresh Usage");
    openAdvanced();
    const titles = [...document.querySelectorAll(".settings-section-title")].map((el) => el.textContent?.replace(/\s+/g, " ").trim());
    expect(titles).not.toContain("Data");
    const cards = [...document.querySelectorAll("#settings-advanced-content > .settings-card")];
    expect(cards[0]?.textContent).toContain("Refresh Usage");
    expect(cards[0]?.textContent).toContain("Delete Local App Data");
    expect(cards[1]?.textContent).toContain("Diagnostics");
    act(() => document.querySelector<HTMLButtonElement>(".settings-advanced-toggle")!.click());
  });

  it("remembers whether the Advanced section is expanded or collapsed", () => {
    app = mount(view());
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
    app = mount(view());
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
    app = mount(view());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#settings-advanced-content")).toBeNull();
  });

  it("needs its contexts", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mount(<SettingsView onOpenLink={vi.fn()} bridge={null} bridgeBusy={false} integrationWindowBusy={false} onToggleBridge={vi.fn()} onViewBridgeWindow={vi.fn()} onUsageCleared={vi.fn()} onAllDataDeleted={vi.fn()} />)).toThrow(
      /AppSettingsContext/,
    );
    error.mockRestore();
  });
});

describe("General", () => {
  it("shows the saved launch-at-startup state and toggles it", () => {
    const settings = settingsState({ autostart: true });
    app = mount(view({ settings }));
    const toggle = toggleLabelled("setting-autostart-label");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    click(toggle);
    expect(settings.toggleAutostart).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh interval until settings load and while it saves", () => {
    app = mount(view({ settings: settingsState({ appSettings: null }) }));
    const trigger = () => [...document.querySelectorAll<HTMLButtonElement>(".custom-dropdown-trigger")].find((el) => el.getAttribute("aria-label") === "Refresh interval")!;
    expect(trigger().disabled).toBe(true);
    app.rerender(view({ settings: settingsState({ refreshIntervalBusy: true }) }));
    expect(trigger().disabled).toBe(true);
    app.rerender(view());
    expect(trigger().disabled).toBe(false);
  });

  it("offers the same intervals as the backend and saves the chosen one", () => {
    const settings = settingsState();
    app = mount(view({ settings }));
    const trigger = [...document.querySelectorAll<HTMLButtonElement>(".custom-dropdown-trigger")].find((el) => el.getAttribute("aria-label") === "Refresh interval")!;
    act(() => trigger.click());
    const options = [...document.querySelectorAll("[role=option]")].map((el) => el.textContent?.trim());
    expect(options).toEqual(["5 minutes", "10 minutes", "15 minutes", "30 minutes", "45 minutes", "60 minutes"]);
    click([...document.querySelectorAll("[role=option]")].find((el) => el.textContent?.includes("30 minutes"))!);
    expect(settings.saveAccountRefreshMinutes).toHaveBeenCalledWith(30);
  });
});

describe("Updates", () => {
  it("saves the automatic and beta switches, and disables them while saving", () => {
    const settings = settingsState();
    app = mount(view({ settings }));
    click(toggleLabelled("setting-auto-update-label"));
    expect(settings.saveAutomaticUpdatesEnabled).toHaveBeenCalledWith(false);
    click(toggleLabelled("setting-beta-label"));
    expect(settings.saveIncludeBetaUpdates).toHaveBeenCalledWith(true);

    app.rerender(view({ settings: settingsState({ automaticUpdatesBusy: true, includeBetaUpdatesBusy: true }) }));
    expect(toggleLabelled("setting-auto-update-label").disabled).toBe(true);
    expect(toggleLabelled("setting-beta-label").disabled).toBe(true);
  });

  it("says the app is up to date and checks on request", () => {
    const update = updateState();
    app = mount(view({ update }));
    expect(document.querySelector(".settings-installed-version")?.textContent).toBe("Current Version: 1.0.0");
    expect(document.querySelector(".settings-updates-subcard-status")?.textContent).toContain("Up to date");
    click(button("Check Now"));
    expect(update.checkForUpdate).toHaveBeenCalledWith(true);
  });

  it("offers to install an available update and its notes", () => {
    const update = updateState({ appUpdate: available("v1.2.0") });
    const onOpenUpdateNotes = vi.fn();
    app = mount(view({ update, props: { onOpenUpdateNotes } }));
    expect(document.querySelector(".settings-updates-subcard-status")?.textContent).toContain("Version 1.2.0 available");
    click(button("View what changed in v1.2.0"));
    expect(onOpenUpdateNotes).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".settings-update-action-danger")).not.toBeNull();
    click(document.querySelector(".settings-update-action-danger")!);
    expect(update.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows progress while checking and disables the buttons", () => {
    app = mount(view({ update: updateState({ updateBusy: "checking" }) }));
    expect(document.querySelector(".settings-updates-subcard-status")?.textContent).toContain("Checking for updates…");
    expect(button("Checking…").disabled).toBe(true);
  });

  it("shows a message and an error with its link", () => {
    const onOpenLink = vi.fn();
    app = mount(view({ update: updateState({ updateMessage: "You are on the latest version.", updateError: "See https://github.com/dubba/AI-Usage-Tracker/releases" }), props: { onOpenLink } }));
    expect(document.querySelector(".settings-update-info")?.textContent).toBe("You are on the latest version.");
    expect(document.querySelector("[role=alert]")?.textContent).toContain("See ");
    click(document.querySelector(".settings-update-error-link")!);
    expect(onOpenLink).toHaveBeenCalledWith("https://github.com/dubba/AI-Usage-Tracker/releases");
  });

  it("opens the change log in the browser", () => {
    const onOpenLink = vi.fn();
    app = mount(view({ props: { onOpenLink } }));
    click(button("View change log (opens in web browser)"));
    expect(onOpenLink).toHaveBeenCalledWith("https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md");
  });
});

describe("Devices and the local API", () => {
  it("starts device linking", () => {
    const onOpenPairing = vi.fn();
    app = mount(view({ props: { onOpenPairing } }));
    click(button("Link Devices"));
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
  });

  it("shows the Paseo Bridge switch and window in Advanced, and its error", () => {
    const bridge = { enabled: true, error: "Port busy" } as BridgeStatus;
    const onToggleBridge = vi.fn();
    const onViewBridgeWindow = vi.fn();
    app = mount(view({ props: { bridge, onToggleBridge, onViewBridgeWindow } }));
    openAdvanced();
    const toggle = toggleLabelled("setting-bridge-label");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    click(toggle);
    expect(onToggleBridge).toHaveBeenCalledWith(false);
    click(button("View integration window (opens in a new window)"));
    expect(onViewBridgeWindow).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".api-integration-error")?.getAttribute("role")).toBe("alert");
    expect(document.querySelector(".api-integration-error")?.textContent).toBe("Port busy");
  });

  it("disables the bridge controls while they work", () => {
    app = mount(view({ props: { bridge: { enabled: false } as BridgeStatus, bridgeBusy: true, integrationWindowBusy: true } }));
    openAdvanced();
    expect(toggleLabelled("setting-bridge-label").disabled).toBe(true);
    expect(button("View integration window (opens in a new window)").disabled).toBe(true);
  });

  it("shows the menu button only when the shell provides one", () => {
    app = mount(view());
    expect(document.querySelector(".mobile-sidebar-toggle-btn")).toBeNull();
    const onToggleSidebar = vi.fn();
    app.rerender(view({ props: { onToggleSidebar, sidebarOpen: true } }));
    const menu = document.querySelector<HTMLButtonElement>(".mobile-sidebar-toggle-btn")!;
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    click(menu);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
