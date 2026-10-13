import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_PROTECTION_ACCOUNT_NOTE,
  credentialProtectionAction,
  credentialProtectionMessage,
  unprotectedPromptKey,
} from "./credential-protection";

describe("credential protection on an account", () => {
  it("says the account is paused and what to do", () => {
    expect(CREDENTIAL_PROTECTION_ACCOUNT_NOTE).toContain("isn't encrypted");
    expect(CREDENTIAL_PROTECTION_ACCOUNT_NOTE).toContain("paused");
    expect(CREDENTIAL_PROTECTION_ACCOUNT_NOTE).toContain("sign in again");
    expect(CREDENTIAL_PROTECTION_ACCOUNT_NOTE).not.toContain("still works");
  });
});

describe("credentialProtectionMessage", () => {
  it("is silent when nothing is unprotected or the value is unusable", () => {
    expect(credentialProtectionMessage(0)).toBeNull();
    expect(credentialProtectionMessage(-1)).toBeNull();
    expect(credentialProtectionMessage(Number.NaN)).toBeNull();
  });

  it("names the count, says the app isn't using them, and what to do", () => {
    expect(credentialProtectionMessage(1)).toContain("1 saved sign-in isn't encrypted, so the app isn't using it.");
    expect(credentialProtectionMessage(3)).toContain("3 saved sign-ins aren't encrypted, so the app isn't using them.");
    expect(credentialProtectionMessage(2)).toContain("Retry, or remove the account and sign in again.");
  });
});

describe("credentialProtectionAction", () => {
  it("reports once per change so a dismissed banner stays dismissed", () => {
    expect(credentialProtectionAction(0, 2)).toBe("report");
    expect(credentialProtectionAction(2, 2)).toBe("none");
    expect(credentialProtectionAction(2, 1)).toBe("report");
  });

  it("clears when everything is protected again", () => {
    expect(credentialProtectionAction(2, 0)).toBe("clear");
    expect(credentialProtectionAction(0, 0)).toBe("none");
  });
});

describe("unprotectedPromptKey", () => {
  it("is null when no account is affected", () => {
    expect(unprotectedPromptKey(undefined)).toBeNull();
    expect(unprotectedPromptKey([])).toBeNull();
  });

  it("is the same for the same accounts in any order, and changes with the set", () => {
    expect(unprotectedPromptKey(["b", "a"])).toBe(unprotectedPromptKey(["a", "b"]));
    expect(unprotectedPromptKey(["a"])).not.toBe(unprotectedPromptKey(["a", "b"]));
  });
});
