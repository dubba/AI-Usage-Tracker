import { describe, expect, it } from "vitest";
import type { PairingStatus } from "../../../types";
import {
  confirmFields,
  formatCountdown,
  formatJoinCode,
  hasOwnActionButtons,
  hostWaitingFields,
  isWaitingStatus,
  pairingHeader,
  pairingStep,
  waitingExpiresAt,
  type ViewMode,
} from "./view-model";

const header = (over: Partial<Parameters<typeof pairingHeader>[0]> = {}) =>
  pairingHeader({
    status: "idle",
    viewMode: "select-role",
    activeFlow: null,
    intendedRole: null,
    airgapVerifyPrompt: false,
    ...over,
  });

describe("pairingStep", () => {
  it("is step 1 only while choosing a role", () => {
    expect(pairingStep("idle", "select-role")).toBe(1);
    expect(pairingStep("hostWaiting", "select-role")).toBe(1);
    expect(pairingStep("idle", "select-mode")).toBe(2);
    expect(pairingStep("idle", "host")).toBe(2);
    expect(pairingStep("roleSelection", "select-role")).toBe(2);
  });

  it("is step 3 once the transfer is being confirmed or later", () => {
    for (const status of ["confirmTransfer", "transferring", "completed"] as const) {
      expect(pairingStep(status, "select-role")).toBe(3);
    }
  });
});

describe("pairingHeader titles", () => {
  const cases: Array<[string, Partial<Parameters<typeof pairingHeader>[0]>, string]> = [
    ["role choice", {}, "Send or Receive Accounts"],
    ["other ways to connect", { viewMode: "select-mode" }, "Other Ways to Connect"],
    ["showing a link code", { viewMode: "host" }, "Link Code"],
    ["scanning", { viewMode: "scanner" }, "Scan QR Code"],
    ["entering a code", { viewMode: "code" }, "Enter Link Code"],
    ["showing animated QR", { viewMode: "airgap-sender" }, "Show QR Code"],
    ["connecting as client", { status: "clientConnecting" }, "Connecting"],
    ["peer connected", { status: "peerConnected" }, "Connected"],
    ["asking for a role", { status: "roleSelection" }, "Send or Receive Accounts"],
    ["applying a chosen role", { status: "roleSelection", intendedRole: "send" }, "Connecting"],
    ["confirming as the sender", { status: "confirmTransfer", isSender: true }, "Confirm the transfer"],
    ["waiting as the receiver", { status: "confirmTransfer", isSender: false }, "Devices connected"],
    ["transferring", { status: "transferring" }, "Transferring"],
    ["done", { status: "completed" }, "Devices linked"],
    ["failed", { status: "failed" }, "Pairing Failed"],
    ["air-gap receiver with every frame", { viewMode: "scanner", airgapVerifyPrompt: true }, "Add the accounts"],
  ];
  it.each(cases)("%s", (_name, over, title) => {
    expect(header(over).title).toBe(title);
  });
});

describe("pairingHeader subtitles and steps", () => {
  it("describes scanning differently for the air-gap flow", () => {
    expect(header({ viewMode: "scanner" }).subtitle).toBe("Point the camera at the QR code on the other device.");
    expect(header({ viewMode: "scanner", activeFlow: "airgap" }).subtitle).toBe(
      "Point the camera at the animated QR code on the other device.",
    );
  });

  it("keeps the air-gap instructions while its sender is shown", () => {
    expect(header({ viewMode: "airgap-sender" }).subtitle).toContain("Scan QR Code (under Other Ways to Connect)");
  });

  it("tells the sender to send and the receiver to wait, with no code to compare", () => {
    const sender = header({ status: "confirmTransfer", isSender: true }).subtitle;
    const receiver = header({ status: "confirmTransfer", isSender: false }).subtitle;
    expect(sender).toContain("send it");
    expect(receiver).toContain("Waiting for the other device");
    // No flow compares a code any more.
    const airgap = header({ viewMode: "scanner", airgapVerifyPrompt: true }).subtitle;
    for (const subtitle of [sender, receiver, airgap]) expect(subtitle).not.toContain("same code");
  });

  it("is on step 3 while the air-gap receiver asks to add the accounts, whatever the status", () => {
    expect(header({ viewMode: "scanner", airgapVerifyPrompt: true }).step).toBe(3);
    expect(header().step).toBe(1);
    expect(header({ viewMode: "host" }).step).toBe(2);
  });

  it("hides the step dots only when failed", () => {
    expect(header({ status: "failed" }).showStepDots).toBe(false);
    expect(header({ status: "transferring" }).showStepDots).toBe(true);
  });
});

