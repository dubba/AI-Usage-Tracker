import type { Account } from "../types";

/**
 * A complete account with nothing loaded yet (no usage, no error, signed in): pass only the fields
 * a test is about. Typed against the generated `Account`, so a new backend field shows up here.
 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "a",
    label: "Work",
    provider: "openai",
    email: null,
    providerAccountId: null,
    chatgptAccountId: null,
    plan: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUsage: null,
    lastError: null,
    authRequired: false,
    health: "inactive",
    googleSetup: null,
    autoRefresh: true,
    headline: { fiveHour: [], long: [], longWindow: null },
    planDisplay: null,
    ...overrides,
  };
}
