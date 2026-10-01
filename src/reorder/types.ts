import type { Provider } from "../types";
import type { InlineDisplay } from "./reorder-source";

export type DragDescriptor =
  | { kind: "group"; groupId: string; provider: Provider; source: HTMLElement }
  | { kind: "account"; accountId: string; provider: Provider; source: HTMLElement };

export type PointerCandidate = {
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  drag: DragDescriptor;
  longPressTimer: number | null;
  isInteractive?: boolean;
};

export type ActiveDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  lastClientX: number;
  lastClientY: number;
  /** Where the pointer sits inside the floating copy, measured from its top edge. */
  floatGrabY: number;
  floatHeight: number;
  descriptor: DragDescriptor;
  container: HTMLElement;
  scrollContainer: HTMLElement;
  source: HTMLElement;
  float: HTMLElement;
  placeholder: HTMLElement;
  originalNextSibling: ChildNode | null;
  originalDisplay: InlineDisplay;
  originalOrder: string[];
  autoScrollFrame: number | null;
};
