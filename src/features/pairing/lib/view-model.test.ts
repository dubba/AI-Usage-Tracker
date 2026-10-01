import { describe, expect, it } from "vitest";
import type { PairingStatus } from "../../../types";
import {
  formatCountdown,
  formatJoinCode,
  hasOwnActionButtons,
  hostWaitingFields,
  isWaitingStatus,
  pairingHeader,
  pairingStep,
  sasFields,
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

  it("is step 3 once the code is being confirmed or later", () => {
    for (const status of ["sasVerification", "transferring", "completed"] as const) {
      expect(pairingStep(status, "select-role")).toBe(3);
    }
  });
});

describe("pairingHeader titles", () => {
  const cases: Array<[string, Partial<Parameters<typeof pairingHeader>[0]>, string]> = [
    ["role choice", {}, "Send or receive accounts"],
    ["connection choice", { viewMode: "select-mode" }, "How to connect devices"],
    ["showing a link code", { viewMode: "host" }, "Show Link code"],
    ["scanning", { viewMode: "scanner" }, "Scan QR code"],
    ["entering a code", { viewMode: "code" }, "Enter Link code"],
    ["showing animated QR", { viewMode: "airgap-sender" }, "Show QR code"],
    ["connecting as client", { status: "clientConnecting" }, "Connecting"],
    ["connecting as sender", { status: "senderConnecting" }, "Connecting"],
    ["peer connected", { status: "peerConnected" }, "Connected"],
    ["asking for a role", { status: "roleSelection" }, "Send or receive accounts"],
    ["applying a chosen role", { status: "roleSelection", intendedRole: "send" }, "Connecting"],
    ["confirming", { status: "sasVerification" }, "Confirm the connection"],
    ["transferring", { status: "transferring" }, "Transferring"],
    ["done", { status: "completed" }, "Devices linked"],
    ["failed", { status: "failed" }, "Link Devices"],
    ["air-gap receiver comparing codes", { viewMode: "scanner", airgapVerifyPrompt: true }, "Confirm the connection"],
    ["air-gap sender comparing codes", { viewMode: "airgap-confirm" }, "Confirm the connection"],
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
    expect(header({ viewMode: "airgap-sender" }).subtitle).toContain("scan this QR code below");
  });

  it("uses the same confirm text for Wi-Fi and air-gap confirmation", () => {
    expect(header({ status: "sasVerification" }).subtitle).toBe(header({ viewMode: "airgap-confirm" }).subtitle);
  });

  it("is on step 3 while air-gap codes are compared, whatever the status", () => {
    expect(header({ viewMode: "airgap-confirm" }).step).toBe(3);
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
    for (const mode of ["scanner", "code", "airgap-sender", "airgap-confirm"] as ViewMode[]) {
      expect(hasOwnActionButtons("idle", mode)).toBe(true);
    }
  });

  it("lets confirmation and completion draw their own, but not other states", () => {
    expect(hasOwnActionButtons("sasVerification", "select-role")).toBe(true);
    expect(hasOwnActionButtons("completed", "select-role")).toBe(true);
    expect(hasOwnActionButtons("failed", "select-role")).toBe(false);
    expect(hasOwnActionButtons("transferring", "select-role")).toBe(false);
  });
});

describe("waiting-state fields", () => {
  const waiting = (data: object) => ({ status: "hostWaiting", data }) as unknown as PairingStatus;

  it("reads the host's code from camelCase or snake_case keys", () => {
    expect(hostWaitingFields(waiting({ qrSvg: "<svg/>", qrUri: "u", fingerprint: "f", joinCode: "123456" }))).toEqual({
      qrSvg: "<svg/>",
      qrUri: "u",
      fingerprint: "f",
      joinCode: "123456",
    });
    expect(hostWaitingFields(waiting({ qr_svg: "<svg/>", qr_uri: "u", join_code: "654321" }))).toMatchObject({
      qrSvg: "<svg/>",
      qrUri: "u",
      joinCode: "654321",
    });
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

  it("recognises the states that count as waiting", () => {
    expect(["idle", "hostWaiting", "receiverWaiting"].every((s) => isWaitingStatus(s as PairingStatus["status"]))).toBe(true);
    expect(isWaitingStatus("completed")).toBe(false);
  });
});

describe("sasFields", () => {
  const sas = (data: object) => ({ status: "sasVerification", data }) as unknown as PairingStatus;

  it("reads camelCase fields", () => {
    expect(sasFields(sas({ sasCode: "1 2", sessionId: "s", role: "sender", accountCount: 4 }))).toEqual({
      sasCode: "1 2",
      sessionId: "s",
      role: "sender",
      accountCount: 4,
      isSender: true,
    });
  });

  it("falls back to snake_case fields", () => {
    expect(sasFields(sas({ sas_code: "3 4", session_id: "t", role: "receiver", account_count: 0 }))).toEqual({
      sasCode: "3 4",
      sessionId: "t",
      role: "receiver",
      accountCount: 0,
      isSender: false,
    });
  });

  it("is null for other states", () => {
    expect(sasFields({ status: "idle" })).toBeNull();
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
