import { useEffect, useRef, useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import type { FilePreview, SyncSummary } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import type { ViewMode } from "../lib/view-model";
import type { PairingActionContext } from "./usePairingSession";

/**
 * The sender's file: being made, then made and handed to the share menu, then `handedOff` once
 * the system says it went to the other device (AirDrop on a Mac or iPhone) or that an app was
 * chosen for it (Quick Share on Android, Nearby Sharing on Windows).
 */
export type FileSendState = { made: boolean; notOnNetwork: boolean; handedOff: boolean };

/**
 * The window event the native share menus send (`platform/share_sheet.rs` `SHARE_OUTCOME_EVENT`,
 * Android's `MainActivity.SHARE_OUTCOME_EVENT`). Its `detail` is `"sent"`, `"chosen"`, `"failed"`
 * or `"cancelled"`.
 */
export const SHARE_OUTCOME_EVENT = "aiut-file-share-outcome";

/**
 * Transfer by file, for two devices that are not on one network. The sender, with the link code
 * its user typed, makes one file holding the accounts encrypted with that code, and sends it
 * through the system share menu (AirDrop, Quick Share) or a save dialog; it can be sent again.
 * The receiver, showing the code, opens the file that arrives by itself (`useIncomingFile`,
 * `useTappedTransferFile`), asks its user to confirm adding
 * the accounts it holds (`awaitingConfirm`), then adds them. Typing the code is the sender's consent. Rust shows every menu and
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
  /** A file opened and counted, waiting for the receiving user to agree to add its accounts. */
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
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

  /** The share menu's outcome, while the sending screen is shown. */
  const sending = sendState !== null;
  useEffect(() => {
    if (!sending) return;
    const onOutcome = (event: Event) => {
      const outcome = (event as CustomEvent<unknown>).detail;
      const handedOff = outcome === "sent" || outcome === "chosen";
      if (!handedOff && outcome !== "failed" && outcome !== "cancelled") return;
      setSendState((current) => (current ? { ...current, handedOff } : current));
    };
    window.addEventListener(SHARE_OUTCOME_EVENT, onOutcome);
    return () => window.removeEventListener(SHARE_OUTCOME_EVENT, onOutcome);
  }, [sending]);

  /** Opens the share menu; the other device is current again until it reports where the file went. */
  const share = () => {
    setSendState((current) => (current ? { ...current, handedOff: false } : current));
    return step("Couldn't open the share menu", () => pairingApi.shareFile(), () => {});
  };
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

  /** Receiver: a file opened; show what it holds and ask whether to add it. */
  const showOpened = (opened: FilePreview) => {
    setPreview(opened);
    setAwaitingConfirm(true);
    showView("file-receive");
  };

  /**
   * Receiver, once its user agreed: adds the accounts of the file that opened. The import uses the
   * opened file up whatever happens, so after a failure the other device sends it again to a new code.
   */
  const confirmImport = () => {
    if (!preview) return;
    const { ticket } = preview;
    setAwaitingConfirm(false);
    void step(
      "Couldn't add the accounts",
      () => pairingApi.importFile(ticket, includeSettings),
      (summary) => {
        setPreview(null);
        onImported(summary);
      },
    );
  };

  return {
    sendState,
    preview,
    canShare,
    /**
     * Sender: make the file for `code` and send it, which also stops looking for the other device
     * on the network. `notOnNetwork` when the Wi-Fi search had already found no one.
     */
    send: (code: string, notOnNetwork = false) => {
      codeRef.current = code;
      setSendState({ made: false, notOnNetwork, handedOff: false });
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
    handleOpened: showOpened,
    /** Receiver: the opened file waits for its user to agree to add its accounts. */
    awaitingConfirm: awaitingConfirm && preview !== null,
    /** Receiver: add the opened file's accounts. */
    confirmImport,
    /** Receiver: choose a received transfer file from the system picker (e.g. iOS Files). */
    openFile: () =>
      step("Couldn't open the file", () => pairingApi.openFile(), (opened) => {
        if (opened) showOpened(opened);
      }),
    /** Android, iPhone, and macOS: open the file opened from another app, then add its accounts. */
    openTapped: () =>
      step("Couldn't open the file", () => pairingApi.openTappedFile(), (opened) => {
        if (opened) showOpened(opened);
      }),
    /** Forget both sides' screens (the dialog closed). */
    reset: () => {
      setSendState(null);
      setPreview(null);
      setAwaitingConfirm(false);
      setCanShare(false);
      codeRef.current = "";
    },
  };
}
