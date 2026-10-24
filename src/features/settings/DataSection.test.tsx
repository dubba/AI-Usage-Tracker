// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { DataSection } from "./DataSection";

const api = vi.hoisted(() => ({
  clearCachedUsage: vi.fn(),
  clearActivityHistory: vi.fn(),
  deleteAllLocalData: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

let app: Mounted | null = null;

beforeEach(() => {
  api.clearCachedUsage.mockReset().mockResolvedValue(undefined);
  api.clearActivityHistory.mockReset().mockResolvedValue(undefined);
  api.deleteAllLocalData.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = null;
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label) as HTMLButtonElement;
const byLabel = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const flush = () => act(async () => {});

function render(props: Partial<Parameters<typeof DataSection>[0]> = {}) {
  const onUsageCleared = vi.fn();
  const onAllDataDeleted = vi.fn();
  app = mount(<DataSection onUsageCleared={onUsageCleared} onAllDataDeleted={onAllDataDeleted} {...props} />);
  return { onUsageCleared, onAllDataDeleted };
}

describe("DataSection", () => {
  it("clears cached usage on one click and then lets the app reload it", async () => {
    const { onUsageCleared, onAllDataDeleted } = render();
    expect(document.querySelector("h2")?.textContent).toBe("Data");

    click(button("Clear"));
    await flush();

    expect(api.clearCachedUsage).toHaveBeenCalledTimes(1);
    expect(onUsageCleared).toHaveBeenCalledTimes(1);
    expect(button("Cleared!")).toBeTruthy();
    expect(api.deleteAllLocalData).not.toHaveBeenCalled();
    expect(onAllDataDeleted).not.toHaveBeenCalled();
  });

  it("shows why clearing failed and does not report success", async () => {
    api.clearCachedUsage.mockRejectedValue(new Error("disk full"));
    const { onUsageCleared } = render();

    click(button("Clear"));
    await flush();

    expect(document.querySelector("[role=alert]")?.textContent).toContain("disk full");
    expect(onUsageCleared).not.toHaveBeenCalled();
    expect(button("Clear")).toBeTruthy();
  });

  it("clears the usage history on one click, without touching cached usage", async () => {
    const { onUsageCleared, onAllDataDeleted } = render();
    expect(document.body.textContent).toContain("Clear Usage History");

    click(byLabel("Clear usage history"));
    await flush();

    expect(api.clearActivityHistory).toHaveBeenCalledTimes(1);
    expect(api.clearCachedUsage).not.toHaveBeenCalled();
    expect(onUsageCleared).not.toHaveBeenCalled();
    expect(api.deleteAllLocalData).not.toHaveBeenCalled();
    expect(onAllDataDeleted).not.toHaveBeenCalled();
    expect(byLabel("Clear usage history").textContent).toBe("Cleared!");
    expect(byLabel("Clear cached usage").textContent).toBe("Clear");
    expect(document.querySelector("[role=status]")?.textContent).toBe("Usage history cleared.");
  });

  it("shows the usage history clearing in progress, and the button cannot be pressed twice", async () => {
    let finish!: () => void;
    api.clearActivityHistory.mockReturnValue(new Promise<void>((done) => (finish = done)));
    render();

    click(byLabel("Clear usage history"));
    await flush();
    expect(byLabel("Clear usage history").textContent).toBe("Clearing…");
    expect(byLabel("Clear usage history").disabled).toBe(true);
    click(byLabel("Clear usage history"));
    expect(api.clearActivityHistory).toHaveBeenCalledTimes(1);

    finish();
    await flush();
    expect(byLabel("Clear usage history").textContent).toBe("Cleared!");
  });

  it("shows why clearing the usage history failed and does not report success", async () => {
    api.clearActivityHistory.mockRejectedValue(new Error("disk full"));
    render();

    click(byLabel("Clear usage history"));
    await flush();

    expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't clear usage history: disk full");
    expect(byLabel("Clear usage history").textContent).toBe("Clear");
    expect(document.querySelector("[role=status]")?.textContent).toBe("");
    // The cached usage row is unaffected, and a later success clears the message.
    click(byLabel("Clear cached usage"));
    await flush();
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("says that deleting everything removes the usage history too", () => {
    render();
    expect(document.body.textContent).toContain("usage snapshots, usage history, and settings");
    click(button("Delete"));
    expect(document.querySelector("[role=alertdialog]")?.textContent).toContain("usage snapshots, usage history, groups");
  });

  it("deletes nothing until the confirmation is accepted", async () => {
    const { onAllDataDeleted } = render();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();

    click(button("Delete"));
    expect(document.querySelector("[role=alertdialog]")).not.toBeNull();
    expect(api.deleteAllLocalData).not.toHaveBeenCalled();

    click(button("Cancel"));
    await flush();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(api.deleteAllLocalData).not.toHaveBeenCalled();
    expect(onAllDataDeleted).not.toHaveBeenCalled();
  });

  it("deletes everything after confirming, then tells the app to start over", async () => {
    const { onAllDataDeleted } = render();

    click(button("Delete"));
    click(button("Delete Everything"));
    await flush();

    expect(api.deleteAllLocalData).toHaveBeenCalledTimes(1);
    expect(onAllDataDeleted).toHaveBeenCalledTimes(1);
  });

  it("keeps the app as it is and shows the reason when deleting fails", async () => {
    api.deleteAllLocalData.mockRejectedValue(new Error("keychain locked"));
    const { onAllDataDeleted } = render();

    click(button("Delete"));
    click(button("Delete Everything"));
    await flush();

    expect(onAllDataDeleted).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("keychain locked");
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(button("Delete").disabled).toBe(false);
  });
});
