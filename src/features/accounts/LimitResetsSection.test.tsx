// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMonthDay } from "../../shared/lib/format";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { LimitReset, UsageWindow } from "../../types";
import { LimitResetsSection } from "./LimitResetsSection";

const grants: LimitReset[] = [
  {
    id: "grant-secret-2",
    label: "Fable reset",
    detail: "Clears 7-day Fable usage and refills the 5-hour limit.",
    expiresAt: null,
  },
  {
    id: "grant-secret-1",
    label: "Full reset",
    detail: "Clears the 5-hour and 7-day limits",
    expiresAt: "2026-12-10T16:00:00Z",
  },
];

const windows: UsageWindow[] = [
  { id: "five_hour", label: "5-Hour", usedPercent: 0, remainingPercent: 100, resetsAt: null, windowSeconds: 18_000, kind: "five_hour" },
  { id: "seven_day", label: "Weekly", usedPercent: 22, remainingPercent: 78, resetsAt: null, windowSeconds: 604_800, kind: "weekly" },
];

const useButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".limit-reset-use")];
const confirmButton = () =>
  [...document.querySelectorAll("button")].find((button) => button.textContent === "Use reset");

describe("LimitResetsSection", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  function render(onUse = vi.fn(), busy = false, list = grants) {
    app = mount(
      <LimitResetsSection grants={list} windows={windows} accountLabel="Claude2" busy={busy} onUse={onUse} />,
    );
    return onUse;
  }

  it("shows the reset that expires first as one row, with the rest behind a button", () => {
    render();
    const rows = document.querySelectorAll(".limit-reset");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Full reset");
    expect(rows[0].querySelector(".limit-reset-detail")?.textContent).toBe(
      `Expires ${formatMonthDay(new Date("2026-12-10T16:00:00Z"))}`,
    );
    expect(rows[0].textContent).not.toContain("Clears the 5-hour and 7-day limits");
    expect(useButtons()[0].textContent).toBe("Use");
    expect(useButtons()[0].getAttribute("aria-label")).toBe("Use Full reset");
    expect(document.body.textContent).not.toContain("cannot be undone");
    expect(document.body.textContent).not.toContain("grant-secret");

    const more = document.querySelector(".limit-resets-more")!;
    expect(more.textContent).toBe("1 more reset");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    click(more);
    const expandedRows = document.querySelectorAll(".limit-reset");
    expect(expandedRows).toHaveLength(2);
    expect(expandedRows[1].textContent).toContain("Fable reset");
    expect(expandedRows[1].querySelector(".limit-reset-detail")).toBeNull();
    expect(document.body.textContent).not.toContain("Clears 7-day Fable usage");
    expect(more.textContent).toBe("Show less");
  });

  it("has no more button when there is a single reset", () => {
    render(vi.fn(), false, [grants[1]]);
    expect(document.querySelector(".limit-resets-more")).toBeNull();
    expect(document.querySelector(".limit-resets-footer")).toBeNull();
  });

  it("asks before using a reset, with advice from current usage, then calls back with its id", () => {
    const onUse = render();
    click(useButtons()[0]);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.querySelector(".modal-kicker")?.textContent).toBe("Full reset");
    expect(dialog.querySelector("h2")?.textContent).toBe("Use this limit reset?");
    expect(dialog.querySelector("p")?.textContent).toBe(
      "Clears the 5-hour and 7-day limits for Claude2. You have only 2 left.",
    );
    expect(dialog.querySelector("p strong")?.textContent).toBe("Claude2");
    const note = document.querySelector(".confirm-dialog-note");
    expect(note?.classList.contains("is-caution")).toBe(true);
    expect(note?.querySelector(".confirm-dialog-note-icon")).not.toBeNull();
    // The can't-be-undone line is said once, at the end of the advice.
    expect(note?.textContent).toBe(
      "Your 5-hour limit is already full, so you'd only get back 22% of your 7-day limit. This can't be undone.",
    );
    expect(document.querySelector('[role="alertdialog"]')?.getAttribute("aria-describedby")).toContain(note!.id);
    expect(document.body.textContent).toContain("Keep for later");
    expect(document.body.textContent).not.toContain("grant-secret-1");
    click(confirmButton()!);
    expect(onUse).toHaveBeenCalledWith("grant-secret-1");
    expect(document.querySelector(".confirm-dialog-note")).toBeNull();
  });

  it("updates the advice when the usage refreshes while the dialog is open", () => {
    render();
    click(useButtons()[0]);
    expect(document.querySelector(".confirm-dialog-note")?.textContent).toContain("22% of your 7-day limit");
    const refreshed = windows.map((window) => (window.kind === "weekly" ? { ...window, remainingPercent: 60 } : window));
    app!.rerender(
      <LimitResetsSection grants={grants} windows={refreshed} accountLabel="Claude2" busy={false} onUse={vi.fn()} />,
    );
    expect(document.querySelector(".confirm-dialog-note")?.textContent).toContain("40% of your 7-day limit");
  });

  it("closes without using the reset on Keep for later", () => {
    const onUse = render();
    click(useButtons()[0]);
    click([...document.querySelectorAll("button")].find((button) => button.textContent === "Keep for later")!);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });

  it("leaves the advice out when the usage cannot be matched", () => {
    render();
    click(document.querySelector(".limit-resets-more")!);
    // The Fable reset: this account has no Fable window.
    click(useButtons()[1]);
    expect(document.querySelector(".confirm-dialog-note")).toBeNull();
    expect(document.querySelector('[role="alertdialog"] p')?.textContent).toBe(
      "Clears 7-day Fable usage and refills the 5-hour limit for Claude2. You have only 2 left. This can't be undone.",
    );
    expect(document.body.textContent).not.toContain("limit..");
  });

  it("asks about your reset, singular, when it is the only one", () => {
    render(vi.fn(), false, [grants[1]]);
    click(useButtons()[0]);
    expect(document.querySelector('[role="alertdialog"] h2')?.textContent).toBe("Use your limit reset?");
    expect(document.body.textContent).toContain("You have only 1 left.");
  });

  it("lists a Grok reset without a Use button", () => {
    const onUse = vi.fn();
    app = mount(
      <LimitResetsSection
        grants={[
          {
            id: "spend-secret-id",
            label: "Limit reset",
            detail: "Clears the 7-day limit",
            expiresAt: "2026-12-10T16:00:00Z",
            usable: false,
          },
        ]}
        windows={windows}
        busy={false}
        onUse={onUse}
      />,
    );
    expect(document.querySelector(".limit-reset-use")).toBeNull();
    expect(document.querySelector(".limit-reset")?.classList.contains("is-readonly")).toBe(true);
    expect(document.body.textContent).toContain("Limit reset");
    expect(document.querySelector(".limit-reset-detail")?.textContent).toBe(
      `Expires ${formatMonthDay(new Date("2026-12-10T16:00:00Z"))}`,
    );
    expect(document.body.textContent).not.toContain("Clears the 7-day limit");
    expect(document.body.textContent).toContain("Redeem it in Grok, under Settings → Usage.");
    expect(document.body.textContent).not.toContain("spend-secret-id");
    expect(onUse).not.toHaveBeenCalled();
  });

  it("says when a paused reset can be tried again", () => {
    app = mount(
      <LimitResetsSection
        grants={[
          { id: "a", label: "Limit reset", detail: "Clears the 5-hour limit. Not usable right now.", expiresAt: null, usable: false },
          { id: "b", label: "Limit reset", detail: "Clears the 7-day limit", expiresAt: null, usable: false },
        ]}
        windows={windows}
        busy={false}
      />,
    );
    expect(document.body.textContent).toContain("These can't be used right now. Try again in a few minutes.");
  });

  it("leaves Use disabled while a reset is in progress", () => {
    render(vi.fn(), true);
    expect(useButtons()[0].disabled).toBe(true);
  });
});
