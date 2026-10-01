import { describe, expect, it } from "vitest";
import { modalReducer, type ModalState } from "./modal-state";
import type { Account, AccountBucket } from "./types";

const account = { id: "a1" } as Account;
const bucket = { id: "b1" } as AccountBucket;

describe("modalReducer", () => {
  it("opens a dialog with its details", () => {
    expect(modalReducer(null, { type: "open", modal: { kind: "add", label: "Work", provider: "openai" } })).toEqual({
      kind: "add",
      label: "Work",
      provider: "openai",
    });
  });

  it("replaces the open dialog instead of stacking another", () => {
    const first: ModalState = { kind: "alert", account };
    const next = modalReducer(first, { type: "open", modal: { kind: "remove", account } });
    expect(next).toEqual({ kind: "remove", account });
  });

  it("closes whatever is open", () => {
    expect(modalReducer({ kind: "bucket", bucket, provider: null, confirmDelete: false }, { type: "close" })).toBeNull();
    expect(modalReducer(null, { type: "close" })).toBeNull();
  });

  it("closes a dialog of the named kind", () => {
    expect(modalReducer({ kind: "googleUsage", account }, { type: "close", kind: "googleUsage" })).toBeNull();
  });

  it("leaves a different dialog open when a stale close arrives", () => {
    const open: ModalState = { kind: "googleUsage", account };
    expect(modalReducer(open, { type: "close", kind: "add" })).toBe(open);
    expect(modalReducer(null, { type: "close", kind: "add" })).toBeNull();
  });
});
