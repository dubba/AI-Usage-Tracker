import { useEffect, useLayoutEffect, useRef, useState, useId, type CSSProperties } from "react";

export type DropdownOption<T extends string | number> = {
  value: T;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
};

const MENU_GAP = 5;
const MENU_MAX_HEIGHT = 280;
const MENU_FLIP_HEIGHT = 240;

type MenuPlacement = {
  openUpward: boolean;
  style: CSSProperties;
};

function computeMenuPlacement(anchor: HTMLElement | null): MenuPlacement {
  if (!anchor) {
    return { openUpward: false, style: {} };
  }

  const rect = anchor.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - MENU_GAP;
  const spaceAbove = rect.top - MENU_GAP;
  const openUpward = spaceBelow < MENU_FLIP_HEIGHT && spaceAbove > spaceBelow;
  const available = openUpward ? spaceAbove : spaceBelow;
  const maxHeight = Math.min(MENU_MAX_HEIGHT, Math.max(0, available));

  return {
    openUpward,
    style: {
      position: "fixed",
      left: rect.left,
      width: rect.width,
      minWidth: rect.width,
      maxHeight,
      top: openUpward ? "auto" : rect.bottom + MENU_GAP,
      bottom: openUpward ? viewportHeight - rect.top + MENU_GAP : "auto",
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
}: {
  id?: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const generatedId = useId();
  const dropdownId = id ?? generatedId;
  const listboxId = `${dropdownId}-listbox`;
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement>({ openUpward: false, style: {} });
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);
  const selectedIndex = options.findIndex((opt) => opt.value === value);

  const openMenu = () => {
    setPlacement(computeMenuPlacement(containerRef.current));
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  const closeMenu = () => {
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePlacement = () => {
      setPlacement(computeMenuPlacement(containerRef.current));
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    window.visualViewport?.addEventListener("resize", updatePlacement);
    window.visualViewport?.addEventListener("scroll", updatePlacement);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
      window.visualViewport?.removeEventListener("resize", updatePlacement);
      window.visualViewport?.removeEventListener("scroll", updatePlacement);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

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
          closeMenu();
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
        type="button"
        id={dropdownId}
        className="custom-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
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
          className={`custom-dropdown-menu ${placement.openUpward ? "upward" : ""}`}
          role="listbox"
          aria-labelledby={dropdownId}
          style={placement.style}
        >
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
                  closeMenu();
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
