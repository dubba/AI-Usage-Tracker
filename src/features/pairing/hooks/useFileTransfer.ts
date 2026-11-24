import { useEffect, useRef, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import type { FilePreview, TappedFile } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import type { ViewMode } from "../lib/view-model";
import type { PairingActionContext } from "./usePairingSession";

/** Where the sender is in answering a request: making the reply, then the reply sent. */
export type FileSendState = { accountCount: number; replyMade: boolean };

/**
 * Transfer by file, for two devices that are not on one network. The receiver makes a request
 * for the code it typed; the sender, while showing its code, answers it with a reply at once; the
 * receiver adds the reply's accounts at once. Typing the code is the consent: the reply opens only
 * with it. Each file, once made, goes out through the system share menu (AirDrop, Quick Share) or a
 * save dialog, and can be sent again. Incoming files arrive by themselves (`useIncomingFile`,
 * `useTappedTransferFile`) and go to `handleOpened`; the open dialogs remain as a fallback. Rust
 * shows every menu and dialog and keeps the files between steps, so these calls carry only counts
 * and a ticket.
 */
export function useFileTransfer({
  context,
  includeSettings,
  showView,
}: {
  context: PairingActionContext;
  /** "Also Sync Settings and Layout" on this device: what it sends, and what it accepts. */
  includeSettings: boolean;
  showView: (view: ViewMode) => void;
}) {
  const { request, setBusy, setStatus, setErrorMessage, showError } = context;
  const [sendState, setSendState] = useState<FileSendState | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  /** Whether the request went out by itself because the Wi-Fi search found nothing. */
  const [requestedAutomatically, setRequestedAutomatically] = useState(false);
  /** Whether the reply's open dialog is the step running, so only its button says "Opening…". */
  const [openingReply, setOpeningReply] = useState(false);
  /** Whether this device has a share menu; until a file is made, assume not. */
  const [canShare, setCanShare] = useState(false);

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
  /** Sends the file just made: the share menu if there is one, otherwise the save dialog. */
  const deliver = (shareMenu: boolean) => void (shareMenu ? share() : save());

  /**
   * Receiver: adds the accounts of the reply that opened. The import uses the opened reply up
   * whatever happens, so after a failure the user starts again.
   */
  const importPreview = (opened: FilePreview) => {
    setPreview(opened);
    showView("file-receive");
    afterViewChange(
      () =>
        void step(
          "Couldn't add the accounts",
          () => pairingApi.importFileReply(opened.ticket, includeSettings),
          (summary) => {
            setPreview(null);
            setStatus({ status: "completed", data: { summary } });
          },
        ),
    );
  };

  /** Sender: makes the reply (this uses the code up) and sends it. */
  const sendReply = () =>
    step(
      "Couldn't make the reply",
      () => pairingApi.makeFileReply(includeSettings, includeSettings ? collectUiState() : undefined),
      (shareMenu) => {
        setCanShare(shareMenu);
        setSendState((current) => (current ? { ...current, replyMade: true } : current));
        deliver(shareMenu);
      },
    );

  /** Sender: a request opened; answer it at once. */
  const answerRequest = (accountCount: number) => {
    setSendState({ accountCount, replyMade: false });
    showView("file-send");
    afterViewChange(() => void sendReply());
  };

  const handleOpened = (opened: TappedFile) => {
    if (opened.kind === "request") answerRequest(opened.info.accountCount);
    else importPreview(opened.preview);
  };

  return {
    sendState,
    preview,
    canShare,
    requestedAutomatically,
    openingReply,
    /** Shows the share menu again for the file made last. */
    share: () => void share(),
    /** Saves a copy of the file made last. */
    save: () => void save(),
    /**
     * Receiver: make the request for `code`, send it, then wait for the reply. `automatic` when
     * the Wi-Fi search found nothing in time, rather than the user choosing a file.
     */
    startRequest: (code: string, automatic = false) =>
      step("Couldn't make the request", () => pairingApi.makeFileRequest(code), (shareMenu) => {
        setCanShare(shareMenu);
        setPreview(null);
        setRequestedAutomatically(automatic);
        showView("file-receive");
        deliver(shareMenu);
      }),
    /** Receiver: open the reply by hand (the open dialog), then add its accounts. */
    openReply: () => {
      setOpeningReply(true);
      return step("Couldn't open the reply", () => pairingApi.openFileReply(), (opened) => {
        if (opened) importPreview(opened);
      }).finally(() => setOpeningReply(false));
    },
    /** Sender: open a request by hand (the open dialog), then answer it. */
    openRequest: () =>
      step("Couldn't open the request", () => pairingApi.openFileRequest(), (info) => {
        if (info) answerRequest(info.accountCount);
      }),
    /** A file that arrived by itself (Downloads, AirDrop, a Quick Share tap): carry on with it. */
    handleOpened,
    /** Android and iPhone: open the file opened from another app, as a request or a reply. */
    openTapped: () =>
      step("Couldn't open the file", () => pairingApi.openTappedFile(), (opened) => {
        if (opened) handleOpened(opened);
      }),
    /** Sender: make the reply again and send it (after a failure). */
    sendReply,
    /** Forget both sides' screens (the dialog closed). */
    reset: () => {
      setSendState(null);
      setPreview(null);
      setCanShare(false);
      setRequestedAutomatically(false);
    },
  };
}
