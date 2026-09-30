import { describe, expect, it } from "vitest";
import { credentialProtectionAction, credentialProtectionMessage } from "./credential-protection";

describe("credentialProtectionMessage", () => {
  it("is silent when nothing is unprotected or the value is unusable", () => {
    expect(credentialProtectionMessage(0)).toBeNull();
    expect(credentialProtectionMessage(-1)).toBeNull();
    expect(credentialProtectionMessage(Number.NaN)).toBeNull();
  });

  it("names the count and says the app keeps trying", () => {
    expect(credentialProtectionMessage(1)).toContain("1 saved sign-in isn't encrypted yet");
    expect(credentialProtectionMessage(3)).toContain("3 saved sign-ins aren't encrypted yet");
    expect(credentialProtectionMessage(2)).toContain("keeps trying");
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
