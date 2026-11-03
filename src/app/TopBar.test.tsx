// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../test-utils/react";
import { REFRESH_ALL_KEY } from "../shared/lib/busy";
import type { Account } from "../types";
import { TopBar } from "./TopBar";
import type { Section } from "./useSidebarNavigation";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function render(section: Section, busy: Set<string> = new Set()) {
  const handlers = { onSelect: vi.fn(), onRefreshAll: vi.fn(), onAddAccount: vi.fn(), onAddGroup: vi.fn() };
  mounted = mount(<TopBar section={section} accounts={[]} refreshMinutes={15} busy={busy} {...handlers} />);
  const pages = [...mounted.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Main"] button')];
  return { handlers, pages };
}

describe("TopBar", () => {
  it("lists Accounts, Usage and Settings and marks the current page", () => {
    const { pages } = render("activity");
    expect(pages.map((page) => page.textContent)).toEqual(["Accounts", "Usage", "Settings"]);
    expect(pages.map((page) => page.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("describes each page in a tooltip", () => {
    const { pages } = render("accounts");
    expect(pages.map((page) => page.getAttribute("data-tooltip"))).toEqual([
      "View of all accounts and usage limits",
      "See daily usage against weekly limits",
      "Customize app preferences and settings",
    ]);
  });

  it("says when all accounts were last synced", () => {
    const fetchedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const account = { id: "a", lastUsage: { fetchedAt }, provider: "anthropic", authRequired: false } as unknown as Account;
    mounted = mount(<TopBar section="accounts" accounts={[account]} refreshMinutes={15} busy={new Set()} onSelect={vi.fn()} onRefreshAll={vi.fn()} onAddAccount={vi.fn()} onAddGroup={vi.fn()} />);
    expect(mounted.container.querySelector(".top-bar-sync")?.textContent).toBe("All accounts synced 3m ago");
  });

  it("opens a page when clicked", () => {
    const { pages, handlers } = render("accounts");
    click(pages[2]);
    expect(handlers.onSelect).toHaveBeenCalledWith("settings");
  });

  it("offers Refresh all, the Left / Used switch, Add account and New group", () => {
    const { handlers } = render("accounts");
    const container = mounted!.container;
    expect(container.textContent).toContain("Not synced yet");
    expect([...container.querySelectorAll('[aria-label="Usage display"] button')].map((b) => b.textContent)).toEqual(["Left", "Used"]);
    click(container.querySelector<HTMLButtonElement>('[aria-label="Refresh all accounts"]')!);
    click(container.querySelector<HTMLButtonElement>(".top-bar-add-account")!);
    click(container.querySelector<HTMLButtonElement>('[aria-label="New group"]')!);
    expect(handlers.onRefreshAll).toHaveBeenCalledTimes(1);
    expect(handlers.onAddAccount).toHaveBeenCalledTimes(1);
    expect(handlers.onAddGroup).toHaveBeenCalledTimes(1);
  });

  it("says it is syncing and holds Refresh all while a refresh runs", () => {
    render("accounts", new Set([REFRESH_ALL_KEY]));
    expect(mounted!.container.textContent).toContain("Syncing…");
    expect(mounted!.container.querySelector<HTMLButtonElement>('[aria-label="Refresh all accounts"]')!.disabled).toBe(true);
  });
});
