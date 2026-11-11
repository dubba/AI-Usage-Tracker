// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMonthDay } from "../../shared/lib/format";
import { click, mount, type Mounted } from "../../test-utils/react";
import type { LimitReset } from "../../types";
import { LimitResetsSection } from "./LimitResetsSection";

const grants: LimitReset[] = [
  {
    id: "grant-secret-1",
    label: "Full reset",
    detail: "Clears the 5-hour and weekly limits",
    expiresAt: "2026-12-10T16:00:00Z",
  },
  {
    id: "grant-secret-2",
    label: "Fable reset",
    detail: "Clears weekly Fable usage and refills the 5-hour limit.",
    expiresAt: null,
  },
];

describe("LimitResetsSection", () => {
  let app: Mounted | null = null;

  afterEach(() => {
    app?.unmount();
    app = null;
  });

  function render(onUse = vi.fn(), busy = false) {
    app = mount(<LimitResetsSection grants={grants} busy={busy} onUse={onUse} />);
    return onUse;
  }

  it("starts closed and hides what each reset does", () => {
    render();
    const toggle = document.querySelector(".limit-resets-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".limit-reset-detail")).toBeNull();
    expect(document.body.textContent).toContain("You have 2 available Limit Resets");
    expect(document.body.textContent).not.toContain("grant-secret-1");
  });

  it("opens to the name, the expiry, what it clears, and Use", () => {
    render();
    click(document.querySelector(".limit-resets-toggle")!);
    expect(document.querySelector(".limit-resets-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Full reset");
    expect(document.body.textContent).toContain(
      `Expires ${formatMonthDay(new Date("2026-12-10T16:00:00Z"))}`,
    );
    expect(document.body.textContent).toContain("Clears the 5-hour and weekly limits");
    expect(document.body.textContent).toContain("Fable reset");
    expect(document.body.textContent).toContain("Warning: This reset action cannot be undone!");
    expect(document.querySelectorAll(".limit-reset-use")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("grant-secret");
  });

  it("asks before using a reset, then calls back with its id", () => {
    const onUse = render();
    click(document.querySelector(".limit-resets-toggle")!);
    click(document.querySelectorAll(".limit-reset-use")[0]!);
    expect(document.body.textContent).toContain("Limit reset");
    expect(document.body.textContent).toContain("Clears the 5-hour and weekly limits. This cannot be undone.");
    expect(document.body.textContent).not.toContain("grant-secret-1");
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "Use" && button.classList.contains("remove-confirm-button"));
    expect(confirm).toBeTruthy();
    click(confirm!);
    expect(onUse).toHaveBeenCalledWith("grant-secret-1");
    expect(document.querySelector(".remove-account-modal")).toBeNull();
  });

  it("does not add a second period when the detail already ends with one", () => {
    render();
    click(document.querySelector(".limit-resets-toggle")!);
    click(document.querySelectorAll(".limit-reset-use")[1]!);
    expect(document.body.textContent).toContain(
      "Clears weekly Fable usage and refills the 5-hour limit. This cannot be undone.",
    );
    expect(document.body.textContent).not.toContain("limit..");
  });

  it("lists a Grok reset without a Use button", () => {
    const onUse = vi.fn();
    app = mount(
      <LimitResetsSection
        grants={[
          {
            id: "spend-secret-id",
            label: "Limit reset",
            detail: "Clears the weekly limit",
            expiresAt: "2026-12-10T16:00:00Z",
            usable: false,
          },
        ]}
        busy={false}
        onUse={onUse}
      />,
    );
    click(document.querySelector(".limit-resets-toggle")!);
    expect(document.querySelector(".limit-reset-use")).toBeNull();
    expect(document.querySelector(".limit-reset")?.classList.contains("is-readonly")).toBe(true);
    expect(document.body.textContent).toContain("Limit reset");
    expect(document.body.textContent).toContain("Clears the weekly limit");
    expect(document.body.textContent).toContain(
      `Expires ${formatMonthDay(new Date("2026-12-10T16:00:00Z"))}`,
    );
    expect(document.body.textContent).toContain("Redeem these in Grok, under Settings → Usage.");
    expect(document.body.textContent).not.toContain("Warning: This reset action cannot be undone!");
    expect(document.body.textContent).not.toContain("spend-secret-id");
    expect(onUse).not.toHaveBeenCalled();
  });

  it("leaves Use disabled while a reset is in progress", () => {
    render(vi.fn(), true);
    click(document.querySelector(".limit-resets-toggle")!);
    const use = document.querySelector(".limit-reset-use") as HTMLButtonElement;
    expect(use.disabled).toBe(true);
  });
});
