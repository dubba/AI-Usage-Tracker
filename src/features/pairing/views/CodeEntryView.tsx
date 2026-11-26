import { type ClipboardEvent, type KeyboardEvent, type MouseEvent, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  buildCodeSlots,
  cleanCode,
  codeLength,
  diffSingleInputEdit,
  formatCodeSlots,
  formattedOffsetForSlot,
  isCompleteCode,
  isLegacyCode,
  lastFilledSlotIndex,
  normalizeSlotChar,
  slotsHaveHoles,
  startsGroupInRow,
} from "../lib/view-model";

import { ArrowLeftIcon, WifiIcon } from "../../../shared/ui/icons";
import { isMobileDevice } from "../../../shared/lib/platform";
import { OtherWaysLink, SearchingRow } from "./HostCodeView";

/**
 * Finds the tile index at `(clientX, clientY)`, or the nearest tile on that row if the click
 * landed in the small gap between tiles. Returns `null` for synthetic `(0, 0)` clicks or points
 * outside the tile grid.
 */
function findTileIndexAtPoint(tiles: (HTMLSpanElement | null)[], clientX: number, clientY: number): number | null {
  if (clientX === 0 && clientY === 0) return null;
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i]?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) continue;
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return i;
    }
  }
  let bestIndex: number | null = null;
  let bestDist = Infinity;
  for (let i = 0; i < tiles.length; i++) {
    const rect = tiles[i]?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) continue;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      const dist = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
      if (dist < bestDist && dist <= 16) {
        bestDist = dist;
        bestIndex = i;
      }
    }
  }
  return bestIndex;
}

/**
 * Typing in the link code shown on the other device: twelve letters, or six digits from a device with
 * an older version. The last character connects by itself over Wi-Fi. For a twelve-letter code where
 * there is AirDrop or Quick Share, a search that finds no one sends the accounts that way by itself
 * (`PairingModal`).
 */
