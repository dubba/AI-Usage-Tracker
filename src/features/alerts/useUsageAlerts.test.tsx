// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { payload: unknown }) => void;

const eventState = vi.hoisted(() => ({
  listeners: new Map<string, Listener[]>(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: Listener) => {
    eventState.listen(name);
    const list = eventState.listeners.get(name) ?? [];
    list.push(handler);
    eventState.listeners.set(name, list);
    return Promise.resolve(() => {
      eventState.unlisten(name);
      const current = eventState.listeners.get(name) ?? [];
      eventState.listeners.set(name, current.filter((item) => item !== handler));
    });
  },
}));

import { click, mount, settle, type Mounted } from "../../test-utils/react";
import { UsageAlertToasts } from "./UsageAlertToasts";
import { ALERT_AUTO_DISMISS_MS, useUsageAlerts } from "./useUsageAlerts";
import type { UsageAlertToast } from "./usage-alerts";

function AlertHost({
  enabled,
  onSelectAlert,
}: {
  enabled: boolean;
  onSelectAlert?: (alert: UsageAlertToast) => void;
}) {
  const { alerts, dismiss, dismissAll, setPaused } = useUsageAlerts(enabled);
  return enabled ? (
    <UsageAlertToasts
      alerts={alerts}
      onDismiss={dismiss}
      onDismissAll={dismissAll}
      onSelectAlert={onSelectAlert}
      onPauseChange={setPaused}
    />
  ) : null;
}

const SAMPLE_ALERT = {
  accountId: "acc-1",
  accountLabel: "Claude123",
  provider: "Claude",
  windowLabel: "5h",
  remainingPercent: 10,
  thresholdPercent: 20,
  title: "Claude 5h limit alert",
  body: "Claude123 has 10% remaining in the 5h window. Your alert threshold is 20%.",
};

const SECOND_ALERT = {
  accountId: "acc-2",
  accountLabel: "Codex Work",
  provider: "OpenAI",
  windowLabel: "5h",
  remainingPercent: 14,
  thresholdPercent: 20,
  title: "OpenAI 5h limit alert",
  body: "Codex Work has 14% remaining in the 5h window. Your alert threshold is 20%.",
};

function emitAlert(payload: unknown) {
  act(() => {
    for (const handler of eventState.listeners.get("usage-alert") ?? []) {
      handler({ payload });
    }
  });
}

let mounted: Mounted | null = null;

beforeEach(() => {
  eventState.listeners.clear();
  eventState.listen.mockClear();
  eventState.unlisten.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  mounted?.unmount();
  mounted = null;
});

describe("useUsageAlerts", () => {
  it("subscribes on desktop, renders incoming alerts, and dismisses them", async () => {
    mounted = mount(<AlertHost enabled />);
    await settle();

    expect(eventState.listen).toHaveBeenCalledWith("usage-alert");

    emitAlert(SAMPLE_ALERT);

    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);
    expect(mounted.container.textContent).toContain("Claude 5h limit alert");

    const close = mounted.container.querySelector<HTMLButtonElement>(".usage-alert-toast-close")!;
    click(close);
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(0);
  });

  it("does not subscribe or render when disabled (mobile)", async () => {
    mounted = mount(<AlertHost enabled={false} />);
    await settle();

    expect(eventState.listen).not.toHaveBeenCalled();
    expect(mounted.container.querySelector(".usage-alert-toast-container")).toBeNull();
  });

  it("pauses auto-dismiss while hovered or touched and resumes afterward", async () => {
    vi.useFakeTimers();
    mounted = mount(<AlertHost enabled />);
    await settle();

    emitAlert(SAMPLE_ALERT);
    const toast = mounted.container.querySelector<HTMLElement>(".usage-alert-toast")!;

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);

    // Hovering pauses the countdown even past the full auto-dismiss window.
    act(() => {
      toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    act(() => {
      vi.advanceTimersByTime(ALERT_AUTO_DISMISS_MS * 2);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);

    // Leaving resumes only the remaining ~10s.
    act(() => {
      toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    act(() => {
      vi.advanceTimersByTime(9_900);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);

    // Touching pauses it again.
    act(() => {
      toast.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);

    act(() => {
      toast.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(0);
  });

  it("collapses multiple alerts into one '2 alerts' banner and stays open until dismissed", async () => {
    vi.useFakeTimers();
    const onSelectAlert = vi.fn();
    mounted = mount(<AlertHost enabled onSelectAlert={onSelectAlert} />);
    await settle();

    emitAlert(SAMPLE_ALERT);
    emitAlert(SECOND_ALERT);

    // Collapsed into a single banner showing "2 alerts".
    const toasts = mounted.container.querySelectorAll(".usage-alert-toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].classList.contains("is-stacked")).toBe(true);
    expect(toasts[0].querySelector(".usage-alert-toast-count")?.textContent).toBe("2 alerts");

    // Stays open indefinitely while multiple alerts are active.
    act(() => {
      vi.advanceTimersByTime(ALERT_AUTO_DISMISS_MS * 4);
    });
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(1);

    // Tapping the banner selects the latest alert with its accountId.
    const main = mounted.container.querySelector<HTMLButtonElement>(".usage-alert-toast-main")!;
    click(main);
    expect(onSelectAlert).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acc-2" }));

    // Expanding shows each alert individually.
    const expand = mounted.container.querySelector<HTMLButtonElement>(".usage-alert-toast-expand")!;
    click(expand);
    const items = mounted.container.querySelectorAll<HTMLButtonElement>(".usage-alert-toast-item-jump");
    expect(items).toHaveLength(2);
    click(items[1]);
    expect(onSelectAlert).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: "acc-1" }));

    // Closing the banner dismisses all stacked alerts.
    const close = mounted.container.querySelector<HTMLButtonElement>(".usage-alert-toast-close")!;
    click(close);
    expect(mounted.container.querySelectorAll(".usage-alert-toast")).toHaveLength(0);
  });
});

