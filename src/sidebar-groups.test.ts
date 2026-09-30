import { describe, expect, it } from "vitest";
import { ALL_ACCOUNTS_GROUP_ID, buildAllAccountsGroup, buildSidebarGroups } from "./sidebar-groups";
import type { Account, AccountBucket, Provider } from "./types";

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
      title: "All",
      provider: null,
      accounts,
    });
  });
});
