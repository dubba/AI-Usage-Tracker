// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { rememberVisiblePageScroll, restorePageScroll, watchPageScrollRestore } from "./page-scroll";

function installPages(): { usage: HTMLElement; accounts: HTMLElement; settings: HTMLElement } {
  document.body.innerHTML = `
    <main class="main-stage">
      <div class="kept-page" data-page="activity">
        <div class="dashboard-scroll" data-scroller="activity"></div>
      </div>
      <div class="kept-page" data-page="accounts" hidden>
        <div class="dashboard-scroll" data-scroller="accounts"></div>
      </div>
      <div class="kept-page" data-page="settings" hidden>
        <div class="dashboard-scroll" data-scroller="settings"></div>
      </div>
    </main>`;
  const usage = document.querySelector<HTMLElement>('[data-scroller="activity"]')!;
  const accounts = document.querySelector<HTMLElement>('[data-scroller="accounts"]')!;
  const settings = document.querySelector<HTMLElement>('[data-scroller="settings"]')!;
  for (const node of [usage, accounts, settings]) {
    Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(node, "clientHeight", { configurable: true, get: () => 100 });
  }
  return { usage, accounts, settings };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("page scroll memory", () => {
  it("returns the page you left to the same place", () => {
    const { usage, accounts } = installPages();
    usage.scrollTop = 640;
    rememberVisiblePageScroll();
    usage.scrollTop = 0;

    accounts.removeAttribute("hidden");
    document.querySelector('[data-page="activity"]')!.setAttribute("hidden", "");
    accounts.scrollTop = 80;
    rememberVisiblePageScroll();

    document.querySelector('[data-page="activity"]')!.removeAttribute("hidden");
    expect(restorePageScroll("activity")).toBe(true);
    expect(usage.scrollTop).toBe(640);
    expect(restorePageScroll("accounts")).toBe(true);
    expect(accounts.scrollTop).toBe(80);

    const { settings } = installPages();
    document.querySelector('[data-page="activity"]')!.setAttribute("hidden", "");
    document.querySelector('[data-page="settings"]')!.removeAttribute("hidden");
    settings.scrollTop = 150;
    rememberVisiblePageScroll();
    settings.scrollTop = 0;
    expect(restorePageScroll("settings")).toBe(true);
    expect(settings.scrollTop).toBe(150);
  });

  it("keeps the saved place while the page is too short to scroll", () => {
    const { usage } = installPages();
    usage.scrollTop = 320;
    rememberVisiblePageScroll();
    usage.scrollTop = 0;
    Object.defineProperty(usage, "scrollHeight", { configurable: true, get: () => 50 });

    expect(restorePageScroll("activity")).toBe(false);
    expect(usage.scrollTop).toBe(0);

    Object.defineProperty(usage, "scrollHeight", { configurable: true, get: () => 2000 });
    expect(restorePageScroll("activity")).toBe(true);
    expect(usage.scrollTop).toBe(320);
  });

  it("forgets a position once you scroll that page back to the top", () => {
    const { usage } = installPages();
    usage.scrollTop = 400;
    rememberVisiblePageScroll();
    usage.scrollTop = 0;
    rememberVisiblePageScroll();
    usage.scrollTop = 20;
    expect(restorePageScroll("activity")).toBe(true);
    expect(usage.scrollTop).toBe(20);
  });

  it("tries again until the page can hold the saved place", async () => {
    const { usage } = installPages();
    usage.scrollTop = 240;
    rememberVisiblePageScroll();
    usage.scrollTop = 0;
    Object.defineProperty(usage, "scrollHeight", { configurable: true, get: () => 40 });

    let frames = 0;
    const original = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
      frames += 1;
      if (frames === 2) {
        Object.defineProperty(usage, "scrollHeight", { configurable: true, get: () => 2000 });
      }
      callback(0);
      return frames;
    };
    try {
      const cancel = watchPageScrollRestore("activity");
      expect(usage.scrollTop).toBe(240);
      expect(frames).toBe(2);
      cancel();
    } finally {
      globalThis.requestAnimationFrame = original;
    }
  });
});
