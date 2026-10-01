/**
 * A short rolling record of the most recent drag gestures, included in "Copy
 * diagnostics" so a drag-and-drop problem can be diagnosed from a bug report.
 *
 * It holds event types, timings, rounded positions, card positions in the list
 * and DOM checks only. Never pass account names, emails or ids in here: cards
 * are described by their index in the list.
 */

const MAX_GESTURES = 10;
const MAX_LINES_PER_GESTURE = 160;

type Gesture = { startedAt: number; lines: string[]; dropped: number };

const gestures: Gesture[] = [];

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Starts a new gesture section; older gestures beyond the limit are discarded. */
export function traceGestureStart(summary: string): void {
  gestures.push({ startedAt: now(), lines: [], dropped: 0 });
  while (gestures.length > MAX_GESTURES) gestures.shift();
  trace(summary);
}

/** Adds one line to the current gesture, prefixed with milliseconds since it started. */
export function trace(line: string): void {
  if (gestures.length === 0) gestures.push({ startedAt: now(), lines: [], dropped: 0 });
  addLine(gestures[gestures.length - 1], line);
}

/**
 * Returns a tracer tied to the gesture that is current right now, for lines
 * written later from a timer. Without it a delayed line would land under
 * whichever gesture happens to be newest by then.
 */
export function traceForCurrentGesture(): (line: string) => void {
  if (gestures.length === 0) gestures.push({ startedAt: now(), lines: [], dropped: 0 });
  const gesture = gestures[gestures.length - 1];
  return (line) => addLine(gesture, line);
}

function addLine(gesture: Gesture, line: string): void {
  if (gesture.lines.length >= MAX_LINES_PER_GESTURE) {
    // Keep the start and the end of a long gesture; the middle is the least useful part.
    gesture.lines.splice(MAX_LINES_PER_GESTURE / 2, 1);
    gesture.dropped += 1;
  }
  gesture.lines.push(`${String(Math.round(now() - gesture.startedAt)).padStart(6)} ${line}`);
}

export function formatDragTrace(): string {
  if (gestures.length === 0) return "Drag trace: no drag recorded since the app started.";
  const sections = gestures.map((gesture, index) => {
    const header = `--- gesture ${index + 1} of ${gestures.length}${gesture.dropped ? ` (${gesture.dropped} middle lines dropped)` : ""} ---`;
    return [header, ...gesture.lines].join("\n");
  });
  return ["Drag trace (oldest first, ms since gesture start):", ...sections].join("\n");
}

/** Test hook. */
export function resetDragTrace(): void {
  gestures.length = 0;
}

/** Rounded coordinate, or "?" when the event has none. */
export function coord(value: number | undefined | null): string {
  return value == null || !Number.isFinite(value) ? "?" : String(Math.round(value));
}

/**
 * Names what an event landed on without revealing content: which kind of
 * element it is, and whether it sits inside the card being dragged.
 */
export function describeTarget(target: EventTarget | null, source?: Element | null): string {
  if (typeof Element === "undefined" || !(target instanceof Element)) return target ? "non-element" : "none";
  const inSource = source ? (source === target || source.contains(target) ? " in-source" : "") : "";
  const detached = target.isConnected ? "" : " DETACHED";
  if (target.closest(".dashboard-reorder-float")) return `float${detached}`;
  if (target.closest(".dashboard-reorder-placeholder")) return `placeholder${detached}`;
  const card = target.closest(".provider-account-card");
  if (card) return `${card === target ? "card" : "card-child"}${inSource}${detached}`;
  if (target.closest(".provider-summary-row")) return `sidebar-row${detached}`;
  if (target.closest(".mockup-summary-card")) return `summary-card${detached}`;
  if (target.closest(".provider-account-cards")) return `list-gap${detached}`;
  if (target.closest(".mockup-summary-grid")) return `summary-gap${detached}`;
  if (target.closest(".dashboard-scroll")) return `dashboard-gap${detached}`;
  return `${target.tagName.toLowerCase()}${detached}`;
}
