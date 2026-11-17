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

  // The backend's link-code sentences (pairing/transport.rs, pairing/discovery.rs) tell the user
  // what to do, so they must reach the screen as written.
  it.each([
    "That link code didn't match the other device. Check the code and try again.",
    "The wrong link code was entered too many times. Start again to get a new code.",
    "The other device has an older version of AI Usage Tracker that can't pair with this one. Update the app on both devices and try again.",
    "The other device declined the transfer.",
    "The two devices disagree about which one sends. Start the transfer again.",
  ])("shows the link-code sentence %s as written", (sentence) => {
    expect(pairingFailedMessage(sentence)).toBe(sentence);
  });
});
