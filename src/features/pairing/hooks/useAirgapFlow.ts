import { useCallback, useState, type MutableRefObject } from "react";
import { pairingApi } from "../../../shared/lib/api";
import { describeError } from "../../../shared/lib/errors";
import type { AirgapExport, PairingStatus } from "../../../types";
import { collectUiState } from "../../dashboard/ui-state";
import type { PairingActionContext } from "./usePairingSession";
import type { useAirgapCapture } from "./useAirgapCapture";
import { useAirgapPlayer } from "./useAirgapPlayer";

/**
 * The two ends of an air-gap transfer that live in the dialog: the sender's export (the animated
 * code, prepared by the backend and played back by `player`), and the receiver's import of the
 * frames `capture` collected. Sets the "completed" status itself after an import.
 */
export function useAirgapFlow({
  context,
  senderViewActive,
  includeSettings,
  capture,
  stopCamera,
  showView,
  setAirgapPrepareError,
  setStatus,
  hasCompletedRef,
  onCompleted,
}: {
  context: PairingActionContext;
  /** The sender's code is on screen, so the player should run. */
  senderViewActive: boolean;
  includeSettings: boolean;
  capture: ReturnType<typeof useAirgapCapture>;
  stopCamera: () => void;
  showView: (view: "airgap-sender") => void;
  setAirgapPrepareError: (message: string | null) => void;
  setStatus: (status: PairingStatus) => void;
  hasCompletedRef: MutableRefObject<boolean>;
  onCompleted: () => void;
}) {
  const { request, setBusy, setErrorMessage, showError } = context;
  const [airgapExport, setAirgapExport] = useState<AirgapExport | null>(null);
  const player = useAirgapPlayer(airgapExport, senderViewActive);
  const clearExport = useCallback(() => setAirgapExport(null), []);

  /** Prepare the export and start showing it. `includeSettingsOpt` overrides the checkbox. */
  const startAirgapSender = async (includeSettingsOpt?: boolean) => {
    stopCamera();
    showView("airgap-sender");
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    setAirgapPrepareError(null);
    try {
      const shouldInclude = includeSettingsOpt ?? includeSettings;
      const ui = shouldInclude ? collectUiState() : undefined;
      const exp = await pairingApi.prepareAirgapExport(shouldInclude, ui);
      if (!request.isLatest(ticket)) return;
      setAirgapExport(exp);
      player.restart();
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      setAirgapPrepareError(describeError("pairing", "Couldn't prepare the transfer", err));
    } finally {
      if (request.isLatest(ticket)) {
        setBusy(false);
      }
    }
  };

  /** Import the captured frames once the receiver has confirmed the codes match. */
  const handleAirgapImport = async () => {
    if (capture.importing || !capture.verifyCode) return;
    const ticket = request.begin();
    capture.setImporting(true);
    setErrorMessage(null);
    try {
      const chunks = Array.from(capture.chunks.values());
      const summary = await pairingApi.importAirgapFrames(chunks);
      if (!request.isLatest(ticket)) return;
      hasCompletedRef.current = true;
      capture.closePrompt();
      stopCamera();
      setStatus({
        status: "completed",
        data: { summary },
      });
      onCompleted();
    } catch (err) {
      if (!request.isLatest(ticket)) return;
      showError("Couldn't import the accounts", err);
    } finally {
      if (request.isLatest(ticket)) {
        capture.setImporting(false);
      }
    }
  };

  return {
    airgapExport,
    clearExport,
    player,
    startAirgapSender,
    handleAirgapImport,
  };
}