describe("hasOwnActionButtons", () => {
  it("leaves the footer to the choice and host views", () => {
    for (const mode of ["host", "select-mode", "select-role"] as ViewMode[]) {
      expect(hasOwnActionButtons("idle", mode)).toBe(false);
    }
  });

  it("lets scanner, code entry and air-gap views draw their own buttons", () => {
    for (const mode of ["scanner", "code", "airgap-sender"] as ViewMode[]) {
      expect(hasOwnActionButtons("idle", mode)).toBe(true);
    }
  });

  it("lets confirmation and completion draw their own, but not other states", () => {
    expect(hasOwnActionButtons("confirmTransfer", "select-role")).toBe(true);
    expect(hasOwnActionButtons("completed", "select-role")).toBe(true);
    expect(hasOwnActionButtons("failed", "select-role")).toBe(false);
    expect(hasOwnActionButtons("transferring", "select-role")).toBe(false);
  });
});

describe("waiting-state fields", () => {
  const waiting = (data: object) => ({ status: "hostWaiting", data }) as unknown as PairingStatus;

  it("reads the host's code from camelCase or snake_case keys", () => {
    expect(hostWaitingFields(waiting({ joinCode: "123456" }))).toEqual({ joinCode: "123456" });
    expect(hostWaitingFields(waiting({ join_code: "654321" }))).toEqual({ joinCode: "654321" });
  });

  it("treats missing or non-string values as empty, and other states as not hosting", () => {
    expect(hostWaitingFields(waiting({ joinCode: 5 }))?.joinCode).toBe("");
    expect(hostWaitingFields({ status: "idle" })).toBeNull();
  });

  it("reads the expiry in either key style", () => {
    expect(waitingExpiresAt(waiting({ expiresAt: 100 }))).toBe(100);
    expect(waitingExpiresAt(waiting({ expires_at: 200 }))).toBe(200);
    expect(waitingExpiresAt(waiting({}))).toBeNull();
    expect(waitingExpiresAt({ status: "idle" })).toBeNull();
  });

  it("recognizes the states that count as waiting", () => {
    expect(["idle", "hostWaiting"].every((s) => isWaitingStatus(s as PairingStatus["status"]))).toBe(true);
    expect(isWaitingStatus("completed")).toBe(false);
  });
});

describe("confirmFields", () => {
  const confirming = (data: object) => ({ status: "confirmTransfer", data }) as unknown as PairingStatus;

  it("reads camelCase fields", () => {
    expect(confirmFields(confirming({ sessionId: "s", role: "sender", accountCount: 4 }))).toEqual({
      sessionId: "s",
      role: "sender",
      accountCount: 4,
      isSender: true,
    });
  });

  it("falls back to snake_case fields", () => {
    expect(confirmFields(confirming({ session_id: "t", role: "receiver", account_count: 0 }))).toEqual({
      sessionId: "t",
      role: "receiver",
      accountCount: 0,
      isSender: false,
    });
  });

  it("is null for other states", () => {
    expect(confirmFields({ status: "idle" })).toBeNull();
  });
});

describe("formatting", () => {
  it("groups a link code in threes and ignores non-digits", () => {
    expect(formatJoinCode("123456")).toBe("123 456");
    expect(formatJoinCode("12")).toBe("12");
    expect(formatJoinCode("123")).toBe("123");
    expect(formatJoinCode("1a2b3c4d5e6f7")).toBe("123 456");
    expect(formatJoinCode("")).toBe("");
  });

  it("formats a countdown as minutes and zero-padded seconds", () => {
    expect(formatCountdown(125)).toBe("2:05");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(600)).toBe("10:00");
  });
});
