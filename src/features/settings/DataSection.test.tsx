// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { DataSection } from "./DataSection";

const api = vi.hoisted(() => ({
  clearCachedUsage: vi.fn(),
  deleteAllLocalData: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

let app: Mounted | null = null;

beforeEach(() => {
  api.clearCachedUsage.mockReset().mockResolvedValue(undefined);
  api.deleteAllLocalData.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = null;
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label) as HTMLButtonElement;
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
