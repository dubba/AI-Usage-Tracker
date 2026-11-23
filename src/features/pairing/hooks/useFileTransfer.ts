import { useState } from "react";
import { pairingApi } from "../../../shared/lib/api";
import type { FilePreview } from "../../../types";
import { collectUiState } from "../../layout/ui-state";
import type { ViewMode } from "../lib/view-model";
import type { PairingActionContext } from "./usePairingSession";

/** Where the sender is in answering a request: agreeing to send, then the reply made. */
export type FileSendState = { accountCount: number; replyMade: boolean };

/**
 * Transfer by file, for two devices that are not on one network. The receiver makes a request
 * for the code it typed and later opens the reply; the sender, while showing its code, opens the
 * request and makes the reply. Each file, once made, goes out through the system share menu where
 * there is one (macOS) or a save dialog, and either can be repeated. Rust shows every menu and
 * dialog and keeps the files between steps, so these calls carry only counts and a ticket. On
 * Android a file can also be tapped in Quick Share; `openTapped` opens it as whichever it is.
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

  const share = () => step("Couldn't open the share menu", () => pairingApi.shareFile(), () => {});
  const save = () => step("Couldn't save the file", () => pairingApi.saveFile(), () => {});
  /** Sends the file just made: the share menu if there is one, otherwise the save dialog. */
  const deliver = (shareMenu: boolean) => void (shareMenu ? share() : save());

  return {
    sendState,
    preview,
    canShare,
    /** Shows the share menu again for the file made last. */
    share: () => void share(),
    /** Saves a copy of the file made last. */
    save: () => void save(),
    /** Receiver: make the request for `code`, send it, then wait for the reply. */
    startRequest: (code: string) =>
      step("Couldn't make the request", () => pairingApi.makeFileRequest(code), (shareMenu) => {
        setCanShare(shareMenu);
        setPreview(null);
        showView("file-receive");
        deliver(shareMenu);
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
        setSendState({ accountCount: info.accountCount, replyMade: false });
        showView("file-send");
      }),
    /** Android: open the file tapped in another app, as a request or a reply. */
    openTapped: () =>
      step("Couldn't open the file", () => pairingApi.openTappedFile(), (opened) => {
        if (!opened) return;
        if (opened.kind === "request") {
          setSendState({ accountCount: opened.info.accountCount, replyMade: false });
          showView("file-send");
        } else {
          setPreview(opened.preview);
          showView("file-receive");
        }
      }),
    /** Sender, after its user agreed: make the reply (this uses the code up) and send it. */
    sendReply: () =>
      step(
        "Couldn't make the reply",
        () => pairingApi.makeFileReply(includeSettings, includeSettings ? collectUiState() : undefined),
        (shareMenu) => {
          setCanShare(shareMenu);
          setSendState((current) => (current ? { ...current, replyMade: true } : current));
          deliver(shareMenu);
        },
      ),
    /** Forget both sides' screens (the dialog closed). */
    reset: () => {
      setSendState(null);
      setPreview(null);
      setCanShare(false);
    },
  };
}
