// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { DataSection } from "./DataSection";

const api = vi.hoisted(() => ({
  getDiagnostics: vi.fn(),
  clearActivityHistory: vi.fn(),
  deleteAllLocalData: vi.fn(),
}));
vi.mock("../../shared/lib/api", () => ({ bridgeApi: api }));

let app: Mounted | null = null;

beforeEach(() => {
  api.getDiagnostics.mockReset().mockResolvedValue("{}");
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
  const onAllDataDeleted = vi.fn();
  app = mount(<DataSection onAllDataDeleted={onAllDataDeleted} {...props} />);
  return { onAllDataDeleted };
}

describe("DataSection", () => {
  it("renders Diagnostics first, followed by Clear Usage History and Delete Local App Data, with left-aligned button icons", () => {
    render();
    expect(document.querySelector("h2#settings-section-data")?.textContent?.trim()).toBe("Data & Diagnostics");
    expect(document.body.textContent).not.toContain("Refresh Usage");
    const titles = [...document.querySelectorAll(".settings-row strong")].map((el) => el.textContent?.trim());
    expect(titles).toEqual(["Diagnostics", "Clear Usage History", "Delete Local App Data"]);
    for (const btn of [byLabel("Copy diagnostics"), byLabel("Clear usage history"), button("Delete")]) {
      const childTags = [...btn.children].map((el) => el.tagName.toLowerCase());
      expect(childTags).toEqual(["svg", "span"]);
    }
  });

  it("clears the usage history on one click", async () => {
    const { onAllDataDeleted } = render();
    expect(document.body.textContent).toContain("Clear Usage History");
    expect(document.body.textContent).toContain(
      "Clears usage history and restarts tracking. Keeps dashboard data.",
    );

    click(byLabel("Clear usage history"));
    await flush();

    expect(api.clearActivityHistory).toHaveBeenCalledTimes(1);
    expect(api.deleteAllLocalData).not.toHaveBeenCalled();
    expect(onAllDataDeleted).not.toHaveBeenCalled();
    expect(byLabel("Clear usage history").textContent).toBe("Cleared!");
    expect([...document.querySelectorAll("[role=status]")].map((el) => el.textContent).join("")).toBe(
      "Usage history cleared.",
    );
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

  it("shows why clearing the usage history failed and clears the error on a later success", async () => {
    api.clearActivityHistory.mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
    render();

    click(byLabel("Clear usage history"));
    await flush();

    expect(document.querySelector("[role=alert]")?.textContent).toBe("Couldn't clear usage history: disk full");
    expect(byLabel("Clear usage history").textContent).toBe("Clear");
    expect([...document.querySelectorAll("[role=status]")].map((el) => el.textContent).join("")).toBe("");

    click(byLabel("Clear usage history"));
    await flush();
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(byLabel("Clear usage history").textContent).toBe("Cleared!");
  });

  it("says that deleting everything removes the usage history too", () => {
    render();
    expect(document.body.textContent).toContain("Remove all accounts, usage history, and settings from this device.");
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
