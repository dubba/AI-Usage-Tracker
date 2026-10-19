import { describe, expect, it } from "vitest";
import type { Account, Provider } from "../../types";
import { isGoogleCloudMonitored, isGoogleKeyOnly, isGoogleSetupPending, USAGE_SOURCES } from "./usage-sources";

function account(provider: Provider, source: string | null): Account {
  return {
    id: "a",
    label: "A",
    provider,
    lastUsage: source === null ? null : { source, windows: [] },
  } as unknown as Account;
}

describe("usage source helpers", () => {
  it("recognizes each Google AI Studio state by its source", () => {
    expect(isGoogleKeyOnly(account("google_ai_studio", USAGE_SOURCES.googleModelAccess))).toBe(true);
    expect(isGoogleSetupPending(account("google_ai_studio", USAGE_SOURCES.googleMonitoringWaiting))).toBe(true);
    expect(isGoogleCloudMonitored(account("google_ai_studio", USAGE_SOURCES.googleCloudMonitoring))).toBe(true);
  });

  it("keeps the three states apart", () => {
    const keyOnly = account("google_ai_studio", USAGE_SOURCES.googleModelAccess);
    expect(isGoogleSetupPending(keyOnly)).toBe(false);
    expect(isGoogleCloudMonitored(keyOnly)).toBe(false);
    const waiting = account("google_ai_studio", USAGE_SOURCES.googleMonitoringWaiting);
    expect(isGoogleKeyOnly(waiting)).toBe(false);
  });

  it("never applies to another provider or to an account without usage", () => {
    expect(isGoogleKeyOnly(account("openai", USAGE_SOURCES.googleModelAccess))).toBe(false);
    expect(isGoogleSetupPending(account("grok", USAGE_SOURCES.googleMonitoringWaiting))).toBe(false);
    expect(isGoogleKeyOnly(account("google_ai_studio", null))).toBe(false);
    expect(isGoogleKeyOnly(account("google_ai_studio", "something_else"))).toBe(false);
  });
});
