import { useEffect, useRef, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import type { FilePreview, SyncSummary } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import type { ViewMode } from "../lib/view-model";
import type { PairingActionContext } from "./usePairingSession";

/** The sender's file: being made, then made and handed to the share menu. */
export type FileSendState = { made: boolean; automatic: boolean };

/**
 * Transfer by file, for two devices that are not on one network. The sender, with the link code
 * its user typed, makes one file holding the accounts encrypted with that code, and sends it
 * through the system share menu (AirDrop, Quick Share) or a save dialog; it can be sent again.
 * The receiver, showing the code, opens the file that arrives by itself (`useIncomingFile`,
 * `useTappedTransferFile`; the open dialog remains as a fallback) and adds its accounts at once.
 * Typing the code is the consent on one side, showing it on the other. Rust shows every menu and
 * dialog and keeps the files, so these calls carry only counts and a ticket.
 */
export function useFileTransfer({
  context,
  includeSettings,
  showView,
  onImported,
}: {
  context: PairingActionContext;
  /** "Also Sync Settings and Layout" on this device: what it sends, and what it accepts. */
  includeSettings: boolean;
  showView: (view: ViewMode) => void;
  /** The receiver added the accounts. */
  onImported: (summary: SyncSummary) => void;
}) {
  const { request, setBusy, setErrorMessage, showError } = context;
  const [sendState, setSendState] = useState<FileSendState | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  /** Whether this device has a share menu; until a file is made, assume not. */
  const [canShare, setCanShare] = useState(false);
  /** The code the last file was made for, to make it again after a failure. */
  const codeRef = useRef("");

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

  // A step started together with a change of view runs once that view is shown: the dialog clears
  // its error when the view changes, which would otherwise hide a quick failure of the step.
  const queuedRef = useRef<(() => void) | null>(null);
  const [queued, setQueued] = useState(0);
  const afterViewChange = (action: () => void) => {
    queuedRef.current = action;
    setQueued((count) => count + 1);
  };
  useEffect(() => {
    const action = queuedRef.current;
    queuedRef.current = null;
    action?.();
  }, [queued]);

  const share = () => step("Couldn't open the share menu", () => pairingApi.shareFile(), () => {});
  const save = () => step("Couldn't save the file", () => pairingApi.saveFile(), () => {});

  /** Sender: makes the file for the code typed last and sends it. */
  const makeFile = () =>
    step(
      "Couldn't make the file",
      () => pairingApi.sendFile(codeRef.current, includeSettings, includeSettings ? collectUiState() : undefined),
      (shareMenu) => {
        setCanShare(shareMenu);
        setSendState((current) => (current ? { ...current, made: true } : current));
        void (shareMenu ? share() : save());
      },
    );

  /**
   * Receiver: adds the accounts of the file that opened. The import uses the opened file up
   * whatever happens, so after a failure the other device sends it again to a new code.
   */
  const importOpened = (opened: FilePreview) => {
    setPreview(opened);
    showView("file-receive");
    afterViewChange(
      () =>
        void step(
          "Couldn't add the accounts",
          () => pairingApi.importFile(opened.ticket, includeSettings),
          (summary) => {
            setPreview(null);
            onImported(summary);
          },
        ),
    );
  };

  return {
    sendState,
    preview,
    canShare,
    /**
     * Sender: make the file for `code` and send it, which also stops looking for the other device
     * on the network. `automatic` when the Wi-Fi search found nothing, rather than the user
     * choosing AirDrop or Quick Share.
     */
    send: (code: string, automatic = false) => {
      codeRef.current = code;
      setSendState({ made: false, automatic });
      showView("file-send");
      afterViewChange(() => void makeFile());
    },
    /** Sender: make the file again and send it (after a failure). */
    sendAgain: () => void makeFile(),
    /** Shows the share menu again for the file made last. */
    share: () => void share(),
    /** Saves a copy of the file made last. */
    save: () => void save(),
    /** A file that arrived by itself (Downloads): add its accounts. */
    handleOpened: importOpened,
    /** Receiver: open the file by hand (the open dialog), then add its accounts. */
    openFile: () =>
      step("Couldn't open the file", () => pairingApi.openFile(), (opened) => {
        if (opened) importOpened(opened);
      }),
    /** Android and iPhone: open the file opened from another app, then add its accounts. */
    openTapped: () =>
      step("Couldn't open the file", () => pairingApi.openTappedFile(), (opened) => {
        if (opened) importOpened(opened);
      }),
    /** Forget both sides' screens (the dialog closed). */
    reset: () => {
      setSendState(null);
      setPreview(null);
      setCanShare(false);
      codeRef.current = "";
    },
  };
}
