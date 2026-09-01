import { useEffect, useRef, useState, useId } from "react";

export type DropdownOption<T extends string | number> = {
  value: T;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
};

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
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);
  const selectedIndex = options.findIndex((opt) => opt.value === value);

  useEffect(() => {
    if (!isOpen) {
      setHighlightedIndex(-1);
      return;
    }

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setOpenUpward(spaceBelow < 240 && spaceAbove > spaceBelow);
    }

    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, selectedIndex]);

  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll<HTMLLIElement>(".custom-dropdown-item");
      const item = items[highlightedIndex];
      if (item) {
        item.scrollIntoView({ block: "nearest" });
      }
    }
  }, [isOpen, highlightedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (isOpen) {
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          onChange(options[highlightedIndex].value);
          setIsOpen(false);
        }
      } else {
        setIsOpen(true);
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setHighlightedIndex((prev) => (prev + 1 < options.length ? prev + 1 : 0));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
      } else {
        setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : options.length - 1));
      }
    } else if (event.key === "Tab" && isOpen) {
      setIsOpen(false);
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
        aria-labelledby={dropdownId}
        disabled={disabled}
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
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
          className={`custom-dropdown-menu ${openUpward ? "upward" : ""}`}
          role="listbox"
          aria-labelledby={dropdownId}
          tabIndex={-1}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;
            return (
              <li
                key={String(option.value)}
                role="option"
                aria-selected={isSelected}
                className={`custom-dropdown-item ${isSelected ? "selected" : ""} ${
                  isHighlighted ? "highlighted" : ""
                }`}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
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
