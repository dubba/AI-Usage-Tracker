import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { ACCOUNT_METADATA_EVENT, getCustomAccountEmail } from "../account-metadata";
import { bridgeApi } from "../api";
import type { Account, Provider, UsageWindow } from "../types";
import { EditIcon, LinkIcon, SettingsIcon } from "../icons";
import { ProviderIcon } from "./ProviderIcon";

const DRAG_START_DISTANCE_PX = 6;
const REORDER_ANIMATION_MS = 150;

type PointerDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  targetAccountId: string | null;
  targetElement: HTMLElement | null;
  listElement: HTMLElement | null;
  originalOrder: string[];
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

function clearPreviewOrder(drag: PointerDragState): void {
  drag.listElement?.classList.remove("reorder-previewing");
  for (const shell of accountShells(drag.listElement)) {
    shell.style.removeProperty("order");
    for (const animation of shell.getAnimations()) animation.cancel();
  }
}

function previewOrder(drag: PointerDragState, sourceAccountId: string, targetAccountId: string): void {
  const sourceIndex = drag.originalOrder.indexOf(sourceAccountId);
  const targetIndex = drag.originalOrder.indexOf(targetAccountId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

  const shells = accountShells(drag.listElement);
  const before = new Map(
    shells.map((shell) => [shell.dataset.accountId ?? "", shell.getBoundingClientRect().top]),
  );
  const reordered = [...drag.originalOrder];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);

  drag.listElement?.classList.add("reorder-previewing");
  for (const shell of shells) {
    const accountId = shell.dataset.accountId;
    const index = accountId ? reordered.indexOf(accountId) : -1;
    if (index >= 0) shell.style.order = String(index);
  }

  window.requestAnimationFrame(() => {
    for (const shell of shells) {
      if (shell.dataset.accountId === sourceAccountId) continue;
      const previousTop = before.get(shell.dataset.accountId ?? "");
      if (previousTop == null) continue;
      const delta = previousTop - shell.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      for (const animation of shell.getAnimations()) animation.cancel();
      shell.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: REORDER_ANIMATION_MS, easing: "ease-out" },
      );
    }
  });
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

  const clearDropTarget = () => {
    const drag = pointerDrag.current;
    if (!drag) return;
    drag.targetElement?.classList.remove("drop-target");
    drag.targetElement = null;
    drag.targetAccountId = null;
  };

  const startPointerDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (busy != null || event.button !== 0 || isInteractiveTarget(event.target)) return;

    const listElement = event.currentTarget.closest<HTMLElement>(".account-list");
    pointerDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetAccountId: null,
      targetElement: null,
      listElement,
      originalOrder: accountShells(listElement)
        .map((shell) => shell.dataset.accountId)
        .filter((accountId): accountId is string => Boolean(accountId)),
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
      setPointerDragging(true);
    }

    event.preventDefault();
    const targetElement = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".account-row-shell[data-account-id]") ?? null;
    const targetAccountId = targetElement?.dataset.accountId ?? null;

    if (targetAccountId === drag.targetAccountId) return;

    clearDropTarget();
    if (targetElement && targetAccountId && targetAccountId !== account.id) {
      targetElement.classList.add("drop-target");
      drag.targetElement = targetElement;
      drag.targetAccountId = targetAccountId;
      previewOrder(drag, account.id, targetAccountId);
    } else {
      clearPreviewOrder(drag);
    }
  };

  const finishPointerDrag = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const targetAccountId = commit && drag.started ? drag.targetAccountId : null;
    const didDrag = drag.started;
    clearDropTarget();
    pointerDrag.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (!didDrag) return;

    event.preventDefault();
    event.stopPropagation();
    setPointerDragging(false);
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);

    if (targetAccountId && targetAccountId !== account.id) {
      onMove(account.id, targetAccountId);
      window.requestAnimationFrame(() => clearPreviewOrder(drag));
    } else {
      clearPreviewOrder(drag);
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
    <div className={`account-row-shell ${selected ? "expanded" : ""}`} data-account-id={account.id}>
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
