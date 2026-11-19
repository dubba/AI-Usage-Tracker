// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { ConfirmDialog } from "./ConfirmDialog";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ConfirmDialog", () => {
  it("draws its backdrop at the end of the page, outside the section that opened it", () => {
    mounted = mount(
      <div className="settings-card" style={{ transform: "translateZ(0)" }}>
        <ConfirmDialog open kicker="Delete" title="Delete it?" body="Gone." confirmLabel="Delete" onConfirm={() => {}} onCancel={() => {}} />
      </div>,
    );
    const backdrop = document.querySelector(".modal-backdrop")!;
    expect(mounted.container.contains(backdrop)).toBe(false);
    expect(backdrop.parentElement).toBe(document.body);
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain("Delete it?");
  });
});
