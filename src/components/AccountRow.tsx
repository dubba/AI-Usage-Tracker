import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { ACCOUNT_METADATA_EVENT, getCustomAccountEmail } from "../account-metadata";
import { bridgeApi } from "../api";
import type { Account, Provider, UsageWindow } from "../types";
import { EditIcon, LinkIcon, SettingsIcon } from "../icons";
import { ProviderIcon } from "./ProviderIcon";

const DRAG_START_DISTANCE_PX = 6;
const REORDER_ANIMATION_MS = 170;
const AUTO_SCROLL_EDGE_PX = 54;
const AUTO_SCROLL_MAX_STEP_PX = 18;

type PointerDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  lastClientY: number;
  started: boolean;
  insertionIndex: number;
  listElement: HTMLElement;
  sourceShell: HTMLElement;
  placeholder: HTMLElement | null;
  originalOrder: string[];
  autoScrollFrame: number | null;
};

function providerName(provider: Provider): string {
  switch (provider) {
    case "openai": return "OpenAI Codex";
    case "anthropic": return "Anthropic Claude";
    case "antigravity": return "Google Antigravity";
    case "opencode_go": return "OpenCode Go";
  }
}

function windowRemaining(account: Account, target: "five_hour" | "weekly"): number | null {
  const window = account.lastUsage?.windows.find((candidate: UsageWindow) => {
    const id = candidate.id.toLowerCase().replaceAll("-", "_");
    const label = candidate.label.toLowerCase();
    if (target === "five_hour") {
      return id === "five_hour" || id === "rolling" || candidate.windowSeconds === 18_000 || label.includes("5 hour") || label.includes("five hour");
    }
    return id === "weekly" || candidate.windowSeconds === 604_800 || label.includes("weekly");
  });
  return window?.remainingPercent ?? null;
}

function RemainingStat({ label, value }: { label: "H" | "W"; value: number | null }) {
  return (
    <span className="account-window-stat">
      <strong>{value == null ? "—" : `${Math.round(value)}%`}</strong>
      <small>{label}</small>
    </span>
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, [contenteditable='true']"));
}

function refreshDashboard() {
  window.dispatchEvent(new Event("focus"));
}

function accountShells(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(":scope > .account-row-shell[data-account-id]"));
}

function cancelAnimations(shells: HTMLElement[]): void {
  for (const shell of shells) {
    for (const animation of shell.getAnimations()) animation.cancel();
  }
}

