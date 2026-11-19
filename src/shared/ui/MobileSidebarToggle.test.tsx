// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { MobileSidebarToggle } from "./MobileSidebarToggle";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("MobileSidebarToggle", () => {
  it("is a lone button without a trailing control", () => {
    mounted = mount(<MobileSidebarToggle onToggle={() => {}} filterLabel="Work Acct" />);
    expect(mounted.container.querySelector(".mobile-filter-with-edit")).toBeNull();
    expect(mounted.container.querySelectorAll("button")).toHaveLength(1);
  });

  it("puts a trailing button beside the filter button, not inside it, so each keeps its own click", () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    mounted = mount(
      <MobileSidebarToggle
        onToggle={onToggle}
        filterLabel="Work Acct"
        isFiltered
        trailing={<button type="button" className="edit-bucket-title-btn" aria-label="Edit Group" onClick={onEdit} />}
      />,
    );
    const group = mounted.container.querySelector(".mobile-filter-with-edit")!;
    const [filter, edit] = [...group.children] as HTMLButtonElement[];
    expect(filter.classList.contains("mobile-sidebar-toggle-btn")).toBe(true);
    expect(filter.contains(edit)).toBe(false);
    expect(edit.getAttribute("aria-label")).toBe("Edit Group");

    act(() => edit.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    act(() => filter.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
