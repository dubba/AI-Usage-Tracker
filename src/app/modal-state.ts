import type { Account, AccountBucket, Provider } from "../types";

/**
 * The one dialog open over the dashboard, with what it needs. Opening a dialog replaces whichever
 * was open, so two can never be on screen at once. (Pairing keeps its own state because deep
 * links open it from outside the UI.)
 */
export type ModalState =
  | null
  | { kind: "add"; label: string; provider: Provider | undefined }
  | { kind: "bucket"; bucket: AccountBucket | null; provider: Provider | null; confirmDelete: boolean }
  | { kind: "alert"; account: Account }
  | { kind: "remove"; account: Account }
  | { kind: "googleUsage"; account: Account };

export type ModalKind = NonNullable<ModalState>["kind"];

export type ModalAction =
  | { type: "open"; modal: NonNullable<ModalState> }
  /** Closes whatever is open, or only a dialog of `kind` so a late close can't dismiss a newer one. */
  | { type: "close"; kind?: ModalKind };

export function modalReducer(state: ModalState, action: ModalAction): ModalState {
  switch (action.type) {
    case "open":
      return action.modal;
    case "close":
      if (action.kind && state?.kind !== action.kind) return state;
      return null;
  }
}
