import { useRef } from "react";
import { ArrowDownIcon, ArrowUpIcon, BellIcon, ChevronIcon, RefreshIcon, TrashIcon } from "../../shared/ui/icons";
import { computeDropdownPlacement } from "../../shared/ui/dropdown-placement";
import { useAnchoredMenuPlacement, useMenuDismissal, useMenuKeyboardNav } from "../../shared/ui/menu-hooks";
import { displayAccountLabel } from "../../shared/lib/usage-logic";
import type { Account } from "../../types";

export const MENU_GAP = 8;
export const MENU_ESTIMATED_HEIGHT_MOVE = 220;
export const MENU_ESTIMATED_HEIGHT_BASIC = 135;

export type MobileMenuPlacement = {
  openUpward: boolean;
  maxHeight?: number;
};

export function computeAccountCardMenuPlacement(
  toggle: HTMLElement | null,
  hasMoveMenu: boolean,
  menu?: HTMLElement | null,
): MobileMenuPlacement {
  if (!toggle) {
    return { openUpward: false };
  }

  const estimatedHeight = hasMoveMenu ? MENU_ESTIMATED_HEIGHT_MOVE : MENU_ESTIMATED_HEIGHT_BASIC;
  const result = computeDropdownPlacement(toggle, menu ?? null, {
    gap: MENU_GAP,
    minHeight: 80,
    estimatedHeight,
    isFixed: false,
  });

  return {
    openUpward: result.openUpward,
    maxHeight: result.maxHeight,
  };
}

/**
 * The account card's "more actions" menu (the chevron button that shows Move, Refresh, Notifications
 * and Remove on narrow screens). Whether it is open belongs to the card, which also styles itself
 * while a menu is open, so it is controlled through `open` / `onOpenChange`.
 */
export function AccountCardMenu({
  account,
  open,
  onOpenChange,
  hasMove,
  canMoveUp,
  canMoveDown,
  cardBusy,
  refreshDisabled,
  onMove,
  onRefresh,
  onNotifications,
  onRemove,
}: {
  account: Account;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The page lets cards be moved, so the menu lists Move up / Move down. */
  hasMove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  cardBusy: boolean;
  /** Refreshing is blocked (a refresh of all accounts is running). */
  refreshDisabled: boolean;
  onMove: (delta: -1 | 1) => void;
  onRefresh: () => void;
  onNotifications: () => void;
  onRemove: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = `account-actions-${account.id}`;
  const label = displayAccountLabel(account);

  const [placement, measurePlacement] = useAnchoredMenuPlacement<MobileMenuPlacement>({
    open,
    initial: { openUpward: false },
    measure: () => computeAccountCardMenuPlacement(toggleRef.current, hasMove, menuRef.current),
    isSame: (a, b) => a.openUpward === b.openUpward && a.maxHeight === b.maxHeight,
    changeKey: hasMove,
  });

  const close = (restoreFocus = false) => {
    onOpenChange(false);
    if (restoreFocus) {
      // The menu unmounts when it closes, so wait until the toggle is all that's left.
      window.setTimeout(() => toggleRef.current?.focus(), 0);
    }
  };

  const toggle = () => {
    if (open) {
      close(true);
    } else {
      measurePlacement();
      onOpenChange(true);
    }
  };

  useMenuDismissal({
    open,
    containerRef,
    pressEvents: ["mousedown", "touchstart"],
    onDismiss: (restoreFocus) => close(restoreFocus),
  });
  useMenuKeyboardNav({ open, menuRef, itemSelector: ".mobile-dropdown-item" });

  /** Close the menu, then run the action. */
  const choose = (action: () => void) => () => {
    close(true);
    action();
  };

  return (
    <div className={`mobile-actions-dropdown${hasMove ? " has-move-menu" : ""}`} ref={containerRef}>
      <button
        ref={toggleRef}
        type="button"
        className="mobile-dropdown-toggle"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${label}`}
      >
        <ChevronIcon className={open ? "open" : ""} />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`mobile-dropdown-menu ${placement.openUpward ? "upward" : ""}`}
          id={menuId}
          role="menu"
          aria-label={`Actions for ${label}`}
          style={placement.maxHeight != null ? { maxHeight: `${placement.maxHeight}px` } : undefined}
        >
          {hasMove ? (
            <>
              <button type="button" role="menuitem" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveUp} onClick={choose(() => onMove(-1))}>
                <ArrowUpIcon /> Move up
              </button>
              <button type="button" role="menuitem" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveDown} onClick={choose(() => onMove(1))}>
                <ArrowDownIcon /> Move down
              </button>
            </>
          ) : null}
          <button type="button" role="menuitem" className="mobile-dropdown-item mobile-only-item refresh-action" disabled={cardBusy || refreshDisabled} onClick={choose(onRefresh)}>
            <RefreshIcon /> Refresh
          </button>
          <button type="button" role="menuitem" className="mobile-dropdown-item mobile-only-item notify-action" disabled={cardBusy} onClick={choose(onNotifications)}>
            <BellIcon /> Notifications
          </button>
          <button type="button" role="menuitem" className="mobile-dropdown-item mobile-only-item remove-action" disabled={cardBusy} onClick={choose(onRemove)}>
            <TrashIcon /> Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}
