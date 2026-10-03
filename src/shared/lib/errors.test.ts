import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyError,
  clearError,
  clearRecordedErrorDetails,
  errorMessage,
  friendlyMessage,
  recentErrorDetails,
  recordErrorDetail,
  reportError,
  type AppError,
} from "./errors";

describe("errorMessage", () => {
  it("reads Error instances without the 'Error:' prefix", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("passes through string rejections (as Tauri produces them)", () => {
    expect(errorMessage("Unable to refresh")).toBe("Unable to refresh");
  });

  it("reads message from plain objects", () => {
    expect(errorMessage({ message: "from object" })).toBe("from object");
  });

  it("falls back for empty messages and unknown values", () => {
    expect(errorMessage(new Error("  "))).toBe("Something went wrong.");
    expect(errorMessage("")).toBe("Something went wrong.");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("reportError / clearError", () => {
  it("appends an error for a new source", () => {
    expect(reportError([], "load", "down")).toEqual([{ source: "load", message: "down" }]);
  });

  it("replaces in place when the same source fails again", () => {
    const first: AppError[] = [
      { source: "load", message: "a" },
      { source: "settings", message: "b" },
    ];
    expect(reportError(first, "load", "c")).toEqual([
      { source: "load", message: "c" },
      { source: "settings", message: "b" },
    ]);
  });

  it("returns the same array when nothing changes, so React skips a render", () => {
    const list: AppError[] = [{ source: "load", message: "a" }];
    expect(reportError(list, "load", "a")).toBe(list);
    expect(clearError(list, "other")).toBe(list);
  });

  it("clears only the matching source", () => {
    const list: AppError[] = [
      { source: "refresh:a", message: "x" },
      { source: "refresh:b", message: "y" },
    ];
    expect(clearError(list, "refresh:a")).toEqual([{ source: "refresh:b", message: "y" }]);
  });

  it("does not mutate its input", () => {
    const list: AppError[] = [{ source: "a", message: "1" }];
    reportError(list, "b", "2");
    clearError(list, "a");
    expect(list).toEqual([{ source: "a", message: "1" }]);
  });
});

describe("classifyError", () => {
  it("recognizes a failed call to the backend", () => {
    expect(classifyError("Cannot read properties of undefined (reading 'invoke')")).toBe("backend");
    expect(classifyError("window.__TAURI_INTERNALS__ is undefined")).toBe("backend");
    expect(classifyError("get_dashboard_snapshot not allowed. Command not found")).toBe("backend");
    expect(classifyError("plugin:window|x not allowed by ACL for this command")).toBe("backend");
  });

  it("recognizes connection problems", () => {
    expect(classifyError("error sending request for url (https://example.test)")).toBe("network");
    expect(classifyError("Failed to fetch")).toBe("network");
    expect(classifyError("operation timed out")).toBe("network");
    expect(classifyError("error trying to connect: dns error: failed to lookup address")).toBe("network");
  });

  it("recognizes technical text", () => {
    expect(classifyError("TypeError: x is not iterable")).toBe("technical");
    expect(classifyError('{"error":"invalid_request"}')).toBe("technical");
    expect(classifyError("HTTP 502 from upstream")).toBe("technical");
    expect(classifyError("thread 'main' panicked at src/lib.rs:1")).toBe("technical");
    expect(classifyError("x".repeat(300))).toBe("technical");
  });

  it("leaves readable sentences alone", () => {
    expect(classifyError("Sign in again to keep tracking this account.")).toBe("plain");
    expect(classifyError("Google Cloud usage could not be refreshed.")).toBe("plain");
    expect(classifyError("Account name is required.")).toBe("plain");
    expect(classifyError("Grok login timed out. Start the connection again.")).toBe("plain");
    expect(classifyError("The update download timed out. Check your connection and try again, or download the installer from the releases page.")).toBe("plain");
    expect(classifyError("Account refresh timed out.")).toBe("plain");
    expect(classifyError("Replacing credentials on this device is not allowed.")).toBe("plain");
  });
});

describe("friendlyMessage", () => {
  it("replaces technical text with a sentence and a next step", () => {
    const text = friendlyMessage("Couldn't load app settings", "Cannot read properties of undefined (reading 'invoke')");
    expect(text).toContain("Couldn't load app settings.");
    expect(text).toContain("Restart the app");
    expect(text).toContain("Copy Diagnostics");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("invoke");
  });

  it("tells people to check their connection", () => {
    expect(friendlyMessage("Couldn't refresh account", "error sending request")).toBe(
      "Couldn't refresh account. Check your internet connection and try again.",
    );
  });

  it("works without a context", () => {
    expect(friendlyMessage(undefined, "TypeError: x")).toMatch(/^Something unexpected went wrong\./);
  });

  it("keeps readable detail as before", () => {
    expect(friendlyMessage("Couldn't remove Claude", "The account is already gone.")).toBe(
      "Couldn't remove Claude: The account is already gone.",
    );
    expect(friendlyMessage(undefined, "Sign in again.")).toBe("Sign in again.");
  });
});

describe("recorded error detail", () => {
  beforeEach(() => clearRecordedErrorDetails());

  it("keeps the raw cause for Copy Diagnostics, with secrets redacted", () => {
    recordErrorDetail("settings", "Couldn't load app settings", "Failed for me@example.com token abcdefghijklmnopqrstuvwxyz0123456789");
    const [line] = recentErrorDetails();
    expect(line).toContain("[settings] Couldn't load app settings: Failed for [email] token [redacted]");
    expect(line).not.toContain("me@example.com");
    expect(line).not.toContain("abcdefghijklmnop");
  });

  it("keeps only the latest entries and caps their length", () => {
    for (let i = 0; i < 30; i += 1) recordErrorDetail("s", undefined, `error ${i} ${"y".repeat(500)}`);
    const lines = recentErrorDetails();
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("error 10");
    expect(lines.every((line) => line.length < 400)).toBe(true);
  });
});
