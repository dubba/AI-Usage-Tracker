// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account, AccountBucket, Provider } from "../../types";

const api = vi.hoisted(() => ({
  saveBucket: vi.fn(),
  deleteBucket: vi.fn(async () => {}),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

import { click, mount, settle, type Mounted } from "../../test-utils/react";
import { BucketModal } from "./BucketModal";

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.clearAllMocks();
});

function makeAccount(id: string, provider: Provider): Account {
  return {
    id,
    label: `Account ${id}`,
    provider,
    lastUsage: null,
    lastError: null,
    authRequired: false,
  } as unknown as Account;
}

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
