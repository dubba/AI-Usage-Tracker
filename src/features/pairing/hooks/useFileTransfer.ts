import { useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import type { FilePreview } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import type { ViewMode } from "../lib/view-model";
import type { PairingActionContext } from "./usePairingSession";

/** Where the sender is in answering a request: agreeing to send, then the reply saved. */
export type FileSendState = { accountCount: number; replySaved: boolean };

/**
 * Transfer by file, for two devices that are not on one network. The receiver saves a request
 * for the code it typed and later opens the reply; the sender, while showing its code, opens the
 * request and saves the reply. Rust shows every open and save dialog and keeps the files between
 * steps, so these calls carry only counts and a ticket. A cancelled dialog changes nothing.
 */
export function useFileTransfer({
  context,
  includeSettings,
  showView,
}: {
  context: PairingActionContext;
  /** "Also Transfer Settings & Layout" on this device: what it sends, and what it accepts. */
  includeSettings: boolean;
  showView: (view: ViewMode) => void;
}) {
  const { request, setBusy, setStatus, setErrorMessage, showError } = context;
  const [sendState, setSendState] = useState<FileSendState | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);

  /**
   * Runs one step: busy while it runs, its answer dropped if the user moved on. Busy ends before
   * `then`, which may change the view and so end this request.
   */
  const step = async <T>(errorContext: string, run: () => Promise<T>, then: (value: T) => void) => {
    const ticket = request.begin();
    setBusy(true);
    setErrorMessage(null);
    let value: T;
    try {
      value = await run();
    } catch (cause) {
      if (request.isLatest(ticket)) {
        setBusy(false);
        showError(errorContext, cause);
      }
      return;
    }
    if (!request.isLatest(ticket)) return;
    setBusy(false);
    then(value);
  };

  return {
    sendState,
    preview,
    /** Receiver: save the request for `code`, then wait for the reply. */
    saveRequest: (code: string) =>
      step("Couldn't save the request", () => pairingApi.saveFileRequest(code), (saved) => {
        if (!saved) return;
        setPreview(null);
        showView("file-receive");
      }),
    /** Receiver: open the reply and show how many accounts it holds. */
    openReply: () =>
      step("Couldn't open the reply", () => pairingApi.openFileReply(), (opened) => {
        if (opened) setPreview(opened);
      }),
    /** Receiver, after its user agreed: add the accounts. */
    importReply: () => {
      const opened = preview;
      if (!opened) return Promise.resolve();
      return step(
        "Couldn't add the accounts",
        () => pairingApi.importFileReply(opened.ticket, includeSettings),
        (summary) => {
          setPreview(null);
          setStatus({ status: "completed", data: { summary } });
        },
      );
    },
    /** Sender: open a request for the code this device shows. */
    openRequest: () =>
      step("Couldn't open the request", () => pairingApi.openFileRequest(), (info) => {
        if (!info) return;
        setSendState({ accountCount: info.accountCount, replySaved: false });
        showView("file-send");
      }),
    /** Sender, after its user agreed: answer the request and save the reply. */
    saveReply: () =>
      step(
        "Couldn't save the reply",
        () => pairingApi.saveFileReply(includeSettings, includeSettings ? collectUiState() : undefined),
        (saved) => {
          if (saved) setSendState((current) => (current ? { ...current, replySaved: true } : current));
        },
      ),
    /** Forget both sides' screens (the dialog closed). */
    reset: () => {
      setSendState(null);
      setPreview(null);
    },
  };
}
