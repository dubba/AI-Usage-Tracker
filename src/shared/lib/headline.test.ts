import { describe, expect, it } from "vitest";
import type { Account, Headline, Provider } from "../../types";
import { accountWindowRemaining, groupSecondMeterLabel } from "./usage-logic";
import fixture from "./headline.fixture.json";

type Entry = (typeof fixture.accounts)[number];
const NOW = Date.parse(fixture.now);

/** The account as the backend sends it, with the headline candidates it worked out. */
function toAccount(entry: Entry): Account {
  const windows = entry.windows?.map((window) => ({ usedPercent: null, ...window }));
  return {
    id: entry.name,
    label: entry.name,
    provider: entry.provider as Provider,
    plan: entry.plan,
    lastUsage: windows ? { windows, freshness: "live" } : null,
    headline: entry.headline as Headline,
  } as unknown as Account;
}
const byName = new Map(fixture.accounts.map((entry) => [entry.name, toAccount(entry)]));

/**
 * The backend picks the candidate windows (`Headline::of`, checked against the same fixture in
 * `src-tauri/crates/usage-core/src/headline/tests.rs`); the frontend skips the ones that have reset.
 */
describe("sidebar headline (the fixture shared with src-tauri/crates/usage-core/src/headline)", () => {
  it.each(fixture.accounts)("$name", (entry) => {
    const account = toAccount(entry);
    expect(accountWindowRemaining(account, "five_hour", NOW)).toBe(entry.fiveHour);
    expect(accountWindowRemaining(account, "weekly", NOW)).toBe(entry.long);
  });

  it.each(fixture.groups)("group: $name", (group) => {
    expect(groupSecondMeterLabel(group.accounts.map((name) => byName.get(name)!))).toBe(group.label);
  });
});
