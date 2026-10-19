// @vitest-environment happy-dom
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "../../test-utils/react";
import { ModalDialog } from "./ModalDialog";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function render(props: Partial<Parameters<typeof ModalDialog>[0]> = {}) {
  const onClose = vi.fn();
  const ref = createRef<HTMLElement>();
  mounted = mount(
    <ModalDialog dialogRef={ref} labelledBy="t" onClose={onClose} {...props}>
      <div className="modal-kicker">Kicker</div>
      <h2 id="t">Title</h2>
      <p>Body</p>
    </ModalDialog>,
  );
  return { onClose, ref };
}

describe("ModalDialog", () => {
  it("renders the backdrop, dialog section and close button with the markup the styles select", () => {
    const { ref } = render({ className: "my-modal", backdropClassName: "keyboard-open" });
    const backdrop = document.querySelector(".modal-backdrop")!;
    expect(backdrop.getAttribute("role")).toBe("presentation");
    expect(backdrop.classList.contains("keyboard-open")).toBe(true);
    const card = backdrop.firstElementChild as HTMLElement;
    expect(card.tagName).toBe("SECTION");
    expect(card.className).toBe("modal-card my-modal");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-modal")).toBe("true");
    expect(card.getAttribute("aria-labelledby")).toBe("t");
    expect(card.getAttribute("aria-describedby")).toBeNull();
    expect(card.getAttribute("tabindex")).toBe("-1");
    expect(ref.current).toBe(card);
    // Close button first, then the children as direct children of the card.
    expect(card.children[0].classList.contains("ui-modal-close")).toBe(true);
    expect(card.querySelector(":scope > .modal-kicker")).not.toBeNull();
    expect(card.querySelector(":scope > h2")?.textContent).toBe("Title");
  });

  it("uses plain class names when none are given", () => {
    render();
    expect(document.querySelector(".modal-backdrop")!.className).toBe("modal-backdrop");
    expect(document.querySelector("section")!.className).toBe("modal-card");
  });

  it("can be an alert dialog with a description", () => {
    render({ role: "alertdialog", describedBy: "d" });
    const card = document.querySelector("section")!;
    expect(card.getAttribute("role")).toBe("alertdialog");
    expect(card.getAttribute("aria-describedby")).toBe("d");
  });

  it("closes from the × and from a press on the backdrop, but not from a press inside", () => {
    const { onClose } = render();
    click(document.querySelector(".ui-modal-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector(".modal-backdrop")!;
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    document.querySelector("section")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders dialogs opened from it inside the backdrop, after the section", () => {
    render({ afterDialog: <div className="nested-confirm" /> });
    const backdrop = document.querySelector(".modal-backdrop")!;
    expect(backdrop.children).toHaveLength(2);
    expect(backdrop.children[0].tagName).toBe("SECTION");
    expect(backdrop.children[1].className).toBe("nested-confirm");
  });

  it("can disable the × while busy", () => {
    render({ closeDisabled: true });
    expect((document.querySelector(".ui-modal-close") as HTMLButtonElement).disabled).toBe(true);
  });
});
