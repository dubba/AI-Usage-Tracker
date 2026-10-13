import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModalAction, ModalState } from "../../app/modal-state";
import { bridgeApi } from "../../shared/lib/api";
import { logIgnored } from "../../shared/lib/log";
import type { DashboardSnapshot } from "../../types";
import { unprotectedPromptKey } from "../dashboard/credential-protection";
import type { UnprotectedSignInsBusy } from "./UnprotectedSignInsModal";

const REMOVE_ERROR_SOURCE = "remove-unprotected";

/**
 * Drives the prompt about saved sign-ins that could not be encrypted (Android).
 * It opens by itself when such accounts appear and no other dialog is open,
 * stays closed after "Not now" until the set of accounts changes, and closes
 * once every sign-in is encrypted.
 */
export function useUnprotectedSignIns({
  snapshot,
  load,
  modal,
  dispatchModal,
  reportError,
  clearError,
}: {
  snapshot: DashboardSnapshot | null;
  load: () => Promise<DashboardSnapshot | null>;
  modal: ModalState;
  dispatchModal: (action: ModalAction) => void;
  reportError: (source: string, cause: unknown, context?: string) => void;
  clearError: (source: string) => void;
}) {
  const [busy, setBusy] = useState<UnprotectedSignInsBusy>(null);
  const [retryFailed, setRetryFailed] = useState(false);
  const dismissedKeyRef = useRef<string | null>(null);
  const ids = snapshot?.unprotectedAccountIds;
  const key = unprotectedPromptKey(ids);
  const accounts = useMemo(
    () => (ids?.length ? (snapshot?.accounts ?? []).filter((account) => ids.includes(account.id)) : []),
    [ids, snapshot?.accounts],
  );

  useEffect(() => {
    if (key == null) {
      dismissedKeyRef.current = null;
      setRetryFailed(false);
      dispatchModal({ type: "close", kind: "unprotected" });
      return;
    }
    if (modal == null && key !== dismissedKeyRef.current) {
      dispatchModal({ type: "open", modal: { kind: "unprotected" } });
    }
  }, [key, modal, dispatchModal]);

  const dismiss = useCallback(() => {
    dismissedKeyRef.current = key;
    setRetryFailed(false);
    dispatchModal({ type: "close", kind: "unprotected" });
  }, [key, dispatchModal]);

  /** Tries the encryption again (each snapshot load does), then resumes the accounts it fixed. */
  const retry = useCallback(async () => {
    const before = ids ?? [];
    setBusy("retry");
    try {
      const next = await load();
      const still = next?.unprotectedAccountIds ?? before;
      const fixed = before.filter((id) => !still.includes(id));
      if (fixed.length > 0) {
        await Promise.all(fixed.map((id) => bridgeApi.refreshAccount(id).catch((cause) => logIgnored("retry-unprotected", cause))));
        await load();
      }
      setRetryFailed(still.length > 0);
    } finally {
      setBusy(null);
    }
  }, [ids, load]);

  /** Removes the affected accounts and opens Add Account for the first, to sign in again. */
  const remove = useCallback(async () => {
    const first = accounts[0];
    setBusy("remove");
    try {
      await bridgeApi.removeUnprotectedAccounts();
      clearError(REMOVE_ERROR_SOURCE);
      await load();
      // A fresh sign-in, not a reconnect: the removed account no longer exists.
      if (first) dispatchModal({ type: "open", modal: { kind: "add", label: first.label, provider: first.provider } });
      else dispatchModal({ type: "close", kind: "unprotected" });
    } catch (cause) {
      reportError(REMOVE_ERROR_SOURCE, cause, "Couldn't remove the accounts");
    } finally {
      setBusy(null);
    }
  }, [accounts, clearError, dispatchModal, load, reportError]);

  return {
    accounts: modal?.kind === "unprotected" && accounts.length > 0 ? accounts : null,
    busy,
    retryFailed,
    retry,
    remove,
    dismiss,
  };
}
