import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../shared/lib/storage", () => ({
  STORAGE_KEYS: {},
  storageGet: () => null,
  storageRemove: () => {},
  storageSet: () => true,
}));

import { clearRecordedErrorDetails, recordErrorDetail } from "../../shared/lib/errors";
import { copyDiagnostics } from "./diagnostics";

beforeEach(() => {
  invoke.mockReset();
  clearRecordedErrorDetails();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyDiagnostics", () => {
  it("copies the report the backend produced", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    invoke.mockResolvedValue("AI Usage Tracker diagnostics\nVersion: 1.2.3");

    await copyDiagnostics();

    expect(invoke).toHaveBeenCalledWith("get_diagnostics");
    expect(writeText).toHaveBeenCalledWith("AI Usage Tracker diagnostics\nVersion: 1.2.3");
  });

  it("adds the technical detail behind recent error banners", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    invoke.mockResolvedValue("report");
    recordErrorDetail("settings", "Couldn't load app settings", "Cannot read properties of undefined");

    await copyDiagnostics();

    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.startsWith("report\n\nRecent app errors (technical detail):\n")).toBe(true);
    expect(copied).toContain("[settings] Couldn't load app settings: Cannot read properties of undefined");
  });

  it("reports when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    invoke.mockResolvedValue("report");
    await expect(copyDiagnostics()).rejects.toThrow("not available");
  });

  it("passes a failed report request through", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    invoke.mockRejectedValue("ipc closed");
    await expect(copyDiagnostics()).rejects.toBe("ipc closed");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("passes a clipboard failure through", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    invoke.mockResolvedValue("report");
    await expect(copyDiagnostics()).rejects.toThrow("denied");
  });
});
