import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { logIgnored } from "../../../shared/lib/log";
import type { useLatestRequest } from "../../../shared/hooks/useLatestRequest";
import type { PairingStatus } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import { cleanCode, isCompleteCode, type IntendedRole } from "../lib/view-model";

/** A failure the backend marked `not_found`: the search for the code found no device. */
function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "not_found";
}

/** What the session actions share with the dialog around them. */
export interface PairingActionContext {
  request: ReturnType<typeof useLatestRequest>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setStatus: Dispatch<SetStateAction<PairingStatus>>;
  setErrorMessage: (message: string | null) => void;
  /** Shows a friendly error under the dialog (what was being done, then the cause). */
  showError: (context: string, cause: unknown) => void;
}

/**
 * The calls that start and steer a Wi-Fi pairing session: show a link code (host), join with a
 * code, apply the send/receive role, and confirm the transfer. Each begins a
 * request on `context.request`, so an answer that arrives after the user moved on is dropped.
 */
export function usePairingSession({
  context,
  roleAutoSelectedRef,
  includeSettings,
  setConfirmed,
}: {
  context: PairingActionContext;
  roleAutoSelectedRef: MutableRefObject<boolean>;
  /** "Also Sync Settings and Layout" on this device: what it sends, and what it accepts. */
  includeSettings: boolean;
  setConfirmed: (confirmed: boolean) => void;
}) {
  const { request, busy, setBusy, setStatus, setErrorMessage, showError } = context;

  /** Start showing a link code for the other device to type; six digits for an older version when `legacy`. */
  const initHostSession = async (legacy = false) => {
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    try {
      const init = await pairingApi.startHost(includeSettings, legacy);
      if (!request.isLatest(ticket)) return;
      setStatus({
        status: "hostWaiting",
        data: {
          sessionId: init.sessionId,
          joinCode: init.joinCode,
          expiresAt: init.expiresAt,
        },
      });
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      showError("Couldn't start the pairing session", err);
    } finally {
      if (request.isLatest(ticket)) setBusy(false);
    }
  };

  /**
   * Join the session whose link code was typed. `onUnreachable` gets a search that found no one on
   * the network (the backend's `not_found`) and, if it handles it (returns true), replaces the error
   * message. Any other failure is shown as it is.
   */
  const handleConnectByCode = async (typed: string, onUnreachable?: () => boolean) => {
    const code = cleanCode(typed);
    if (!isCompleteCode(code) || busy) return;
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.startClientByCode(code, includeSettings);
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      if (isNotFound(err) && onUnreachable?.()) return;
      showError("Couldn't connect with that code", err);
    } finally {
      if (request.isLatest(ticket)) {
        setBusy(false);
      }
    }
  };

  const handleSelectRole = async (role: IntendedRole) => {
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.selectRole(role);
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      showError("Couldn't apply the send or receive role", err);
      roleAutoSelectedRef.current = false;
      setBusy(false);
    }
  };

  /** Confirm or decline the transfer on either the sending or receiving device. */
  const handleConfirmTransfer = async (sessionId: string, confirmed: boolean, isSender = true) => {
    if (confirmed) {
      setConfirmed(true);
    }
    const ticket = request.begin();
    setBusy(true);
    try {
      if (confirmed && isSender) {
        try {
          await pairingApi.setIncludeSettings(includeSettings);
          if (includeSettings) {
            await pairingApi.setPendingUiState(collectUiState());
          } else {
            await pairingApi.clearPendingUiState();
          }
        } catch (cause) {
          // Pairing can still complete; the other device just won't receive settings or layout.
          logIgnored("pairing settings transfer", cause);
        }
      }
      await pairingApi.confirmTransfer(sessionId, confirmed);
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      showError("Couldn't start the transfer", err);
      setConfirmed(false);
    } finally {
      if (request.isLatest(ticket)) {
        setBusy(false);
      }
    }
  };

  return { initHostSession, handleConnectByCode, handleSelectRole, handleConfirmTransfer };
}
