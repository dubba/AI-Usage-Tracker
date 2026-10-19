import { describe, expect, it } from "vitest";
import {
  ALL_ACCOUNTS_GROUP_ID,
  bucketGroupId,
  bucketIdFromGroup,
  buildAllAccountsGroup,
  buildSidebarGroups,
  groupOrderForAccounts,
  isBucketGroupId,
  isProviderGroupId,
  providerGroupId,
  providerIdFromGroup,
  reconciledSidebarGroupOrder,
} from "./sidebar-groups";
import type { Account, AccountBucket, Provider } from "../../types";

function account(id: string, provider: Provider, label = id): Account {
  return {
    id,
    label,
    provider,
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUsage: null,
    lastError: null,
    authRequired: false,
  };
}

function bucket(id: string, name: string, accountIds: string[], provider: Provider | null = null): AccountBucket {
  return { id, name, provider, accountIds, createdAt: "", updatedAt: "" };
}

const PROVIDERS: Provider[] = ["openai", "anthropic", "grok"];

describe("buildSidebarGroups", () => {
  it("creates one group per provider in account order", () => {
    const groups = buildSidebarGroups(
      [account("a", "anthropic"), account("b", "openai"), account("c", "anthropic")],
      [],
      PROVIDERS,
      [],
    );
    expect(groups.map((group) => group.id)).toEqual(["provider:anthropic", "provider:openai"]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("puts custom groups first and removes their accounts from provider groups", () => {
    const groups = buildSidebarGroups(
      [account("a", "openai"), account("b", "openai"), account("c", "grok")],
      [bucket("t", "Team", ["a"])],
      PROVIDERS,
      [],
    );
    expect(groups.map((group) => group.id)).toEqual(["bucket:t", "provider:openai", "provider:grok"]);
    expect(groups[0]).toMatchObject({ type: "bucket", title: "Team", provider: "openai" });
    expect(groups[1].accounts.map((a) => a.id)).toEqual(["b"]);
  });

  it("skips provider groups whose accounts all live in custom groups", () => {
    const groups = buildSidebarGroups([account("a", "openai")], [bucket("t", "Team", ["a"])], PROVIDERS, []);
    expect(groups.map((group) => group.id)).toEqual(["bucket:t"]);
  });

  it("ignores bucket members that no longer exist", () => {
    const [group] = buildSidebarGroups([account("a", "openai")], [bucket("t", "Team", ["a", "gone"])], PROVIDERS, []);
    expect(group.accounts.map((a) => a.id)).toEqual(["a"]);
  });

  it("applies the saved order, keeping unsaved groups after saved ones", () => {
    const accounts = [account("a", "openai"), account("b", "anthropic"), account("c", "grok")];
    const groups = buildSidebarGroups(accounts, [], PROVIDERS, ["provider:grok", "provider:openai"]);
    expect(groups.map((group) => group.id)).toEqual(["provider:grok", "provider:openai", "provider:anthropic"]);
  });

  it("titles a provider group after a shared custom label, else the provider name", () => {
    const [shared] = buildSidebarGroups([account("a", "openai", "Codex/GPT")], [], PROVIDERS, []);
    expect(shared.title).toBe("ChatGPT");
    const [mixed] = buildSidebarGroups(
      [account("a", "openai", "Work"), account("b", "openai", "Home")],
      [],
      PROVIDERS,
      [],
    );
    expect(mixed.title).toBe("ChatGPT");
    const [same] = buildSidebarGroups(
      [account("a", "openai", "Work"), account("b", "openai", "Work")],
      [],
      PROVIDERS,
      [],
    );
    expect(same.title).toBe("Work");
  });
});

describe("buildAllAccountsGroup", () => {
  it("wraps every account", () => {
    const accounts = [account("a", "openai")];
    expect(buildAllAccountsGroup(accounts)).toEqual({
      id: ALL_ACCOUNTS_GROUP_ID,
      type: "all",
      title: "All Accounts",
      provider: null,
      accounts,
    });
  });
});

describe("groupOrderForAccounts", () => {
  const groups = [
    { id: "bucket:work", accounts: [account("w", "openai")] },
    { id: "provider:openai", accounts: [account("o1", "openai"), account("o2", "openai")] },
    { id: "provider:grok", accounts: [account("g", "grok")] },
  ];

  it("orders groups by where their first account now sits", () => {
    expect(groupOrderForAccounts(["g", "o2", "w", "o1"], groups)).toEqual([
      "provider:grok",
      "provider:openai",
      "bucket:work",
    ]);
  });

  it("keeps the order when no group's first account moved past another group", () => {
    expect(groupOrderForAccounts(["w", "o2", "o1", "g"], groups)).toEqual([
      "bucket:work",
      "provider:openai",
      "provider:grok",
    ]);
  });

  it("leaves an empty custom group in its slot", () => {
    const withEmpty = [groups[0], { id: "bucket:empty", accounts: [] }, groups[1], groups[2]];
    expect(groupOrderForAccounts(["g", "o1", "o2", "w"], withEmpty)).toEqual([
      "provider:grok",
      "bucket:empty",
      "provider:openai",
      "bucket:work",
    ]);
  });
});

describe("reconciledSidebarGroupOrder", () => {
  // Backend order after removing the Grok account and re-adding it: the
  // re-added account is newest, so the backend sorts it last.
  const backendAccounts = [account("a1", "openai"), account("o2", "openai"), account("g2", "grok")];
  const backendIds = ["a1", "o2", "g2"];
  const flatten = (groups: { accounts: { id: string }[] }[]) =>
    groups.flatMap((group) => group.accounts.map((a) => a.id));

  it("re-derives the group order when a stale saved order disagrees after remove and re-add", () => {
    // The saved order still has Grok first from before the removal.
    const saved = ["provider:grok", "provider:openai"];
    const groups = buildSidebarGroups(backendAccounts, [], PROVIDERS, saved);
    expect(groups.map((group) => group.id)).toEqual(["provider:grok", "provider:openai"]);
    expect(flatten(groups)).not.toEqual(backendIds);

    const next = reconciledSidebarGroupOrder(backendIds, groups, saved);
    expect(next).toEqual(["provider:openai", "provider:grok"]);

    // The corrected sidebar lists accounts in All-page order.
    const fixed = buildSidebarGroups(backendAccounts, [], PROVIDERS, next!);
    expect(flatten(fixed)).toEqual(backendIds);
  });

  it("returns null when the sidebar already matches the backend order", () => {
    const saved = ["provider:openai", "provider:grok"];
    const groups = buildSidebarGroups(backendAccounts, [], PROVIDERS, saved);
    expect(flatten(groups)).toEqual(backendIds);
    expect(reconciledSidebarGroupOrder(backendIds, groups, saved)).toBeNull();
  });

  it("drops a saved group whose accounts are all gone", () => {
    const remaining = [account("a1", "openai"), account("o2", "openai")];
    const saved = ["provider:grok", "provider:openai"];
    const groups = buildSidebarGroups(remaining, [], PROVIDERS, saved);
    expect(groups.map((group) => group.id)).toEqual(["provider:openai"]);
    expect(reconciledSidebarGroupOrder(["a1", "o2"], groups, saved)).toEqual(["provider:openai"]);
  });

  it("places a brand-new group where its first account sits", () => {
    const saved = ["provider:openai"];
    const groups = buildSidebarGroups(backendAccounts, [], PROVIDERS, saved);
    expect(groups.map((group) => group.id)).toEqual(["provider:openai", "provider:grok"]);
    // Unsaved groups already trail saved ones; the backend order agrees here.
    expect(reconciledSidebarGroupOrder(backendIds, groups, saved)).toBeNull();
  });
});

describe("group id helpers", () => {
  it("build and read the ids the sidebar and the pairing payload use", () => {
    expect(bucketGroupId("b1")).toBe("bucket:b1");
    expect(providerGroupId("openai")).toBe("provider:openai");
    expect(bucketIdFromGroup("bucket:b1")).toBe("b1");
    expect(providerIdFromGroup("provider:openai")).toBe("openai");
  });

  it("read nothing from another kind of group", () => {
    expect(bucketIdFromGroup("provider:openai")).toBeNull();
    expect(bucketIdFromGroup("all")).toBeNull();
    expect(providerIdFromGroup("bucket:b1")).toBeNull();
    expect(providerIdFromGroup("all")).toBeNull();
  });

  it("round-trip, including ids that contain a colon", () => {
    expect(bucketIdFromGroup(bucketGroupId("a:b"))).toBe("a:b");
    expect(isBucketGroupId(bucketGroupId("x"))).toBe(true);
    expect(isProviderGroupId(bucketGroupId("x"))).toBe(false);
  });
});
