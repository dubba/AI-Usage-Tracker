import { useRef } from "react";
import { ArrowDownIcon, ArrowUpIcon, BellIcon, ChevronIcon, EditIcon, MoreIcon, RefreshIcon, TrashIcon } from "../../shared/ui/icons";
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
 * The account card's "more actions" menu. On narrow screens (`variant` "mobile") it is the chevron
 * button that shows Move, Refresh, Notifications and Remove. On a wide window ("desktop") it is the
 * ⋯ button beside Refresh and Alerts, holding Move, Collapse, Rename and Remove. Whether it is open
 * belongs to the card, which also styles itself while a menu is open, so it is controlled through
 * `open` / `onOpenChange`.
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
  variant = "mobile",
  collapsed = false,
  onToggleCollapse,
  onRename,
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
  variant?: "mobile" | "desktop";
  /** Desktop only: the card is collapsed, so the menu offers Expand instead of Collapse. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onRename?: () => void;
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
    // pointerdown too: a press on a card or sidebar row starts the reorder gesture, which cancels
    // the press's default action, so no mousedown follows it.
    pressEvents: ["pointerdown", "mousedown", "touchstart"],
    onDismiss: (restoreFocus) => close(restoreFocus),
  });
  useMenuKeyboardNav({ open, menuRef, itemSelector: ".mobile-dropdown-item" });

  /** Close the menu, then run the action. */
  const choose = (action: () => void) => () => {
    close(true);
    action();
  };

  const menuStyle = placement.maxHeight != null ? { maxHeight: `${placement.maxHeight}px` } : undefined;
  const moveItems = hasMove ? (
    <>
      <button type="button" role="menuitem" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveUp} onClick={choose(() => onMove(-1))}>
        <ArrowUpIcon /> Move up
      </button>
      <button type="button" role="menuitem" className="mobile-dropdown-item move-action" disabled={cardBusy || !canMoveDown} onClick={choose(() => onMove(1))}>
        <ArrowDownIcon /> Move down
      </button>
    </>
  ) : null;

  if (variant === "desktop") {
    return (
      <div className="account-card-menu" ref={containerRef}>
        <button
          ref={toggleRef}
          type="button"
          className="account-card-action more-action"
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-label={`More actions for ${label}`}
          data-tooltip={open ? undefined : "More actions"}
        >
          <MoreIcon />
        </button>
        {open ? (
          <div
            ref={menuRef}
            className={`mobile-dropdown-menu account-card-menu-list ${placement.openUpward ? "upward" : ""}`}
            id={menuId}
            role="menu"
            aria-label={`Actions for ${label}`}
            style={menuStyle}
          >
            {moveItems}
            {onToggleCollapse ? (
              <button type="button" role="menuitem" className="mobile-dropdown-item collapse-action" onClick={choose(onToggleCollapse)}>
                <ChevronIcon className={collapsed ? "is-collapsed" : undefined} /> {collapsed ? "Expand card" : "Collapse card"}
              </button>
            ) : null}
            {onRename ? (
              <button type="button" role="menuitem" className="mobile-dropdown-item rename-action" disabled={cardBusy} onClick={() => {
                // Focus goes to the name field, not back to the toggle.
                close();
                onRename();
              }}>
                <EditIcon /> Rename
              </button>
            ) : null}
            <div className="account-card-menu-separator" role="separator" />
            <button type="button" role="menuitem" className="mobile-dropdown-item remove-action" disabled={cardBusy} onClick={choose(onRemove)}>
              <TrashIcon /> Remove account
            </button>
          </div>
        ) : null}
      </div>
    );
  }

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
          style={menuStyle}
        >
          {moveItems}
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
