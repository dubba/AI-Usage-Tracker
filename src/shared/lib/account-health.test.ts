import { describe, expect, it } from "vitest";
import type { Account, AccountHealth, GoogleSetup } from "../../types";
import { accountNeedsAttention, accountSignedOut, accountStatus, groupAlert } from "./usage-logic";
import fixture from "./account-health.fixture.json";

type Case = (typeof fixture.cases)[number];

/** The account as the backend sends it: the stored fields plus the health and setup it worked out. */
function toAccount(entry: Case): Account {
  const lastUsage = entry.usage === null ? null : { ...fixture.baseUsage, ...entry.usage };
  return {
    ...fixture.baseAccount,
    ...entry.account,
    lastUsage,
    health: entry.health as AccountHealth,
    googleSetup: entry.googleSetup as GoogleSetup | null,
    autoRefresh: true,
  } as Account;
}

/**
 * The backend works out each account's health (`AccountHealth::of`, checked against the same
 * fixture in `src-tauri/crates/usage-core/src/health/tests.rs`); the frontend only shows it.
 */
describe("account health (the fixture shared with src-tauri/crates/usage-core/src/health)", () => {
  it.each(fixture.cases)("$name", (entry) => {
    const account = toAccount(entry);
    expect(accountStatus(account)).toEqual({ label: entry.chip, className: entry.tone });
    expect(accountNeedsAttention(account)).toBe(entry.health !== "live");
    expect(accountSignedOut(account)).toBe(entry.health === "signed_out");
    expect(groupAlert([account])?.level ?? null).toBe(entry.alert);
  });
});
