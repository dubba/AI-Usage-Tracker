// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AccountBucket, Provider } from "../../types";

const api = vi.hoisted(() => ({
  saveBucket: vi.fn(),
  deleteBucket: vi.fn(async () => {}),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { act } from "react";
import { click, mount, settle, typeInto, type Mounted } from "../../test-utils/react";
import { BucketModal } from "./BucketModal";
import { makeAccount as baseAccount } from "../../test-utils/accounts";

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

const makeAccount = (id: string, provider: Provider): Account => baseAccount({ id, label: `Account ${id}`, provider });

function makeBucket(accountIds: string[], provider: Provider | null): AccountBucket {
  return {
    id: "b1",
    name: "My Group",
    provider,
    accountIds,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function renderEdit(bucket: AccountBucket, accounts: Account[]) {
  api.saveBucket.mockImplementation(
    async (name: string, provider: Provider | null, ids: string[], id?: string) => ({
      id: id ?? "b1",
      name,
      provider,
      accountIds: ids,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  );
  mounted = mount(
    <BucketModal
      open
      bucket={bucket}
      accounts={accounts}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  return mounted.container;
}

const filterLabel = () =>
  document.querySelector(".bucket-filter-actions .custom-dropdown-label")?.textContent;
const pickerAccountLabels = () =>
  Array.from(document.querySelectorAll(".bucket-account-item .bucket-account-label")).map(
    (el) => el.textContent,
  );

describe("BucketModal create provider filter", () => {
  function renderCreate(accounts: Account[], initialProvider?: Provider | null) {
    mounted = mount(
      <BucketModal
        open
        bucket={null}
        initialProvider={initialProvider ?? null}
        accounts={accounts}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    return mounted.container;
  }

  it("starts on All Providers even when opened from a provider sidebar row", () => {
    renderCreate([makeAccount("a1", "anthropic"), makeAccount("a2", "openai")], "anthropic");
    expect(filterLabel()).toBe("All Providers");
    expect(document.activeElement).toBe(document.querySelector(".bucket-modal-card"));
  });

  it("does not pre-select the current provider's accounts", () => {
    renderCreate([makeAccount("a1", "anthropic"), makeAccount("a2", "openai")], "anthropic");
    expect(document.querySelector(".bucket-account-heading .field-label")?.textContent).toBe(
      "Select Accounts (0 selected)",
    );
    expect(document.querySelectorAll(".bucket-account-item.selected")).toHaveLength(0);
  });

  it("shows the empty-name validation error inline under Group Name and clears it on typing", async () => {
    renderCreate([makeAccount("a1", "anthropic")]);
    click(document.querySelector<HTMLButtonElement>(".bucket-modal-save-group .button.primary")!);
    const nameInput = document.querySelector<HTMLInputElement>("#bucket-name-input")!;
    const inlineError = document.querySelector(".field-inline-error");
    expect(inlineError?.textContent).toBe("Please enter a name for this group.");
    expect(nameInput.classList.contains("has-error")).toBe(true);
    expect(nameInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".modal-error")).toBeNull();

    typeInto(nameInput, "W");
    expect(document.querySelector(".field-inline-error")).toBeNull();
    expect(nameInput.classList.contains("has-error")).toBe(false);
  });

  it("places Select All beside Select Accounts in the header and keeps All Providers on its own row", () => {
    renderCreate([makeAccount("a1", "anthropic"), makeAccount("a2", "openai")]);
    const selectAll = document.querySelector<HTMLButtonElement>(".bucket-account-heading .bucket-select-all-btn")!;
    expect(selectAll).not.toBeNull();
    expect(selectAll.textContent).toBe("Select All");
    expect(document.querySelector(".bucket-filter-actions .bucket-select-all-btn")).toBeNull();

    click(selectAll);
    expect(selectAll.textContent).toBe("Deselect All");
    expect(document.querySelector(".bucket-account-heading .field-label")?.textContent).toBe(
      "Select Accounts (2 selected)",
    );
  });

  it("scrolls account rows inside the picker, not the rounded frame", () => {
    renderCreate([
      makeAccount("a1", "anthropic"),
      makeAccount("a2", "openai"),
      makeAccount("a3", "grok"),
      makeAccount("a4", "google_ai_studio"),
      makeAccount("a5", "antigravity"),
    ]);
    const list = document.querySelector(".bucket-account-picker-list");
    const scroll = document.querySelector(".bucket-account-picker-scroll");
    expect(list).not.toBeNull();
    expect(scroll).not.toBeNull();
    expect(list?.contains(scroll)).toBe(true);
    expect(scroll?.querySelectorAll(".bucket-account-item")).toHaveLength(5);
  });

  it("renders the scroll thumb outside the scroller and clamps its position at the bottom", () => {
    const scrollHeightSpy = vi.spyOn(HTMLDivElement.prototype, "scrollHeight", "get").mockReturnValue(360);
    const clientHeightSpy = vi.spyOn(HTMLDivElement.prototype, "clientHeight", "get").mockReturnValue(180);
    try {
      renderCreate([
        makeAccount("a1", "anthropic"),
        makeAccount("a2", "openai"),
        makeAccount("a3", "grok"),
        makeAccount("a4", "google_ai_studio"),
        makeAccount("a5", "antigravity"),
      ]);
      const list = document.querySelector<HTMLElement>(".bucket-account-picker-list")!;
      const scroll = document.querySelector<HTMLElement>(".bucket-account-picker-scroll")!;
      const thumb = list.querySelector<HTMLElement>(".scroll-thumb");
      expect(thumb).not.toBeNull();
      expect(scroll.contains(thumb)).toBe(false);
      expect(thumb?.parentElement).toBe(list);

      // Even if scrollTop overshoots the range (rubber-band overscroll), the thumb stays inside the 180px track.
      scroll.scrollTop = 260;
      act(() => {
        scroll.dispatchEvent(new Event("scroll"));
      });
      const height = parseFloat(thumb!.style.height);
      const match = thumb!.style.transform.match(/translateY\(([-\d.]+)px\)/);
      const y = Number(match?.[1] ?? NaN);
      expect(height).toBe(90);
      expect(y).toBe(90);
      expect(y + height).toBeLessThanOrEqual(180);
    } finally {
      scrollHeightSpy.mockRestore();
      clientHeightSpy.mockRestore();
    }
  });
});

describe("BucketModal account percentages", () => {
  function window(id: string, label: string, remainingPercent: number | null) {
    return { id, label, usedPercent: remainingPercent == null ? null : 100 - remainingPercent, remainingPercent, resetsAt: null, windowSeconds: null, kind: id === "five_hour" || id === "weekly" ? id : null };
  }

  function withWindows(id: string, provider: Provider, windows: ReturnType<typeof window>[]): Account {
    return { ...makeAccount(id, provider), lastUsage: { windows } } as unknown as Account;
  }

  const percents = () => Array.from(document.querySelectorAll(".bucket-account-percent")).map((el) => el.textContent);

  function renderCreate(accounts: Account[]) {
    mounted = mount(<BucketModal open bucket={null} accounts={accounts} onClose={vi.fn()} onSaved={vi.fn()} />);
  }

  it("shows a Grok account's Grok Bot limit, the same headline its card shows", () => {
    renderCreate([
      withWindows("g1", "grok", [window("weekly", "Weekly", 80), window("grok_bot", "Grok Bot weekly", 25)]),
    ]);
    expect(percents()).toEqual(["25%"]);
  });

  it("shows the first window for other providers, with the 5 hour limit ahead of the weekly one", () => {
    renderCreate([
      withWindows("o1", "openai", [window("weekly", "Weekly", 60), window("five_hour", "5 hour", 90)]),
      withWindows("a1", "anthropic", [window("five_hour", "5 hour", 40), window("weekly", "Weekly", 70)]),
    ]);
    expect(percents()).toEqual(["90%", "40%"]);
  });

  it("shows no percentage for an account without a reading", () => {
    renderCreate([makeAccount("x1", "openai"), withWindows("x2", "openai", [window("weekly", "Weekly", null)])]);
    expect(percents()).toEqual([]);
  });
});

describe("BucketModal edit provider filter", () => {
  it("starts on All Providers even when the group was saved under one provider", () => {
    renderEdit(makeBucket(["a1"], "anthropic"), [makeAccount("a1", "anthropic")]);
    expect(filterLabel()).toBe("All Providers");
  });

  it("shows every account in the picker, not only the group's provider", () => {
    renderEdit(makeBucket(["a1"], "anthropic"), [
      makeAccount("a1", "anthropic"),
      makeAccount("a2", "openai"),
      makeAccount("a3", "grok"),
    ]);
    expect(pickerAccountLabels()).toEqual(["Account a1", "Account a2", "Account a3"]);
  });

  it("persists no provider when saving an untouched filter, healing old derived values", async () => {
    renderEdit(makeBucket(["a1"], "anthropic"), [makeAccount("a1", "anthropic")]);
    click(document.querySelector<HTMLButtonElement>(".bucket-modal-save-group .button.primary")!);
    await settle();
    expect(api.saveBucket).toHaveBeenCalledWith("My Group", null, ["a1"], "b1");
  });

  it("persists the provider only when the dropdown was deliberately set", async () => {
    renderEdit(makeBucket(["a1"], null), [makeAccount("a1", "anthropic"), makeAccount("a2", "grok")]);
    click(document.querySelector<HTMLButtonElement>(".bucket-filter-actions .custom-dropdown-trigger")!);
    await settle();
    const option = Array.from(document.querySelectorAll<HTMLElement>(".custom-dropdown-item")).find(
      (el) => el.textContent?.includes("Grok"),
    )!;
    click(option);
    await settle();
    expect(filterLabel()).toBe("Grok");
    click(document.querySelector<HTMLButtonElement>(".bucket-modal-save-group .button.primary")!);
    await settle();
    expect(api.saveBucket).toHaveBeenCalledWith("My Group", "grok", ["a1"], "b1");
  });
});

describe("BucketModal unsaved changes and deletion clarity", () => {
  const pressBackdrop = async () => {
    await act(async () => {
      document.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
  };
  const confirmDialog = () => document.querySelector(".confirm-dialog-backdrop");
  const bucketDialog = () => document.querySelector(".bucket-modal-card");

  function renderWithClose(props: Partial<Parameters<typeof BucketModal>[0]> = {}) {
    const onClose = vi.fn();
    mounted = mount(
      <BucketModal
        open
        bucket={makeBucket(["a1"], "anthropic")}
        accounts={[makeAccount("a1", "anthropic")]}
        onClose={onClose}
        onSaved={vi.fn()}
        {...props}
      />,
    );
    return onClose;
  }

  it("closes a clean form without asking", () => {
    const onClose = renderWithClose();
    pressBackdrop();
    expect(confirmDialog()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding edits, and keeps them when cancelled", async () => {
    const onClose = renderWithClose();
    typeInto(document.querySelector<HTMLInputElement>(".bucket-modal-form .text-input")!, "Renamed Group");
    await pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmDialog()?.textContent).toContain("Discard changes?");
    expect(confirmDialog()?.textContent).toContain("haven't been saved");
    click(Array.from(document.querySelectorAll(".confirm-dialog-backdrop button")).find((b) => b.textContent === "Cancel")!);
    await settle();
    expect(confirmDialog()).toBeNull();
    expect(bucketDialog()).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>(".bucket-modal-form .text-input")!.value).toBe("Renamed Group");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("discards the edits after the confirmation", async () => {
    const onClose = renderWithClose();
    typeInto(document.querySelector<HTMLInputElement>(".bucket-modal-form .text-input")!, "Renamed Group");
    await pressBackdrop();
    click(Array.from(document.querySelectorAll(".confirm-dialog-backdrop button")).find((b) => b.textContent === "Discard Changes")!);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks before discarding when Escape is pressed on a dirty form", async () => {
    const onClose = renderWithClose();
    typeInto(document.querySelector<HTMLInputElement>(".bucket-modal-form .text-input")!, "Renamed");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmDialog()?.textContent).toContain("Discard changes?");
  });

  it("says exactly what deleting a group removes", () => {
    renderWithClose({ onDeleted: vi.fn() });
    click(Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Delete Group"))!);
    const dialog = confirmDialog()!;
    expect(dialog.getAttribute("role") === null).toBe(false);
    expect(dialog.textContent).toContain("Delete “My Group”?");
    expect(dialog.textContent).toContain("Only the grouping is removed");
    expect(dialog.textContent).toContain("accounts stay connected");
    expect(dialog.querySelector("[role=alertdialog]")).not.toBeNull();
  });
});
