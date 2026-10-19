import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { describeError } from "../../../shared/lib/errors";
import { logIgnored } from "../../../shared/lib/log";
import type { useLatestRequest } from "../../../shared/hooks/useLatestRequest";
import type { PairingStatus } from "../../../types";
import { collectUiState } from "../../dashboard/ui-state";
import type { FlowAction } from "../lib/flow-state";
import { PAIRING_CODE_LENGTH, type IntendedRole } from "../lib/view-model";

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
 * code or a pairing link, apply the send/receive role, and confirm the codes. Each begins a
 * request on `context.request`, so an answer that arrives after the user moved on is dropped.
 */
export function usePairingSession({
  context,
  dispatchFlow,
  joinUriRef,
  roleAutoSelectedRef,
  includeSettings,
  setConfirmedSas,
}: {
  context: PairingActionContext;
  dispatchFlow: Dispatch<FlowAction>;
  /** The link this session joined through, so "Try Again" can repeat the join. */
  joinUriRef: MutableRefObject<string | null>;
  roleAutoSelectedRef: MutableRefObject<boolean>;
  includeSettings: boolean;
  setConfirmedSas: (confirmed: boolean) => void;
}) {
  const { request, busy, setBusy, setStatus, setErrorMessage, showError } = context;

  /** Start showing a link code and a QR code for the other device to join. */
  const initHostSession = async () => {
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    try {
      const init = await pairingApi.startHost();
      if (!request.isLatest(ticket)) return;
      setStatus({
        status: "hostWaiting",
        data: {
          sessionId: init.sessionId,
          qrSvg: init.qrSvg,
          qrUri: init.qrUri,
          fingerprint: init.fingerprint,
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

  /** Join a session from a pairing link: a deep link, or one handed to the modal on open. */
  const startFromUri = useCallback(
    async (pendingUri: string) => {
      joinUriRef.current = pendingUri;
      const ticket = request.begin();
      dispatchFlow({ type: "set-flow", flow: "wifi" });
      setBusy(true);
      setStatus({ status: "clientConnecting", data: { sessionId: "" } });
      try {
        await pairingApi.startClient(pendingUri);
      } catch (err) {
        if (!request.isLatest(ticket)) return;
        setBusy(false);
        const msg = describeError("pairing", "Couldn't connect with the link", err);
        setErrorMessage(msg);
        setStatus({
          status: "failed",
          data: { error: msg },
        });
      }
    },
    [joinUriRef, request, dispatchFlow, setBusy, setStatus, setErrorMessage],
  );

  /** Join the session whose six-digit link code was typed. */
  const handleConnectByCode = async (code: string) => {
    const digits = code.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH);
    if (digits.length !== PAIRING_CODE_LENGTH || busy) return;
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    try {
      await pairingApi.startClientByCode(digits);
    } catch (err) {
      if (!request.isLatest(ticket)) return;
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

  const handleConfirmSas = async (sessionId: string, confirmed: boolean, role?: string) => {
    if (confirmed) {
      setConfirmedSas(true);
    }
    const ticket = request.begin();
    setBusy(true);
    try {
      if (confirmed) {
        const shouldInclude = role === "sender" && includeSettings;
        try {
          await pairingApi.setIncludeSettings(shouldInclude);
          if (shouldInclude) {
            await pairingApi.setPendingUiState(collectUiState());
          } else {
            await pairingApi.clearPendingUiState();
          }
        } catch (cause) {
          // Pairing can still complete; the other device just won't receive settings or layout.
          logIgnored("pairing settings transfer", cause);
        }
      }
      await pairingApi.confirmSas(sessionId, confirmed);
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      showError("Couldn't confirm the codes", err);
      setConfirmedSas(false);
    } finally {
      if (request.isLatest(ticket)) {
        setBusy(false);
      }
    }
  };

  return { initHostSession, startFromUri, handleConnectByCode, handleSelectRole, handleConfirmSas };
}