function animateLayout(
  list: HTMLElement,
  sourceAccountId: string,
  before: Map<string, number>,
): void {
  window.requestAnimationFrame(() => {
    const shells = accountShells(list);
    for (const shell of shells) {
      if (shell.dataset.accountId === sourceAccountId) continue;
      const previousTop = before.get(shell.dataset.accountId ?? "");
      if (previousTop == null) continue;
      const delta = previousTop - shell.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      for (const animation of shell.getAnimations()) animation.cancel();
      shell.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: REORDER_ANIMATION_MS, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  });
}

function setPreviewInsertion(
  drag: PointerDragState,
  sourceAccountId: string,
  requestedIndex: number,
): void {
  const withoutSource = drag.originalOrder.filter((accountId) => accountId !== sourceAccountId);
  const insertionIndex = Math.max(0, Math.min(withoutSource.length, requestedIndex));
  if (insertionIndex === drag.insertionIndex) return;

  const shells = accountShells(drag.listElement);
  const before = new Map(
    shells.map((shell) => [shell.dataset.accountId ?? "", shell.getBoundingClientRect().top]),
  );

  for (const shell of shells) {
    const accountId = shell.dataset.accountId;
    if (!accountId || accountId === sourceAccountId) continue;
    const compactIndex = withoutSource.indexOf(accountId);
    if (compactIndex < 0) continue;
    shell.style.order = String(compactIndex >= insertionIndex ? compactIndex + 1 : compactIndex);
  }

  drag.sourceShell.style.order = String(withoutSource.length + 1);
  if (drag.placeholder) drag.placeholder.style.order = String(insertionIndex);
  drag.insertionIndex = insertionIndex;
  animateLayout(drag.listElement, sourceAccountId, before);
}

function updatePreviewFromPointer(
  drag: PointerDragState,
  sourceAccountId: string,
  clientY: number,
): void {
  const listRect = drag.listElement.getBoundingClientRect();
  const withoutSource = drag.originalOrder.filter((accountId) => accountId !== sourceAccountId);
  const shellsById = new Map(
    accountShells(drag.listElement).map((shell) => [shell.dataset.accountId ?? "", shell]),
  );

  let insertionIndex = 0;
  for (const accountId of withoutSource) {
    const shell = shellsById.get(accountId);
    if (!shell) continue;
    const centerY = listRect.top + shell.offsetTop - drag.listElement.scrollTop + shell.offsetHeight / 2;
    if (clientY > centerY) insertionIndex += 1;
  }

  setPreviewInsertion(drag, sourceAccountId, insertionIndex);
}

function clearPreview(drag: PointerDragState): void {
  if (drag.autoScrollFrame != null) window.cancelAnimationFrame(drag.autoScrollFrame);
  const shells = accountShells(drag.listElement);
  cancelAnimations(shells);
  drag.listElement.classList.remove("reorder-previewing");
  drag.placeholder?.remove();
  drag.placeholder = null;

  for (const shell of shells) {
    shell.style.removeProperty("order");
  }

  drag.sourceShell.classList.remove("dragging-shell");
  drag.sourceShell.style.removeProperty("left");
  drag.sourceShell.style.removeProperty("top");
  drag.sourceShell.style.removeProperty("width");
  drag.sourceShell.style.removeProperty("height");
  drag.sourceShell.style.removeProperty("transform");
}

export function AccountRow({
  account,
  selected,
  busy,
  onSelect,
  onReconnect,
  onSettings,
  onMove,
}: {
  account: Account;
  selected: boolean;
  busy: string | null;
  onSelect: () => void;
  onRefresh: () => void;
  onReconnect: () => void;
  onRename: () => void;
  onRemove: () => void;
  onSettings: () => void;
  onMove: (sourceAccountId: string, targetAccountId: string) => void;
}) {
  const fiveHour = windowRemaining(account, "five_hour");
  const weekly = windowRemaining(account, "weekly");
  const state = account.authRequired ? "auth" : account.lastUsage?.freshness === "stale" ? "stale" : account.lastUsage ? "live" : "idle";
  const pointerDrag = useRef<PointerDragState | null>(null);
  const suppressClick = useRef(false);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const renameInFlight = useRef(false);
  const cancelRename = useRef(false);
  const [pointerDragging, setPointerDragging] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [renameValue, setRenameValue] = useState(account.label);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [customEmail, setCustomEmail] = useState(() => getCustomAccountEmail(account.id));

  useEffect(() => {
    if (!editingName) setRenameValue(account.label);
  }, [account.label, editingName]);

  useEffect(() => {
    if (!editingName) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [editingName]);

  useEffect(() => {
    const updateEmail = (event: Event) => {
      const accountId = (event as CustomEvent<{ accountId?: string }>).detail?.accountId;
      if (!accountId || accountId === account.id) setCustomEmail(getCustomAccountEmail(account.id));
    };
    window.addEventListener(ACCOUNT_METADATA_EVENT, updateEmail);
    return () => window.removeEventListener(ACCOUNT_METADATA_EVENT, updateEmail);
  }, [account.id]);

  const activate = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  const runAutoScroll = () => {
    const drag = pointerDrag.current;
    if (!drag?.started) return;

    const rect = drag.listElement.getBoundingClientRect();
    let delta = 0;
    if (drag.lastClientY < rect.top + AUTO_SCROLL_EDGE_PX) {
      const strength = 1 - Math.max(0, drag.lastClientY - rect.top) / AUTO_SCROLL_EDGE_PX;
      delta = -Math.max(4, Math.round(AUTO_SCROLL_MAX_STEP_PX * strength));
    } else if (drag.lastClientY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
      const strength = 1 - Math.max(0, rect.bottom - drag.lastClientY) / AUTO_SCROLL_EDGE_PX;
      delta = Math.max(4, Math.round(AUTO_SCROLL_MAX_STEP_PX * strength));
    }

    if (delta !== 0) {
      const previousScrollTop = drag.listElement.scrollTop;
      drag.listElement.scrollTop += delta;
      if (drag.listElement.scrollTop !== previousScrollTop) {
        updatePreviewFromPointer(drag, account.id, drag.lastClientY);
      }
    }

    drag.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  };

  const beginVisualDrag = (drag: PointerDragState) => {
    const sourceIndex = drag.originalOrder.indexOf(account.id);
    const rect = drag.sourceShell.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "account-row-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.style.height = `${rect.height}px`;
    drag.listElement.append(placeholder);
    drag.placeholder = placeholder;

    drag.listElement.classList.add("reorder-previewing");
    drag.sourceShell.classList.add("dragging-shell");
    drag.sourceShell.style.left = `${rect.left}px`;
    drag.sourceShell.style.top = `${rect.top}px`;
    drag.sourceShell.style.width = `${rect.width}px`;
    drag.sourceShell.style.height = `${rect.height}px`;
    setPointerDragging(true);
    setPreviewInsertion(drag, account.id, Math.max(0, sourceIndex));
    drag.autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
  };

  const startPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (busy != null || event.button !== 0 || isInteractiveTarget(event.target)) return;

    const listElement = event.currentTarget.closest<HTMLElement>(".account-list");
    const sourceShell = event.currentTarget.closest<HTMLElement>(".account-row-shell[data-account-id]");
    if (!listElement || !sourceShell) return;

    pointerDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastClientY: event.clientY,
      started: false,
      insertionIndex: -1,
      listElement,
      sourceShell,
      placeholder: null,
      originalOrder: accountShells(listElement)
        .map((shell) => shell.dataset.accountId)
        .filter((accountId): accountId is string => Boolean(accountId)),
      autoScrollFrame: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.started) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < DRAG_START_DISTANCE_PX) return;
      drag.started = true;
      beginVisualDrag(drag);
    }

    event.preventDefault();
    drag.lastClientY = event.clientY;
    const horizontalOffset = Math.max(-18, Math.min(18, event.clientX - drag.startX));
    drag.sourceShell.style.transform = `translate3d(${horizontalOffset}px, ${event.clientY - drag.startY}px, 0)`;
    updatePreviewFromPointer(drag, account.id, event.clientY);
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const didDrag = drag.started;
    const targetAccountId = commit && didDrag && drag.insertionIndex >= 0
      ? drag.originalOrder[drag.insertionIndex] ?? null
      : null;

    pointerDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!didDrag) return;

    event.preventDefault();
    event.stopPropagation();
    clearPreview(drag);
    setPointerDragging(false);
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);

    if (targetAccountId && targetAccountId !== account.id) {
      onMove(account.id, targetAccountId);
    }
  };

  const beginRename = () => {
    if (renameBusy) return;
    cancelRename.current = false;
    setRenameValue(account.label);
    setRenameError(null);
    setEditingName(true);
  };

  const commitRename = async () => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    if (renameInFlight.current) return;

    const label = renameValue.trim();
    if (!label) {
      setRenameError("Account name is required.");
      window.setTimeout(() => renameInput.current?.focus(), 0);
      return;
    }
    if (label === account.label) {
      setEditingName(false);
      setRenameError(null);
      return;
    }

    renameInFlight.current = true;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await bridgeApi.renameAccount(account.id, label);
      setEditingName(false);
      refreshDashboard();
    } catch (cause) {
      setRenameError(String(cause));
      window.setTimeout(() => renameInput.current?.focus(), 0);
    } finally {
      renameInFlight.current = false;
      setRenameBusy(false);
    }
  };

  const displayEmail = account.email ?? customEmail ?? providerName(account.provider);

  return (
    <div className={`account-row-shell ${selected ? "expanded" : ""}${pointerDragging ? " dragging-shell" : ""}`} data-account-id={account.id}>
      <div
        className={`account-row ${selected ? "selected" : ""}${pointerDragging ? " dragging" : ""}`}
        role="button"
        tabIndex={0}
        aria-expanded={selected}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onSelect();
        }}
        onKeyDown={activate}
        onPointerDown={startPointerDrag}
        onPointerMove={updatePointerDrag}
        onPointerUp={(event) => finishPointerDrag(event, true)}
        onPointerCancel={(event) => finishPointerDrag(event, false)}
      >
        <span className={`account-provider-icon state-${state}`}><ProviderIcon provider={account.provider} /></span>
        <span className="account-row-copy">
          <span className="account-name-line">
            {editingName ? (
              <input
                ref={renameInput}
                className="account-inline-name"
                value={renameValue}
                maxLength={80}
                disabled={renameBusy}
                aria-label={`Rename ${account.label}`}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename.current = true;
                    setRenameValue(account.label);
                    setRenameError(null);
                    setEditingName(false);
                  }
                }}
              />
            ) : <strong>{account.label}</strong>}
            <span className="account-name-actions">
              <button
                type="button"
                className="account-inline-action"
                aria-label={`Open settings for ${account.label}`}
                title="Account settings"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSettings();
                }}
              ><SettingsIcon /></button>
              <button
                type="button"
                className="account-inline-action"
                aria-label={`Edit ${account.label}`}
                title="Edit account name"
                disabled={renameBusy}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  beginRename();
                }}
              ><EditIcon /></button>
            </span>
          </span>
          <small>{displayEmail}</small>
          {renameError ? <small className="account-inline-error">{renameError}</small> : null}
        </span>
        <span className="account-row-meta">
          {fiveHour != null ? <RemainingStat label="H" value={fiveHour} /> : null}
          <RemainingStat label="W" value={weekly} />
        </span>
      </div>

      {selected && account.authRequired ? (
        <div className="account-reconnect-row">
          <button className="sidebar-action primary-action" onClick={onReconnect}><LinkIcon />Reconnect</button>
        </div>
      ) : null}
    </div>
  );
}
