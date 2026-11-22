// @vitest-environment happy-dom
// The counting and dismissing shared with the other hints is tested in `useSessionHint.test.tsx`.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { announceReorder } from "../../shared/lib/events";
import { hintStorageKeys, storageGet, type HintPage } from "../../shared/lib/storage";
import { resetLayoutForTests } from "../layout/layout-store";
import { useReorderHint } from "./useReorderHint";

let latest: ReturnType<typeof useReorderHint>;
let latestActivity: ReturnType<typeof useReorderHint>;

function capture(page: HintPage, hint: ReturnType<typeof useReorderHint>) {
  if (page === "activity") latestActivity = hint;
  else latest = hint;
}

function Probe({ canReorder, page = "accounts" }: { canReorder: boolean; page?: HintPage }) {
  capture(page, useReorderHint(canReorder, page));
  return null;
}

let mounted: Mounted | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLayoutForTests();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("useReorderHint", () => {
  it("is done for good after the user moves a card or a group", () => {
    mounted = mount(<Probe canReorder />);
    expect(latest.show).toBe(true);
    act(() => announceReorder("accounts"));
    expect(latest.show).toBe(false);
    expect(storageGet(hintStorageKeys("reorder", "accounts").seen)).toBe("1");
    sessionStorage.clear();
    mounted.unmount();
    mounted = mount(<Probe canReorder />);
    expect(latest.show).toBe(false);
  });

  it("also finishes when a sidebar group is moved on that page", () => {
    mounted = mount(<Probe canReorder />);
    const stage = document.createElement("div");
    stage.innerHTML = '<div class="kept-page" data-page="accounts"></div>';
    document.body.append(stage);
    act(() => announceReorder("sidebar"));
    stage.remove();
    expect(latest.show).toBe(false);
  });

  it("keeps each page's hint when a card is moved on the other page", () => {
    mounted = mount(<><Probe canReorder page="accounts" /><Probe canReorder page="activity" /></>);
    act(() => announceReorder("accounts"));
    expect(latest.show).toBe(false);
    expect(latestActivity.show).toBe(true);
    expect(storageGet(hintStorageKeys("reorder", "activity").seen)).toBeNull();
    act(() => announceReorder("activity"));
    expect(latestActivity.show).toBe(false);
    expect(storageGet(hintStorageKeys("reorder", "activity").seen)).toBe("1");
  });

  it("finishes only the page on screen when a sidebar group is moved, and none from Settings", () => {
    mounted = mount(<><Probe canReorder page="accounts" /><Probe canReorder page="activity" /></>);
    const stage = document.createElement("div");
    stage.innerHTML = '<div class="kept-page" data-page="settings"></div>';
    document.body.append(stage);
    act(() => announceReorder("sidebar"));
    expect(latest.show).toBe(true);
    expect(latestActivity.show).toBe(true);

    stage.innerHTML = '<div class="kept-page" data-page="activity"></div><div class="kept-page" data-page="accounts" hidden></div>';
    act(() => announceReorder("sidebar"));
    expect(latestActivity.show).toBe(false);
    expect(latest.show).toBe(true);
    stage.remove();
  });
});