export function CodeEntryView({
  value,
  busy,
  onChange,
  allowLegacy,
  onSubmit,
  onBack,
  onOtherWays,
  nearbyName,
  fallback,
  setKeyboardOpen,
}: {
  value: string;
  busy: boolean;
  /** Receives the code as `cleanCode` leaves it. */
  onChange: (code: string) => void;
  /**
   * Whether an older version's six digits may be typed (Other ways to connect shown). Otherwise
   * digits are ignored, so a stray one never turns the field into six tiles.
   */
  allowLegacy: boolean;
  /** Connect with `code`, complete. */
  onSubmit: (code: string) => void;
  onBack: () => void;
  /** Lists the other ways to connect (older versions, QR code). Absent while Settings > Device Sync hides them. */
  onOtherWays?: () => void;
  /** "AirDrop" or "Quick Share" where the request can go that way; absent where it can't. */
  nearbyName?: string;
  /** While the Wi-Fi search runs: the seconds left in it. */
  fallback?: { secsLeft: number; totalSecs: number };
  /** Lets the field flag the on-screen keyboard before the viewport has resized. */
  setKeyboardOpen: (open: boolean) => void;
}) {
  const [slots, setSlots] = useState<string[]>(() => buildCodeSlots(value));
  const [syncedValue, setSyncedValue] = useState(value);
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const [, bumpCaret] = useReducer((n: number) => n + 1, 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const tileRefs = useRef<(HTMLSpanElement | null)[]>([]);

  if (value !== syncedValue) {
    setSyncedValue(value);
    if (slots.join("") !== value) {
      setSlots(buildCodeSlots(value));
      setCursorIndex(null);
    }
  }

  if (busy && cursorIndex !== null) {
    setCursorIndex(null);
  }

  const lastFilled = lastFilledSlotIndex(slots);
  const hasHoles = slotsHaveHoles(slots);
  const complete = !hasHoles && isCompleteCode(value);
  const legacy = isLegacyCode(value);
  const length = slots.length;
  const searching = busy && fallback != null;
  const defaultActiveIndex = complete ? -1 : Math.min(lastFilled + 1, length - 1);
  const activeTileIndex = busy ? -1 : (cursorIndex ?? defaultActiveIndex);
  const displayValue = formatCodeSlots(slots);
  // Only a twelve-letter code can go by file.
  const nearby = legacy ? undefined : nearbyName;

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || busy || document.activeElement !== el) return;
    const target = cursorIndex ?? Math.min(lastFilled + 1, length - 1);
    const pos = formattedOffsetForSlot(slots, target);
    if (el.selectionStart !== pos || el.selectionEnd !== pos) {
      el.setSelectionRange(pos, pos);
    }
  });

  function commitSlots(nextSlots: string[], nextCursor: number | null) {
    const nextCode = nextSlots.join("");
    const normalizedSlots = nextCode === "" ? buildCodeSlots("") : nextSlots;
    setSyncedValue(nextCode);
    setSlots(normalizedSlots);
    setCursorIndex(nextCursor);
    onChange(nextCode);
  }

  function syncCaretNow(targetSlots: string[], targetCursor: number | null) {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) return;
    const target = targetCursor ?? Math.min(lastFilledSlotIndex(targetSlots) + 1, targetSlots.length - 1);
    const pos = formattedOffsetForSlot(targetSlots, target);
    el.setSelectionRange(pos, pos);
  }

  function selectTile(rawIndex: number) {
    if (busy) return;
    const maxReachable = Math.min(lastFilled + 1, length - 1);
    const clamped = Math.max(0, Math.min(rawIndex, maxReachable));
    const nextCursor = !hasHoles && clamped === lastFilled + 1 ? null : clamped;
    setCursorIndex(nextCursor);
    const el = inputRef.current;
    if (el) {
      if (document.activeElement !== el) el.focus();
      syncCaretNow(slots, nextCursor);
    }
  }

  function applyTypedChar(rawChar: string) {
    const target = cursorIndex ?? Math.min(lastFilled + 1, length - 1);
    const normalized = normalizeSlotChar(rawChar, slots, target, allowLegacy);
    if (!normalized) {
      bumpCaret();
      return;
    }

    const onlyTargetFilled = slots.every((s, i) => i === target || s === "");
    const nextLength = onlyTargetFilled ? codeLength(normalized) : length;
    const nextSlots = Array.from({ length: nextLength }, (_, i) => slots[i] ?? "");
    nextSlots[target] = normalized;

    const nextLast = lastFilledSlotIndex(nextSlots);
    const nextHasHoles = slotsHaveHoles(nextSlots);
    const nextCursor =
      cursorIndex === null
        ? null
        : target + 1 >= nextLength || (!nextHasHoles && target + 1 > nextLast)
          ? null
          : target + 1;

    commitSlots(nextSlots, nextCursor);
    const nextCode = nextSlots.join("");
    if (!nextHasHoles && isCompleteCode(nextCode) && !isCompleteCode(value)) {
      onSubmit(nextCode);
    }
  }

  function applyBackspace() {
    if (cursorIndex === null) {
      if (lastFilled < 0) {
        bumpCaret();
        return;
      }
      const nextSlots = [...slots];
      nextSlots[lastFilled] = "";
      commitSlots(nextSlots, null);
      return;
    }

    if (slots[cursorIndex] !== "") {
      const nextSlots = [...slots];
      nextSlots[cursorIndex] = "";
      const nextHasHoles = slotsHaveHoles(nextSlots);
      const nextLast = lastFilledSlotIndex(nextSlots);
      const nextCursor = !nextHasHoles && cursorIndex >= nextLast + 1 ? null : cursorIndex;
      commitSlots(nextSlots, nextCursor);
      return;
    }

    if (cursorIndex === 0) {
      bumpCaret();
      return;
    }

    const prev = cursorIndex - 1;
    const nextSlots = [...slots];
    nextSlots[prev] = "";
    const nextHasHoles = slotsHaveHoles(nextSlots);
    const nextLast = lastFilledSlotIndex(nextSlots);
    commitSlots(nextSlots, !nextHasHoles && prev > nextLast ? null : prev);
  }

  function applyDelete() {
    if (cursorIndex === null) {
      bumpCaret();
      return;
    }
    if (slots[cursorIndex] !== "") {
      const nextSlots = [...slots];
      nextSlots[cursorIndex] = "";
      const nextHasHoles = slotsHaveHoles(nextSlots);
      const nextLast = lastFilledSlotIndex(nextSlots);
      commitSlots(nextSlots, !nextHasHoles && cursorIndex > nextLast ? null : cursorIndex);
      return;
    }
    if (cursorIndex + 1 < length && slots[cursorIndex + 1] !== "") {
      const nextSlots = [...slots];
      nextSlots[cursorIndex + 1] = "";
      commitSlots(nextSlots, cursorIndex);
    }
  }

  function handleInputChange(nextRaw: string) {
    if (cursorIndex === null && !hasHoles) {
      const code = cleanCode(nextRaw, allowLegacy);
      commitSlots(buildCodeSlots(code), null);
      // The last character connects: there is nothing else to decide.
      if (isCompleteCode(code) && !isCompleteCode(value)) onSubmit(code);
      return;
    }

    const edit = diffSingleInputEdit(displayValue, nextRaw);
    if (edit?.kind === "insert" || edit?.kind === "replace") {
      applyTypedChar(edit.char);
      return;
    }
    if (edit?.kind === "delete") {
      applyBackspace();
      return;
    }

    const code = cleanCode(nextRaw, allowLegacy);
    commitSlots(buildCodeSlots(code), null);
    if (isCompleteCode(code) && !isCompleteCode(value)) onSubmit(code);
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData?.getData("text") ?? "";
    const cleaned = cleanCode(pasted, allowLegacy);
    if (!cleaned) return;

    if (isCompleteCode(cleaned)) {
      event.preventDefault();
      commitSlots(buildCodeSlots(cleaned), null);
      if (!isCompleteCode(value)) onSubmit(cleaned);
      return;
    }

    if (cursorIndex !== null) {
      event.preventDefault();
      let pos = cursorIndex;
      const nextSlots = [...slots];
      for (const ch of pasted) {
        if (pos >= nextSlots.length) break;
        const normalized = normalizeSlotChar(ch, nextSlots, pos, allowLegacy);
        if (!normalized) continue;
        nextSlots[pos] = normalized;
        pos++;
      }
      const nextLast = lastFilledSlotIndex(nextSlots);
      const nextHasHoles = slotsHaveHoles(nextSlots);
      const nextCursor = pos >= nextSlots.length || (!nextHasHoles && pos > nextLast) ? null : pos;
      commitSlots(nextSlots, nextCursor);
      const nextCode = nextSlots.join("");
      if (!nextHasHoles && isCompleteCode(nextCode) && !isCompleteCode(value)) {
        onSubmit(nextCode);
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && complete) {
      onSubmit(value);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const current = cursorIndex ?? Math.min(lastFilled + 1, length - 1);
      setCursorIndex(Math.max(0, current - 1));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (cursorIndex === null) return;
      const maxReachable = Math.min(lastFilled + 1, length - 1);
      const next = cursorIndex + 1;
      setCursorIndex(!hasHoles && next >= maxReachable ? null : Math.min(next, maxReachable));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setCursorIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setCursorIndex(hasHoles ? Math.min(lastFilled + 1, length - 1) : null);
      return;
    }
    if (event.key === "Backspace" && (cursorIndex !== null || hasHoles)) {
      event.preventDefault();
      applyBackspace();
      return;
    }
    if (event.key === "Delete" && (cursorIndex !== null || hasHoles)) {
      event.preventDefault();
      applyDelete();
    }
  }

  function handleInputClick(event: MouseEvent<HTMLInputElement>) {
    const hit = findTileIndexAtPoint(tileRefs.current, event.clientX, event.clientY);
    if (hit !== null) {
      selectTile(hit);
    }
  }

  return (
    <div className="pairing-code-entry-view">
      {/* In the same card as the code it is copied from (HostCodeView). */}
      <div className="pairing-code-hero pairing-code-entry-hero">
        <span className="pairing-code-hero-tag" aria-hidden="true">
          Enter link code
        </span>
        <label className={`pairing-code-tiles${busy ? " is-busy" : ""}${legacy ? "" : " is-long"}`}>
          <input
            ref={inputRef}
            id="pairing-join-code-input"
            aria-label="Link code"
            className="pairing-code-input"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            value={displayValue}
            autoFocus
            disabled={busy}
            onFocus={() => {
              if (isMobileDevice()) setKeyboardOpen(true);
            }}
            onBlur={() => {
              setTimeout(() => {
                const activeEl = document.activeElement;
                if (activeEl?.id !== "pairing-join-code-input") {
                  const vv = window.visualViewport;
                  if (!vv || window.innerHeight - vv.height <= 100) {
                    setKeyboardOpen(false);
                  }
                }
              }, 120);
            }}
            onClick={handleInputClick}
            onPaste={handlePaste}
            onChange={(event) => handleInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-describedby="pairing-code-help"
          />
          {slots.map((digit, index) => (
            <span
              key={index}
              ref={(el) => {
                tileRefs.current[index] = el;
              }}
              aria-hidden="true"
              onClick={() => selectTile(index)}
              className={`pairing-code-tile${digit ? " is-filled" : ""}${
                index === activeTileIndex ? " is-active" : ""
              }${startsGroupInRow(index) ? " group-start" : ""}`}
            >
              {digit}
            </span>
          ))}
        </label>

        <div id="pairing-code-help" className="pairing-code-status">
          {searching ? (
            fallback.secsLeft > 0 ? (
              <>
                <SearchingRow>Looking for the other device on Wi-Fi…</SearchingRow>
                <div className="pairing-fallback-track" aria-hidden="true">
                  <div
                    className="pairing-fallback-fill"
                    style={{ transform: `scaleX(${1 - fallback.secsLeft / fallback.totalSecs})` }}
                  />
                </div>
                <p className="pairing-code-help">
                  If not found within <strong>{fallback.secsLeft} {fallback.secsLeft === 1 ? "second" : "seconds"}</strong>,{" "}
                  <strong>{nearby}</strong> will be used instead.
                </p>
              </>
            ) : (
              <SearchingRow>Finishing the search on Wi-Fi…</SearchingRow>
            )
          ) : busy ? (
            <SearchingRow>Looking for the other device on Wi-Fi…</SearchingRow>
          ) : (
            <p className="pairing-code-help pairing-code-help-footer">
              <WifiIcon className="pairing-code-help-icon" />
              <span>
                {legacy ? (
                  "A 6-digit code from an older version connects over Wi-Fi only."
                ) : nearby ? (
                  <>
                    Connects over Wi-Fi or hotspot, with <strong>{nearby}</strong> as a fallback.
                  </>
                ) : (
                  "Both devices must be connected to the same Wi-Fi network."
                )}
              </span>
            </p>
          )}
        </div>
      </div>

      {onOtherWays ? <OtherWaysLink disabled={busy && !searching} onClick={onOtherWays} /> : null}

      <div className="pairing-scanner-controls pairing-code-actions">
        <button type="button" className="button ghost button-tertiary pairing-back-btn" onClick={onBack}>
          <ArrowLeftIcon />
          <span>Back</span>
        </button>
        <button type="button" className="button primary" disabled={busy || !complete} onClick={() => onSubmit(value)}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}
