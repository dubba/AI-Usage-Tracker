import { useEffect, useRef, useState } from "react";
import { errorMessage, friendlyMessage } from "../../shared/lib/errors";
import type { Account } from "../../types";

/**
 * Renaming an account's label in place on its card: the draft text, whether the field is shown,
 * and the inline error. `onRename` saves a new, trimmed, different label and rejects to show an
 * error under the name. A second save while one is running is ignored.
 */
export function useInlineAccountRename(account: Account, onRename: (label: string) => Promise<void>) {
  const [editing, setEditing] = useState(false);
  const [label, setLabelState] = useState(account.label);
  const [renameError, setRenameError] = useState<string | null>(null);
  const committingRef = useRef(false);

  // Follows the saved label (e.g. after a rename elsewhere) unless the user is typing.
  useEffect(() => {
    if (!editing) setLabelState(account.label);
  }, [account.label, editing]);

  const setLabel = (next: string) => {
    setLabelState(next);
    setRenameError(null);
  };

  const commit = async () => {
    const next = label.trim();
    if (!next) {
      setRenameError("Account name is required.");
      return;
    }
    if (next === account.label) {
      setEditing(false);
      setRenameError(null);
      return;
    }
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      await onRename(next);
      setEditing(false);
      setRenameError(null);
    } catch (cause) {
      setRenameError(friendlyMessage("Couldn't rename this account", errorMessage(cause)));
    } finally {
      committingRef.current = false;
    }
  };

  const cancel = () => {
    setLabelState(account.label);
    setRenameError(null);
    setEditing(false);
  };

  // Escape cancels the rename even when the field has lost focus. On a phone the back button
  // stands in for Escape: Android sends the key to whatever has focus, and once the keyboard has
  // been dismissed that is no longer the field, so the field's own key handler never sees it.
  // An open dialog or menu takes Escape for itself first.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      event.preventDefault();
      cancelRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  return { editing, startEditing: () => setEditing(true), label, setLabel, renameError, commit, cancel };
}
