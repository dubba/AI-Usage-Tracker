import { useLayoutEffect, useRef, useState, useId, type CSSProperties, type RefObject } from "react";
import { useScrollThumb } from "../hooks/useScrollThumb";
import { useAnchoredMenuPlacement, useMenuDismissal } from "./menu-hooks";

export type DropdownOption<T extends string | number> = {
  value: T;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
};

import { computeDropdownPlacement, getFixedContainingBlockBox, snapMaxHeightToWholeRows } from "./dropdown-placement";

export const MENU_GAP = 5;
export const MENU_MAX_HEIGHT = 280;

type MenuPlacement = {
  openUpward: boolean;
  style: CSSProperties;
};

export function computeCustomDropdownPlacement(
  anchor: HTMLElement | null,
  menu: HTMLElement | null,
  optionCount = 0,
): MenuPlacement {
  if (!anchor) {
    return { openUpward: false, style: {} };
  }

  const rect = anchor.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;

  const estimatedHeight = Math.min(MENU_MAX_HEIGHT, Math.max(44, optionCount * 40 + 12));
  const result = computeDropdownPlacement(anchor, menu, {
    gap: MENU_GAP,
    minHeight: 0,
    maxHeightCap: MENU_MAX_HEIGHT,
    estimatedHeight,
    isFixed: true,
  });

  // The menu is position:fixed, but its containing block is not always the
  // viewport: a transformed/filtered ancestor (the modal backdrop's
  // backdrop-filter, the modal card's keyboard-mode translateY(0)) becomes the
  // containing block instead. Translate viewport-space coordinates into that
  // ancestor's space so the menu stays glued to the trigger. When the
  // viewport itself is the containing block the offset is zero and these are
  // exactly the previous values.
  const containingBlock = getFixedContainingBlockBox(anchor);
  const blockHeight = containingBlock.height > 0 ? containingBlock.height : viewportHeight;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - rect.width - 8)) - containingBlock.left;
  // End the menu flush after the last fully visible row so the space below it
  // matches the top padding instead of showing a cut-off sliver. On the
  // first pass the menu is not rendered yet (menu is null) and on later
  // passes this recomputes pre-paint, so there is no flicker.
  const maxHeight = snapMaxHeightToWholeRows(menu, result.maxHeight);

  return {
    openUpward: result.openUpward,
    style: {
      position: "fixed",
      left,
      width: rect.width,
      minWidth: rect.width,
      maxHeight,
      top: result.openUpward ? "auto" : rect.bottom - containingBlock.top + MENU_GAP,
      bottom: result.openUpward ? blockHeight - (rect.top - containingBlock.top) + MENU_GAP : "auto",
    },
  };
}


function scrollItemIntoList(list: HTMLUListElement, item: HTMLElement) {
  const itemTop = item.offsetTop;
  const itemBottom = itemTop + item.offsetHeight;
  if (itemTop < list.scrollTop) {
    list.scrollTop = itemTop;
  } else if (itemBottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = itemBottom - list.clientHeight;
  }
}

export function CustomDropdown<T extends string | number>({
  id,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select an option",
  className = "",
  ariaLabel,
  "aria-label": ariaLabelProp,
  "aria-labelledby": ariaLabelledBy,
}: {
  id?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const generatedId = useId();
  const dropdownId = id ?? generatedId;
  const listboxId = `${dropdownId}-listbox`;
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const thumb = useScrollThumb(listRef, isOpen, options.length);
  const [placement, measurePlacement] = useAnchoredMenuPlacement<MenuPlacement>({
    open: isOpen,
    initial: { openUpward: false, style: {} },
    measure: () => computeCustomDropdownPlacement(containerRef.current, listRef.current, options.length),
    isSame: (a, b) =>
      a.openUpward === b.openUpward &&
      a.style.top === b.style.top &&
      a.style.bottom === b.style.bottom &&
      a.style.left === b.style.left &&
      a.style.width === b.style.width &&
      a.style.maxHeight === b.style.maxHeight,
    changeKey: options.length,
  });

  const selectedOption = options.find((opt) => opt.value === value);
  const selectedIndex = options.findIndex((opt) => opt.value === value);

  const openMenu = () => {
    measurePlacement();
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setIsOpen(false);
    setHighlightedIndex(-1);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  };

  useMenuDismissal({ open: isOpen, containerRef, pressEvents: ["pointerdown"], onDismiss: closeMenu });

  useLayoutEffect(() => {
    if (!isOpen || highlightedIndex < 0 || !listRef.current) return;
    const item = listRef.current.querySelectorAll<HTMLLIElement>(".custom-dropdown-item")[highlightedIndex];
    if (item) {
      scrollItemIntoList(listRef.current, item);
    }
  }, [isOpen, highlightedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isOpen) {
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          onChange(options[highlightedIndex].value);
          closeMenu(true);
        }
      } else {
        openMenu();
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      } else {
        setHighlightedIndex((prev) => (prev + 1 < options.length ? prev + 1 : 0));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      } else {
        setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : options.length - 1));
      }
    } else if (event.key === "Home") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      }
      setHighlightedIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
      }
      setHighlightedIndex(options.length - 1);
    } else if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab" && isOpen) {
      closeMenu();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`custom-dropdown-container ${className} ${disabled ? "disabled" : ""} ${isOpen ? "open" : ""}`}
    >
      <button
        ref={triggerRef}
        type="button"
        id={dropdownId}
        className="custom-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-label={ariaLabelProp ?? ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-activedescendant={
          isOpen && highlightedIndex >= 0 ? `${dropdownId}-opt-${highlightedIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (isOpen) closeMenu();
          else openMenu();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="custom-dropdown-trigger-content">
          {selectedOption?.icon && (
            <span className="custom-dropdown-icon">{selectedOption.icon}</span>
          )}
          <div className="custom-dropdown-trigger-text">
            <span className="custom-dropdown-label">
              {selectedOption ? selectedOption.label : placeholder}
            </span>
            {selectedOption?.detail && (
              <span className="custom-dropdown-detail">{selectedOption.detail}</span>
            )}
          </div>
        </div>
        <svg
          className={`custom-dropdown-chevron ${isOpen ? "open" : ""}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <ul
          ref={listRef}
          id={listboxId}
          className={`custom-dropdown-menu ${placement.openUpward ? "upward" : ""} ${thumb.overflows ? "has-overflow" : ""}`}
          role="listbox"
          aria-labelledby={dropdownId}
          style={placement.style}
        >
          {thumb.overflows && (
            <li
              ref={thumb.thumbRef as RefObject<HTMLLIElement>}
              role="presentation"
              aria-hidden="true"
              className="scroll-thumb"
              onPointerDown={thumb.onThumbPointerDown}
            />
          )}
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={String(option.value)}
                id={`${dropdownId}-opt-${index}`}
                role="option"
                aria-selected={isSelected}
                className={`custom-dropdown-item ${isSelected ? "selected" : ""} ${
                  isHighlighted ? "highlighted" : ""
                }`}
                onClick={() => {
                  onChange(option.value);
                  closeMenu(true);
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                {option.icon && (
                  <span className="custom-dropdown-item-icon">{option.icon}</span>
                )}
                <div className="custom-dropdown-item-content">
                  <span className="custom-dropdown-item-label">{option.label}</span>
                  {option.detail && (
                    <span className="custom-dropdown-item-detail">{option.detail}</span>
                  )}
                </div>
                {isSelected && (
                  <svg
                    className="custom-dropdown-check"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
