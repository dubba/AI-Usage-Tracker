// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { AppSettings, AppUpdateStatus, BridgeStatus } from "../../types";
import { setNarrowWindow } from "../../test-utils/media";
import { getBottomNavLabels, setBottomNavLabels } from "../../shared/lib/bottom-nav-labels";
import { DEFAULT_ACCENT_COLOR, getAccentColor, hexToHsv, setAccentColor } from "../../shared/lib/accent-color";
import { getThemePreference, setThemePreference } from "../../shared/lib/theme";
import { getSyncOtherWays, setSyncOtherWays } from "../../shared/lib/sync-other-ways";
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
const toggleLabelled = (id: string) => document.querySelector<HTMLButtonElement>(`button[role=switch][aria-labelledby="${id}"]`)!;

describe("SettingsView header", () => {
  it("says what the page is for under its title, like the Accounts and Usage pages", () => {
    app = mount(view());
    const header = document.querySelector(".dashboard-header")!;
    expect(header.querySelector("p.dashboard-description")?.textContent).toBe("Manage app preferences, updates, and sync devices.");
    // After the title row, so it sits under the title.
    const parts = [...header.firstElementChild!.children].map((el) => el.className);
    expect(parts).toEqual(["dashboard-title-row", "dashboard-description"]);
  });
});

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
    for (const id of ["setting-autostart-label", "setting-auto-update-label", "setting-beta-label", "setting-bridge-label"]) {
      expect(document.getElementById(id), id).not.toBeNull();
      expect(toggleLabelled(id), id).not.toBeNull();
    }
  });

  it("displays Diagnostics, Clear Usage History, and Delete All App Data directly without an Advanced toggle", () => {
    app = mount(view());
    expect(document.querySelector(".settings-advanced-toggle")).toBeNull();
    const dataCard = document.querySelector("#settings-section-data")?.closest(".settings-card");
    expect(dataCard).not.toBeNull();
    const dataRows = [...dataCard!.querySelectorAll(".settings-row strong")].map((el) => el.textContent?.trim());
    expect(dataRows).toEqual(["Diagnostics", "Clear Usage History", "Delete All App Data"]);
    expect(dataCard?.textContent).not.toContain("Refresh Usage");
  });

  it("needs its contexts", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mount(<SettingsView onOpenLink={vi.fn()} bridge={null} bridgeBusy={false} integrationWindowBusy={false} onToggleBridge={vi.fn()} onViewBridgeWindow={vi.fn()} onAllDataDeleted={vi.fn()} />)).toThrow(
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

  it("opens a custom Accent Color modal without duplicate inline swatches and swaps the grid for the Custom Color view", () => {
    try {
      setAccentColor(DEFAULT_ACCENT_COLOR);
      setThemePreference("dark");
      app = mount(view());
      // Never uses the underlying OS <input type="color"> or duplicate inline swatch radios.
      expect(document.querySelector('input[type="color"]')).toBeNull();
      expect(document.querySelectorAll('.settings-card button[role="radio"]')).toHaveLength(0);

      const trigger = document.querySelector<HTMLButtonElement>("#setting-accent-color")!;
      expect(trigger.textContent?.trim()).toBe("Purple");

      // Open the custom "Pick Accent Color" modal.
      click(trigger);
      expect(document.querySelector(".modal-backdrop.accent-color-modal-backdrop")).not.toBeNull();
      const modal = document.querySelector(".accent-color-modal")!;
      expect(modal).not.toBeNull();
      expect(modal.textContent).toContain("Accent color");
      expect(modal.textContent).toContain("Pick Accent Color");
      expect(modal.textContent).toContain("Tap the color twice to toggle between Light and Dark mode");
      expect(modal.querySelector(".accent-custom-view")).toBeNull();

      const modalSwatches = [...modal.querySelectorAll<HTMLButtonElement>('.accent-color-grid button[role="radio"]')];
      expect(modalSwatches).toHaveLength(11);
      // Done is offered with the grid too, without Presets; focus starts on the dialog itself.
      expect(modal.querySelector(".accent-done-btn")).not.toBeNull();
      expect(document.activeElement).toBe(modal);
      expect(modal.querySelector(".accent-presets-btn")).toBeNull();

      // Select Emerald, then tap Emerald a second time to toggle Dark -> Light.
      const emerald = modalSwatches.find((el) => el.getAttribute("aria-label") === "Emerald")!;
      // The app's own tooltip (name and hex), not the browser's title tooltip.
      expect(emerald.getAttribute("data-tooltip")).toBe("Emerald · #0EA472");
      expect(modal.querySelector("[title]")).toBeNull();
      click(emerald);
      expect(getAccentColor()).toBe("#0ea472");
      expect(trigger.textContent?.trim()).toBe("Emerald");
      expect(getThemePreference()).toBe("dark");
      click(emerald);
      expect(getThemePreference()).toBe("light");

      // Tapping the + circle swaps the 4×3 grid for the Custom Color view in the same dialog.
      click(modal.querySelector<HTMLButtonElement>('button[aria-label="Custom color picker"]')!);
      expect(modal.querySelector(".accent-color-grid")).toBeNull();
      expect(modal.textContent).not.toContain("Tap the color twice");
      const customBox = modal.querySelector(".accent-custom-view")!;
      expect(customBox).not.toBeNull();
      // No heading of its own: the dialog's title says what it is.
      expect(customBox.querySelector("h3")).toBeNull();
      expect(customBox.querySelector(".accent-sv-plane")).not.toBeNull();
      expect(customBox.querySelector('[role="slider"][aria-label="Hue"]')).not.toBeNull();

      const hexInput = customBox.querySelector<HTMLInputElement>("#accent-custom-hex-input")!;
      expect(document.activeElement).toBe(modal);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(hexInput, "#c22222");
        hexInput.dispatchEvent(new Event("input", { bubbles: true }));
        hexInput.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(getAccentColor()).toBe("#c22222");
      expect(document.documentElement.style.getPropertyValue("--purple-fill")).toBe("#c22222");
      expect(trigger.textContent?.trim()).toBe("#C22222");

      // Clicking Reset restores default Purple while keeping the custom box open.
      const resetBtn = customBox.querySelector<HTMLButtonElement>(".accent-reset-btn")!;
      expect(resetBtn.disabled).toBe(false);
      click(resetBtn);
      expect(getAccentColor()).toBe(DEFAULT_ACCENT_COLOR);
      expect(document.documentElement.style.getPropertyValue("--purple-fill")).toBe("");
      expect(hexInput.value).toBe(DEFAULT_ACCENT_COLOR.toUpperCase());
      expect(resetBtn.disabled).toBe(true);

      // Presets goes back to the grid, with focus on the + circle.
      const presetsBtn = modal.querySelector<HTMLButtonElement>(".accent-modal-actions .accent-presets-btn")!;
      expect(presetsBtn.classList.contains("button-tertiary")).toBe(true);
      click(presetsBtn);
      expect(modal.querySelector(".accent-custom-view")).toBeNull();
      expect(modal.querySelectorAll('.accent-color-grid button[role="radio"]')).toHaveLength(11);
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Custom color picker");
      expect(trigger.textContent?.trim()).toBe("Purple");

      // Tapping the circle on the color square toggles Light/Dark and keeps the color.
      click(modal.querySelector<HTMLButtonElement>('button[aria-label="Custom color picker"]')!);
      const plane = modal.querySelector<HTMLDivElement>(".accent-sv-plane")!;
      plane.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
      const { s, v } = hexToHsv(DEFAULT_ACCENT_COLOR);
      const thumb = { clientX: s * 200, clientY: (1 - v) * 100 };
      const press = (type: string, at: { clientX: number; clientY: number }) =>
        act(() => {
          plane.dispatchEvent(new MouseEvent(type, { bubbles: true, buttons: type === "pointerup" ? 0 : 1, ...at }));
        });
      expect(getThemePreference()).toBe("light");
      press("pointerdown", thumb);
      press("pointerup", thumb);
      expect(getThemePreference()).toBe("dark");
      expect(getAccentColor()).toBe(DEFAULT_ACCENT_COLOR);

      // Dragging the circle picks a color instead, without toggling.
      press("pointerdown", thumb);
      press("pointermove", { clientX: thumb.clientX - 40, clientY: thumb.clientY + 20 });
      press("pointerup", { clientX: thumb.clientX - 40, clientY: thumb.clientY + 20 });
      expect(getThemePreference()).toBe("dark");
      expect(getAccentColor()).not.toBe(DEFAULT_ACCENT_COLOR);

      // Done closes the dialog, keeping the color chosen.
      const chosen = getAccentColor();
      click(document.querySelector<HTMLButtonElement>(".accent-done-btn")!);
      expect(document.querySelector(".accent-color-modal")).toBeNull();
      expect(getAccentColor()).toBe(chosen);

      // Reopening with a custom color active opens Custom Color with focus on the dialog (not the hex input, so mobile keyboards stay closed).
      click(trigger);
      const reopened = document.querySelector(".accent-color-modal")!;
      expect(reopened.querySelector(".accent-custom-view")).not.toBeNull();
      expect(document.activeElement).toBe(reopened);
      click(reopened.querySelector<HTMLButtonElement>(".accent-done-btn")!);
    } finally {
      setThemePreference("dark");
      setAccentColor(DEFAULT_ACCENT_COLOR);
    }
  });

  it("offers the bottom bar's labels switch on a narrow window, and saves the choice", () => {
    setNarrowWindow(true);
    try {
      app = mount(view());
      expect(document.body.textContent).toContain("Show labels below icons in bottom bar.");
      const toggle = toggleLabelled("setting-nav-labels-label");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      click(toggle);
      expect(getBottomNavLabels()).toBe("off");
      expect(toggleLabelled("setting-nav-labels-label").getAttribute("aria-checked")).toBe("false");
    } finally {
      setBottomNavLabels("on");
      vi.restoreAllMocks();
    }
  });

  it("hides Sync Devices' other ways to connect by default, with a switch under Devices to show them", () => {
    try {
      setSyncOtherWays("off");
      app = mount(view());
      const devicesCard = document.getElementById("settings-section-devices")?.closest(".settings-card");
      expect(devicesCard).not.toBeNull();
      expect(document.getElementById("settings-section-sync-options")).toBeNull();
      expect(devicesCard?.textContent).toContain("Show a 6-digit code for older app versions and QR codes in Sync Devices.");
      const toggle = toggleLabelled("setting-sync-other-ways-label");
      expect(devicesCard?.contains(toggle)).toBe(true);
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      click(toggle);
      expect(getSyncOtherWays()).toBe("on");
      expect(toggleLabelled("setting-sync-other-ways-label").getAttribute("aria-checked")).toBe("true");
    } finally {
      setSyncOtherWays("off");
    }
  });

  it("leaves that switch out on a wide window, which has no bottom bar", () => {
    app = mount(view());
    expect(document.getElementById("setting-nav-labels-label")).toBeNull();
  });

  it.each([
    ["Android", "Mozilla/5.0 (Linux; Android 16; Pixel) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"],
    ["iOS", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"],
  ])("hides launch at startup on %s, where an app cannot open itself at boot", (_name, agent) => {
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
    try {
      app = mount(view());
      expect(document.getElementById("setting-autostart-label")).toBeNull();
      expect(document.body.textContent).not.toContain("Launch at Startup");
      expect(document.body.textContent).toContain("Account Refresh");
    } finally {
      userAgent.mockRestore();
    }
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
  it("toggles switches when clicking their label, description, or row background without double-firing", () => {
    setNarrowWindow(true);
    const settings = settingsState({ autostart: false });
    try {
      app = mount(view({ settings }));

      // Launch at Startup: click description text
      click(document.querySelector("#setting-autostart-label")!.nextElementSibling!);
      expect(settings.toggleAutostart).toHaveBeenCalledTimes(1);

      // Menu Bar Labels: click label text, description text, and row padding
      expect(getBottomNavLabels()).toBe("on");
      click(document.getElementById("setting-nav-labels-label")!);
      expect(getBottomNavLabels()).toBe("off");
      click(document.getElementById("setting-nav-labels-label")!.nextElementSibling!);
      expect(getBottomNavLabels()).toBe("on");
      click(document.getElementById("setting-nav-labels-label")!.closest(".settings-toggle-row")!);
      expect(getBottomNavLabels()).toBe("off");

      // Direct switch click still toggles once
      click(toggleLabelled("setting-nav-labels-label"));
      expect(getBottomNavLabels()).toBe("on");
    } finally {
      setBottomNavLabels("on");
      vi.restoreAllMocks();
    }
  });
});

describe("Updates", () => {
  it("saves the automatic and beta switches, and disables them while saving", () => {
    const settings = settingsState();
    app = mount(view({ settings }));
    click(toggleLabelled("setting-auto-update-label"));
    expect(settings.saveAutomaticUpdatesEnabled).toHaveBeenCalledWith(false);
    click(document.getElementById("setting-auto-update-label")!.nextElementSibling!);
    expect(settings.saveAutomaticUpdatesEnabled).toHaveBeenLastCalledWith(false);
    click(document.getElementById("setting-beta-label")!);
    expect(settings.saveIncludeBetaUpdates).toHaveBeenCalledWith(true);

    app.rerender(view({ settings: settingsState({ automaticUpdatesBusy: true, includeBetaUpdatesBusy: true }) }));
    expect(toggleLabelled("setting-auto-update-label").disabled).toBe(true);
    expect(toggleLabelled("setting-beta-label").disabled).toBe(true);
    click(document.getElementById("setting-auto-update-label")!);
    click(document.getElementById("setting-beta-label")!);
    expect(settings.saveAutomaticUpdatesEnabled).toHaveBeenCalledTimes(2);
    expect(settings.saveIncludeBetaUpdates).toHaveBeenCalledTimes(1);
  });

  it("says the app is up to date and checks on request", () => {
    const update = updateState();
    app = mount(view({ update }));
    expect(document.querySelector(".settings-installed-version")?.textContent).toBe("Current Version: 1.0.0");
    expect(document.querySelector(".settings-updates-subcard-status")?.textContent).toContain("Up to date");
    const checkBtn = button("Check Now");
    expect(checkBtn.classList.contains("settings-accent-action")).toBe(true);
    expect(checkBtn.classList.contains("button-green")).toBe(false);
    click(checkBtn);
    expect(update.checkForUpdate).toHaveBeenCalledWith(true);
  });

  it("offers to install an available update and its notes", () => {
    const update = updateState({ appUpdate: available("v1.2.0") });
    const onOpenUpdateNotes = vi.fn();
    app = mount(view({ update, props: { onOpenUpdateNotes } }));
    expect(document.querySelector(".settings-updates-subcard-status")?.textContent).toContain("Version 1.2.0 available");
    expect(document.querySelector(".settings-updates-subcard-status .status-indicator-dot.amber")).not.toBeNull();
    click(button("View what changed in v1.2.0"));
    expect(onOpenUpdateNotes).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".button-green")).not.toBeNull();
    click(document.querySelector(".button-green")!);
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
    expect(document.body.textContent).toContain("Sync accounts & credentials to another device securely.");
    click(button("Sync Devices"));
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
  });

  it("shows the Paseo Bridge switch and window directly, and its error", () => {
    const bridge = { enabled: true, error: "Port busy" } as BridgeStatus;
    const onToggleBridge = vi.fn();
    const onViewBridgeWindow = vi.fn();
    app = mount(view({ props: { bridge, onToggleBridge, onViewBridgeWindow } }));
    const toggle = toggleLabelled("setting-bridge-label");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    click(toggle);
    expect(onToggleBridge).toHaveBeenCalledWith(false);
    click(document.getElementById("setting-bridge-label")!);
    expect(onToggleBridge).toHaveBeenCalledTimes(2);
    click(button("View integration window (opens in a new window)"));
    expect(onViewBridgeWindow).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".api-integration-error")?.getAttribute("role")).toBe("alert");
    expect(document.querySelector(".api-integration-error")?.textContent).toBe("Port busy");
  });

  it("disables the bridge controls while they work", () => {
    app = mount(view({ props: { bridge: { enabled: false } as BridgeStatus, bridgeBusy: true, integrationWindowBusy: true } }));
    expect(toggleLabelled("setting-bridge-label").disabled).toBe(true);
    expect(button("View integration window (opens in a new window)").disabled).toBe(true);
  });

  it("hides the sidebar filter button on Settings because Settings is global", () => {
    setNarrowWindow(true);
    app = mount(view());
    expect(document.querySelector(".mobile-sidebar-toggle-btn")).toBeNull();
    const heading = document.querySelector("h1.eyebrow");
    expect(heading?.querySelector("svg.settings-title-icon")).not.toBeNull();
    expect(heading?.textContent).toBe("App Settings");
  });
});

