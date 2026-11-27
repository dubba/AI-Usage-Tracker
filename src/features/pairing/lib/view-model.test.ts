import { describe, expect, it } from "vitest";
import type { PairingStatus } from "../../../types";
import {
  buildCodeSlots,
  cleanCode,
  codeLength,
  confirmFields,
  diffSingleInputEdit,
  formatCodeSlots,
  formatCountdown,
  formatJoinCode,
  formattedOffsetForSlot,
  isCompleteCode,
  isLinkCode,
  hasOwnActionButtons,
  hostWaitingFields,
  isWaitingStatus,
  lastFilledSlotIndex,
  normalizeSlotChar,
  pairingHeader,
  pairingStep,
  slotsHaveHoles,
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
    ["showing a link code", { viewMode: "host" }, "Your Link Code"],
    ["scanning", { viewMode: "scanner" }, "Scan QR Code"],
    ["entering a code", { viewMode: "code" }, "Enter Link Code"],
    ["showing animated QR", { viewMode: "airgap-sender" }, "Show QR Code"],
    ["connecting as client", { status: "clientConnecting" }, "Connecting"],
    ["peer connected", { status: "peerConnected" }, "Connected"],
    ["asking for a role", { status: "roleSelection" }, "Send or Receive Accounts"],
    ["applying a chosen role", { status: "roleSelection", intendedRole: "send" }, "Connecting"],
    ["sending once connected", { status: "confirmTransfer", isSender: true }, "Sending"],
    ["receiving once connected", { status: "confirmTransfer", isSender: false }, "Add the accounts"],
    ["transferring", { status: "transferring" }, "Transferring"],
    ["done", { status: "completed" }, "Devices Linked"],
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

  it("says the sender is waiting for confirmation and asks the receiver to confirm, with no code to compare", () => {
    const sender = header({ status: "confirmTransfer", isSender: true }).subtitle;
    const receiver = header({ status: "confirmTransfer", isSender: false }).subtitle;
    expect(sender).toContain("Waiting for the other device to confirm");
    expect(receiver).toContain("Confirm adding the accounts");
    // No flow compares a code any more.
    const airgap = header({ viewMode: "scanner", airgapVerifyPrompt: true }).subtitle;
    for (const subtitle of [sender, receiver, airgap]) expect(subtitle).not.toContain("same code");
  });

  it("is on step 3 while the air-gap receiver asks to add the accounts, whatever the status", () => {
    expect(header({ viewMode: "scanner", airgapVerifyPrompt: true }).step).toBe(3);
    expect(header().step).toBe(1);
    expect(header({ viewMode: "host" }).step).toBe(2);
  });

  it("is on step 3 once the file has arrived", () => {
    expect(header({ viewMode: "file-receive" }).step).toBe(3);
    expect(header({ viewMode: "file-send" }).step).toBe(2);
  });

  it("moves the file sender to step 3 once the share menu has taken the file", () => {
    expect(header({ viewMode: "file-send", fileHandedOff: true }).step).toBe(3);
    expect(header({ viewMode: "code", fileHandedOff: true }).step).toBe(2);
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
  it("groups a link code in threes, capitalized, keeping only the letters a code has", () => {
    expect(formatJoinCode("KTQMPRXDHWAB")).toBe("KTQ MPR XDH WAB");
    expect(formatJoinCode("ktq-mpr xdh-wab")).toBe("KTQ MPR XDH WAB");
    expect(formatJoinCode("KTQ")).toBe("KTQ");
    expect(formatJoinCode("KTQMPRXDHWABZZ")).toBe("KTQ MPR XDH WAB");
  });

  it("groups an older version's code in threes and ignores non-digits", () => {
    expect(formatJoinCode("123456")).toBe("123 456");
    expect(formatJoinCode("12")).toBe("12");
    expect(formatJoinCode("123")).toBe("123");
    expect(formatJoinCode("1a2b3c4d5e6f7")).toBe("123 456");
    expect(formatJoinCode("")).toBe("");
  });

  it("tells a link code from an older version's six digits by its first character", () => {
    expect(cleanCode(" kt-1qmILOp ")).toBe("KTQMP");
    expect(cleanCode("1a2 3")).toBe("123");
    // Without older versions' codes, a digit is dropped like any other character.
    expect(cleanCode("1a2 3", false)).toBe("A");
    expect(cleanCode("3kt9q", false)).toBe("KTQ");
    expect(codeLength("")).toBe(12);
    expect(codeLength("K")).toBe(12);
    expect(codeLength("4")).toBe(6);
    expect(isCompleteCode("KTQMPRXDHWAB")).toBe(true);
    expect(isCompleteCode("KTQMPRXDHWA")).toBe(false);
    expect(isCompleteCode("123456")).toBe(true);
    expect(isLinkCode("KTQMPRXDHWAB")).toBe(true);
    expect(isLinkCode("123456")).toBe(false);
    expect(isLinkCode("KTQMP")).toBe(false);
  });

  it("formats a countdown as minutes and zero-padded seconds", () => {
    expect(formatCountdown(125)).toBe("2:05");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(600)).toBe("10:00");
  });
});

describe("slot editing helpers", () => {
  it("builds slots, formats holes with underscores, and computes caret offsets", () => {
    const slots = buildCodeSlots("KTQMPR");
    expect(slots).toHaveLength(12);
    expect(lastFilledSlotIndex(slots)).toBe(5);
    expect(slotsHaveHoles(slots)).toBe(false);
    expect(formatCodeSlots(slots)).toBe("KTQ MPR");
    expect(formattedOffsetForSlot(slots, 3)).toBe(5);
    expect(formattedOffsetForSlot(slots, 6)).toBe(7);

    slots[3] = "";
    expect(slotsHaveHoles(slots)).toBe(true);
    expect(formatCodeSlots(slots)).toBe("KTQ _PR");
    expect(formattedOffsetForSlot(slots, 3)).toBe(5);
  });

  it("normalizes single slot characters without letting digits wipe an existing letter code", () => {
    const letters = buildCodeSlots("KTQMPR");
    expect(normalizeSlotChar("n", letters, 3, true)).toBe("N");
    expect(normalizeSlotChar("i", letters, 3, true)).toBeNull();
    expect(normalizeSlotChar("l", letters, 3, true)).toBeNull();
    expect(normalizeSlotChar("o", letters, 3, true)).toBeNull();
    expect(normalizeSlotChar("1", letters, 0, true)).toBeNull();

    const digits = buildCodeSlots("123456");
    expect(normalizeSlotChar("9", digits, 2, true)).toBe("9");
    expect(normalizeSlotChar("k", digits, 0, true)).toBeNull();

    const empty = buildCodeSlots("");
    expect(normalizeSlotChar("4", empty, 0, true)).toBe("4");
    expect(normalizeSlotChar("4", empty, 0, false)).toBeNull();
  });

  it("detects single-character insertions, deletions, and replacements", () => {
    expect(diffSingleInputEdit("KTQ MPR", "KTQ MnPR")).toEqual({ kind: "insert", char: "n", index: 5 });
    expect(diffSingleInputEdit("KTQ MPR", "KTQ PR")).toEqual({ kind: "delete", index: 4 });
    expect(diffSingleInputEdit("KTQ MPR", "KTQ NPR")).toEqual({ kind: "replace", char: "N", index: 4 });
    expect(diffSingleInputEdit("KTQ MPR", "KTQ MPR XDH WAB")).toBeNull();
  });
});
