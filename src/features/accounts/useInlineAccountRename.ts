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

  return { editing, startEditing: () => setEditing(true), label, setLabel, renameError, commit, cancel };
}