describe("SettingsView section layout and jump navigation (L3)", () => {
  it("labels all Settings cards directly with h2 headings", () => {
    app = mount(view());
    const headings = [...document.querySelectorAll("h2.settings-card-heading")].map((el) => el.textContent?.trim());
    expect(headings).toEqual(["General", "Updates", "Devices", "Data & Diagnostics", "Integrations", "Keyboard Shortcuts"]);
  });

  it("scrolls the target section when jumpTarget changes", () => {
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const onActiveSectionChange = vi.fn();
    app = mount(view({ props: { onActiveSectionChange } }));
    const scroller = document.querySelector<HTMLDivElement>(".dashboard-scroll")!;
    const scrollToSpy = vi.fn();
    scroller.scrollTo = scrollToSpy;

    app.rerender(view({ props: { jumpTarget: { section: "integrations", seq: 1 }, onActiveSectionChange } }));
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
    expect(onActiveSectionChange).toHaveBeenCalledWith("integrations");

    app.rerender(view({ props: { jumpTarget: { section: "shortcuts", seq: 2 }, onActiveSectionChange } }));
    expect(scrollToSpy).toHaveBeenCalledTimes(2);
    expect(onActiveSectionChange).toHaveBeenCalledWith("shortcuts");
    rafSpy.mockRestore();
  });

  it("tracks Data & Diagnostics and Integrations during scroll instead of skipping from Devices to Keyboard Shortcuts", () => {
    const onActiveSectionChange = vi.fn();
    app = mount(view({ props: { onActiveSectionChange } }));
    const scroller = document.querySelector<HTMLDivElement>(".dashboard-scroll")!;

    let currentScrollTop = 0;
    Object.defineProperty(scroller, "clientHeight", { value: 900, configurable: true });
    Object.defineProperty(scroller, "scrollHeight", { value: 1450, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => currentScrollTop,
      set: (value: number) => {
        currentScrollTop = value;
      },
      configurable: true,
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 720, 900));

    const tops: Record<string, number> = {
      "settings-section-general": 18,
      "settings-section-updates": 270,
      "settings-section-devices": 620,
      "settings-section-data": 740,
      "settings-section-integrations": 990,
      "settings-section-shortcuts": 1170,
    };
    for (const [id, contentTop] of Object.entries(tops)) {
      const el = document.getElementById(id)!;
      vi.spyOn(el, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, contentTop - currentScrollTop, 720, 32));
    }

    const activeAt = (scrollTop: number) => {
      currentScrollTop = scrollTop;
      act(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      return onActiveSectionChange.mock.calls.at(-1)?.[0];
    };

    expect(activeAt(0)).toBe("general");
    expect(activeAt(100)).toBe("updates");
    expect(activeAt(240)).toBe("devices");
    expect(activeAt(300)).toBe("data");
    expect(activeAt(400)).toBe("integrations");
    expect(activeAt(550)).toBe("shortcuts");
    // Scrolling back up hits Integrations and Data & Diagnostics before Devices
    expect(activeAt(400)).toBe("integrations");
    expect(activeAt(300)).toBe("data");
    expect(activeAt(240)).toBe("devices");

    vi.restoreAllMocks();
  });
});
