import { useCallback, useRef } from "react";

/**
 * Shared modal close policy: the X button, Escape (via useModalA11y), the
 * backdrop, and any Cancel/Not now button all route through the returned
 * callback, so one guard decides whether closing is allowed (e.g. not while a
 * transfer is in progress). The guard is read when the callback runs, never
 * from a stale closure.
 *
 * Usage:
 *   const requestClose = useModalClosePolicy(!busy, closeModal);
 *   useModalA11y(dialogRef, open, requestClose);
 *   <div className="modal-backdrop" onMouseDown={backdropMouseDown(requestClose)} ...>
 */
export function useModalClosePolicy(canClose: boolean, onClose: () => void): () => void {
  const latest = useRef({ canClose, onClose });
  latest.current = { canClose, onClose };
  return useCallback(() => {
    if (latest.current.canClose) latest.current.onClose();
  }, []);
}

/**
 * Backdrop dismissal: close only when the press started on the backdrop
 * itself, not inside the dialog. Returns the onMouseDown handler.
 */
export function backdropMouseDown(requestClose: () => void) {
  return (event: React.MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) requestClose();
  };
}
