import { describe, expect, it } from "vitest";
import { pairingFailedMessage } from "./pairing-errors";

describe("pairingFailedMessage", () => {
  it("translates internal protocol assertions", () => {
    expect(pairingFailedMessage("Expected MSG_SAS_CONFIRM from peer")).toBe(
      "The link to the other device broke. Keep both devices on this screen and connected to the same Wi-Fi, then try again.",
    );
    expect(pairingFailedMessage("Expected MSG_ACK")).toContain("The link to the other device broke.");
    expect(pairingFailedMessage("Expected MSG_ENCRYPTED_PAYLOAD")).toContain(
      "The link to the other device broke.",
    );
  });

  it("translates connection-level failures instead of blaming the internet", () => {
    expect(pairingFailedMessage("connection reset by peer")).toContain(
      "Keep both devices on this screen",
    );
  });

  it("leaves backend sentences written for people alone", () => {
    expect(pairingFailedMessage("The transfer was cancelled.")).toBe("The transfer was cancelled.");
  });
});
