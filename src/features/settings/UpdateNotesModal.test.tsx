// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { UpdateNotesModal } from "./UpdateNotesModal";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const show = (releaseNotes: string, onInstallUpdate?: () => void) => {
  mounted = mount(
    <UpdateNotesModal
      open
      version="0.6.7"
      currentVersion="0.6.4"
      releaseDate="2026-11-20T18:06:02Z"
      releaseNotes={releaseNotes}
      onInstallUpdate={onInstallUpdate}
      onClose={() => {}}
      onOpenLink={() => {}}
    />,
  );
  return document.querySelector("#update-notes-title")!.textContent;
};

describe("UpdateNotesModal", () => {
  it("names the running version when the notes cover every release since it", () => {
    const title = show("## v0.6.7 - 2026-11-20\n\n- seven\n\n## v0.6.6 - 2026-11-20\n\n- six\n\n## v0.6.5 - 2026-11-19\n\n- five");
    expect(title).toBe("What changed since v0.6.4");
    expect(document.querySelector(".update-notes-subtitle")!.textContent).toContain("3 releases");
    expect(document.querySelectorAll(".update-notes-heading-2")).toHaveLength(3);
  });

  it("names the new version when the notes are for that release only", () => {
    expect(show("## v0.6.7 - 2026-11-20\n\n- seven", () => {})).toBe("What changed in v0.6.7");
    expect(document.querySelector(".update-notes-subtitle")!.textContent).toMatch(/^Published /);
    const actions = document.querySelector(".update-notes-actions")!;
    expect(actions.classList.contains("is-split")).toBe(true);
    const closeBtn = [...actions.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Close");
    expect(closeBtn?.classList.contains("button-tertiary")).toBe(true);
    const updateBtn = actions.querySelector<HTMLButtonElement>(".settings-update-action");
    expect(updateBtn?.classList.contains("primary")).toBe(true);
    expect(updateBtn?.classList.contains("button-green")).toBe(false);
  });
});
