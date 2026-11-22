import type { HintKind } from "../lib/storage";
import { CloseIcon } from "./icons";

const HINT_TEXT: Record<HintKind, { text: string; dismissLabel: string }> = {
  reorder: {
    text: "Press & drag a card below or in the sidebar to reorder",
    dismissLabel: "Dismiss reorder hint",
  },
  "pull-refresh": {
    text: "Pull down on the screen to refresh data",
    dismissLabel: "Dismiss pull-to-refresh hint",
  },
};

/** The banner of an onboarding hint (`useSessionHint`), with its dismiss button. */
export function HintBanner({ kind, onDismiss }: { kind: HintKind; onDismiss: () => void }) {
  const { text, dismissLabel } = HINT_TEXT[kind];
  return (
    <div className={`${kind}-hint-banner`} role="note">
      <span>{text}</span>
      <button type="button" className={`${kind}-hint-dismiss`} onClick={onDismiss} aria-label={dismissLabel}>
        <CloseIcon />
      </button>
    </div>
  );
}
