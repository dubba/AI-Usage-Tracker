// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AirgapExport, PairingStatus } from "../../types";

const api = vi.hoisted(() => ({
  startHost: vi.fn(),
  startClientByCode: vi.fn(),
  selectRole: vi.fn(),
  confirmTransfer: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  setIncludeSettings: vi.fn(),
  setPendingUiState: vi.fn(),
  clearPendingUiState: vi.fn(),
  prepareAirgapExport: vi.fn(),
  previewAirgapFrames: vi.fn(),
  importAirgapFrames: vi.fn(),
  ensureCameraPermission: vi.fn(),
  wifiEnabled: vi.fn(),
  sendFile: vi.fn(),
  shareFile: vi.fn(),
  saveFile: vi.fn(),
  openFile: vi.fn(),
  importFile: vi.fn(),
  tappedFilePending: vi.fn(),
  openTappedFile: vi.fn(),
  watchForFile: vi.fn(),
  stopWatchingForFile: vi.fn(),
  pollForFile: vi.fn(),
  requestFileAccess: vi.fn(),
  openReceiveSettings: vi.fn(),
}));
const cancelPairing = vi.hoisted(() => vi.fn());
vi.mock("../../shared/lib/api", () => ({ pairingApi: api, cancelPairing }));

const events = vi.hoisted(() => ({ handler: null as null | ((event: { payload: unknown }) => void) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, handler: (event: { payload: unknown }) => void) => {
    events.handler = handler;
    return () => {
      events.handler = null;
    };
  },
}));

type ScannerOptions = {
  active: boolean;
  restartKey: number;
  onDecoded: (code: string, controls: { stopCamera: () => void }) => boolean | void | Promise<boolean | void>;
  onError?: (cause: unknown) => void;
};
const scanner = vi.hoisted(() => ({
  options: null as null | ScannerOptions,
  // Camera error shown by the scanner view; tests set it the way the real hook would.
  setCameraError: null as null | ((message: string | null) => void),
  videoRef: { current: null },
  stopCamera: vi.fn(),
  handleScannerTap: vi.fn(),
  handleSwitchCamera: vi.fn(),
}));
vi.mock("./hooks/useQrScanner", async () => {
  const { useEffect, useState } = await import("react");
  return {
    useQrScanner: (options: ScannerOptions) => {
      scanner.options = options;
      const [cameraError, setCameraErrorMessage] = useState<string | null>(null);
      const [cameraFailed, setCameraFailed] = useState(false);
      const [videoReady, setVideoReady] = useState(false);
      // Like the real hook: a failure outlives its message and ends when the camera starts again.
      const setCameraError = (message: string | null) => {
        setCameraErrorMessage(message);
        if (message !== null) setCameraFailed(true);
      };
      useEffect(() => {
        setCameraFailed(false);
        setCameraErrorMessage(null);
      }, [options.active, options.restartKey]);
      scanner.setCameraError = setCameraError;
      return {
        videoRef: scanner.videoRef,
        videoReady,
        setVideoReady,
        availableCameras: [],
        isFrontCamera: false,
        cameraError,
        cameraFailed,
        clearCameraError: () => setCameraErrorMessage(null),
        stopCamera: scanner.stopCamera,
        handleScannerTap: scanner.handleScannerTap,
        handleSwitchCamera: scanner.handleSwitchCamera,
      };
    },
  };
});
vi.mock("../layout/ui-state", () => ({ collectUiState: () => ({ marker: true }) }));

import { click, mount, settle, typeInto, type Mounted } from "../../test-utils/react";
import { ERROR_AUTO_DISMISS_MS } from "../../shared/hooks/useAutoDismissedError";
import { PairingModal } from "./PairingModal";
import { TRANSFER_FILE_TAPPED_EVENT } from "./hooks/useTappedTransferFile";
import { setSyncOtherWays } from "../../shared/lib/sync-other-ways";

const onClose = vi.fn();
const onCompleted = vi.fn();
let mounted: Mounted;

const QR = { size: 1, modules: "1" };
const AIRGAP: AirgapExport = {
  frames: [{ qr: QR }, { qr: QR }, { qr: QR }],
  totalChunks: 3,
} as unknown as AirgapExport;

function render(props: { open?: boolean } = {}) {
  mounted = mount(<PairingModal open={props.open ?? true} onClose={onClose} onCompleted={onCompleted} />);
}

const text = () => document.body.textContent ?? "";
const title = () => document.getElementById("pairing-modal-title")?.textContent;
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`no button "${label}" in: ${buttons().map((b) => b.textContent).join(" | ")}`);
  return found;
}
const press = async (label: string) => {
  click(button(label));
  await settle();
};
/** The popup over the dialog (a ConfirmDialog), if one is open. */
const popup = () => document.querySelector<HTMLElement>(".confirm-dialog-backdrop [role=alertdialog]");
const popupTitle = () => popup()?.querySelector("h2")?.textContent;
/** Presses a button in the popup. */
const pressIn = async (label: string) => {
  const found = Array.from(popup()?.querySelectorAll("button") ?? []).find((b) => b.textContent === label);
  if (!found) throw new Error(`no popup button "${label}"`);
  click(found);
  await settle();
};
async function emit(status: PairingStatus) {
  await act(async () => {
    events.handler?.({ payload: status });
  });
}

const CODE = "KTQMPRXDHWAB";
const HOST_INIT = { sessionId: "s1", joinCode: CODE, expiresAt: Math.floor(Date.now() / 1000) + 125 };
const PREVIEW = { accountCount: 2, ticket: "ticket-1" };
/** The Wi-Fi search for the code ended without finding the other device. */
const SEARCH_FOUND_NO_ONE = { code: "not_found", message: "No device is showing a link code on this Wi-Fi network." };
const CONFIRM = (role: "sender" | "receiver", extra: object = {}) =>
  ({ status: "confirmTransfer", data: { sessionId: "s1", role, accountCount: 3, ...extra } }) as PairingStatus;

beforeEach(() => {
  vi.clearAllMocks();
  events.handler = null;
  scanner.options = null;
  api.status.mockResolvedValue({ status: "idle" });
  api.startHost.mockResolvedValue(HOST_INIT);
  api.startClientByCode.mockResolvedValue(undefined);
  api.selectRole.mockResolvedValue(undefined);
  api.confirmTransfer.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.setIncludeSettings.mockResolvedValue(undefined);
  api.setPendingUiState.mockResolvedValue(undefined);
  api.clearPendingUiState.mockResolvedValue(undefined);
  api.prepareAirgapExport.mockResolvedValue(AIRGAP);
  api.ensureCameraPermission.mockResolvedValue(undefined);
  api.wifiEnabled.mockResolvedValue(false);
  // Downloads is watched, and nothing has arrived yet.
  api.watchForFile.mockResolvedValue({ watching: true, needsAccess: false });
  api.stopWatchingForFile.mockResolvedValue(undefined);
  api.pollForFile.mockResolvedValue(null);
  api.requestFileAccess.mockResolvedValue(undefined);
  api.openReceiveSettings.mockResolvedValue(undefined);
  // A Mac: the file goes out through the share menu.
  api.sendFile.mockResolvedValue(true);
  api.shareFile.mockResolvedValue(undefined);
  api.saveFile.mockResolvedValue(true);
  api.openFile.mockResolvedValue(PREVIEW);
  api.importFile.mockResolvedValue({ added: 2, updated: 0, skipped: 0, warnings: [] });
  api.tappedFilePending.mockResolvedValue(false);
  api.openTappedFile.mockResolvedValue(null);
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  // Most tests reach the six-digit code and the QR codes; the hidden default has its own tests.
  setSyncOtherWays("on");
});

afterEach(() => {
  mounted?.unmount();
  document.body.innerHTML = "";
});

describe("choosing a role and a way to connect", () => {
  it("starts on step 1 with the send and receive choices", async () => {
    render();
    await settle();
    expect(title()).toBe("Send or Receive Accounts");
    expect(document.querySelector(".modal-kicker")?.textContent).toBe("Sync devices");
    expect(document.querySelector('[aria-label="Step 1 of 3"]')).not.toBeNull();
    expect(text()).toContain("Send Accounts from This Device");
    expect(text()).toContain("Receive Accounts on This Device");
    expect(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")?.checked).toBe(true);
    expect(document.querySelector(".pairing-settings-toggle span")?.textContent).toContain("Also Sync Settings and Layout");
    expect(document.querySelector(".pairing-settings-toggle small")?.textContent).toBe(
      "Includes appearance, menu bar labels, launch at startup, account refresh intervals, automatic updates, app alerts, and card ordering."
    );
  });

  it("shows a link code at once when receiving", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(title()).toBe("Your Link Code");
    expect(api.startHost).toHaveBeenCalledWith(true, false);
    expect(text()).toContain("go to Settings → Sync Devices, select Send, and enter this code");
  });

  it("asks for the link code at once when sending", async () => {
    render();
    await press("Send Accounts from This Device");
    expect(title()).toBe("Enter Link Code");
    expect(api.startHost).not.toHaveBeenCalled();
    expect(text()).toContain("Type the 12-letter link code shown on the receiving device.");
  });

  it("lists every way to connect under the other ways when sending, ending the code session", async () => {
    render();
    await press("Send Accounts from This Device");
    cancelPairing.mockClear();
    await press("Other ways to connect");
    expect(cancelPairing).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Other Ways to Connect");
    for (const label of ["Show Link Code", "Enter Link Code", "Show QR Code", "Scan QR Code"]) expect(text()).toContain(label);
  });

  it("does not offer the animated QR code when receiving", async () => {
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    expect(text()).toContain("Show Link Code");
    expect(text()).not.toContain("Show QR Code");
  });

  it("lets a sender show six digits instead, for an older receiver", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(title()).toBe("Your Link Code");
    expect(api.startHost).toHaveBeenCalledWith(true, true);
  });

  it("hides Other ways to connect on both code screens until Settings shows it", async () => {
    setSyncOtherWays("off");
    render();
    await press("Send Accounts from This Device");
    expect(text()).not.toContain("Other ways to connect");
    await press("Back");
    await press("Receive Accounts on This Device");
    expect(title()).toBe("Your Link Code");
    expect(text()).not.toContain("Other ways to connect");
    await act(async () => setSyncOtherWays("on"));
    expect(text()).toContain("Other ways to connect");
  });

  it("goes back from the other ways to the role choice", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
  });
});

describe("no Wi-Fi check before a link code", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14)",
      configurable: true,
    });
  });

  it("shows the code at once when receiving, whatever the Wi-Fi", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Your Link Code");
    expect(popup()).toBeNull();
  });

  it("asks for the code at once when sending, whatever the Wi-Fi", async () => {
    render();
    await press("Send Accounts from This Device");
    expect(title()).toBe("Enter Link Code");
    expect(document.querySelector(".confirm-dialog-backdrop")).toBeNull();
    // Asked only so the diagnostics log can say whether the phone was on Wi-Fi.
    expect(api.wifiEnabled).toHaveBeenCalledTimes(1);
  });
});

describe("showing a link code", () => {
  async function openHost() {
    render();
    await press("Receive Accounts on This Device");
  }

  it("starts a host session and shows the code and a countdown", async () => {
    await openHost();
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Your Link Code");
    expect(document.querySelector(".pairing-code-hero")?.getAttribute("aria-label")).toBe("Link code KTQ MPR XDH WAB");
    expect(Array.from(document.querySelectorAll(".pairing-code-digit"), (d) => d.textContent).join("")).toBe(CODE);
    expect(document.querySelector(".pairing-code-digits")?.className).toContain("is-long");
    expect(
      Array.from(document.querySelectorAll(".pairing-code-digit"), (d, i) => (d.classList.contains("group-start") ? i : -1)).filter(
        (i) => i >= 0,
      ),
    ).toEqual([3, 9]);
    expect(text()).toMatch(/Expires in\s*2:0\d/);
    expect(text()).toContain("Waiting for the other device on Wi-Fi or AirDrop…");
  });

  it("shows a progress message until the code arrives", async () => {
    api.startHost.mockReturnValue(new Promise(() => {}));
    render();
    await press("Receive Accounts on This Device");
    expect(text()).toContain("Starting pairing session…");
  });

  it("shows why the session could not start", async () => {
    api.startHost.mockRejectedValue(new Error("no network"));
    await openHost();
    expect(text()).toContain("no network");
  });

  it("cancels the session and returns to the role choice on Back", async () => {
    await openHost();
    await press("Back");
    expect(cancelPairing).toHaveBeenCalled();
    expect(title()).toBe("Send or Receive Accounts");
  });

  it("shows an older version's six digits in two groups of three", async () => {
    api.startHost.mockResolvedValue({ ...HOST_INIT, joinCode: "123456" });
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(document.querySelector(".pairing-code-hero")?.getAttribute("aria-label")).toBe("Link code 123 456");
    expect(document.querySelectorAll(".pairing-code-digit")).toHaveLength(6);
  });

  it("offers a new code when the countdown expires", async () => {
    await openHost();
    await emit({
      status: "hostWaiting",
      data: { ...HOST_INIT, expiresAt: Math.floor(Date.now() / 1000) - 5 },
    });
    await settle();
    expect(text()).toContain("This link code expired");
    await press("Generate New Code");
    expect(api.startHost).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("This link code expired");
  });
});

describe("entering a link code", () => {
  async function openCodeEntry() {
    render();
    await press("Send Accounts from This Device");
  }
  const input = () => document.getElementById("pairing-join-code-input") as HTMLInputElement;

  it("keeps a code's letters, capitalized, in groups of three, and connects by itself at twelve", async () => {
    await openCodeEntry();
    expect(title()).toBe("Enter Link Code");
    expect(button("Connect").disabled).toBe(true);
    expect(document.querySelectorAll(".pairing-code-tile")).toHaveLength(12);
    typeInto(input(), "kt1");
    expect(input().value).toBe("KT");
    // I, L and O are never in a code: they read as 1 and 0.
    typeInto(input(), "ktq-mp rxILO");
    expect(input().value).toBe("KTQ MPR X");
    expect(button("Connect").disabled).toBe(true);
    expect(api.startClientByCode).not.toHaveBeenCalled();
    typeInto(input(), "ktqmprxdhwabcd");
    expect(input().value).toBe("KTQ MPR XDH WAB");
    await settle();
    expect(api.startClientByCode).toHaveBeenCalledWith(CODE, true);
    expect(Array.from(document.querySelectorAll(".pairing-code-tile"), (t) => t.textContent).join("")).toBe(CODE);
    // Two rows of three, a gap, and three: the gap goes before the fourth tile of each row.
    const gapBefore = Array.from(document.querySelectorAll(".pairing-code-tile"), (t, i) =>
      t.classList.contains("group-start") ? i : -1,
    ).filter((i) => i >= 0);
    expect(gapBefore).toEqual([3, 9]);
  });

  it("ignores digits while Other ways to connect is hidden, keeping twelve tiles", async () => {
    setSyncOtherWays("off");
    await openCodeEntry();
    typeInto(input(), "3");
    expect(input().value).toBe("");
    expect(document.querySelectorAll(".pairing-code-tile")).toHaveLength(12);
    typeInto(input(), "3kt9q");
    expect(input().value).toBe("KTQ");
    expect(text()).not.toContain("6-digit code");
  });

  it("takes an older version's six digits, in two groups of three, and connects by itself at six", async () => {
    await openCodeEntry();
    typeInto(input(), "12a");
    expect(input().value).toBe("12");
    typeInto(input(), "12ab34c");
    expect(input().value).toBe("123 4");
    expect(button("Connect").disabled).toBe(true);
    expect(api.startClientByCode).not.toHaveBeenCalled();
    typeInto(input(), "1234567890");
    expect(input().value).toBe("123 456");
    await settle();
    expect(api.startClientByCode).toHaveBeenCalledWith("123456", true);
    expect(Array.from(document.querySelectorAll(".pairing-code-tile"), (t) => t.textContent).join("")).toBe("123456");
  });

  it("sends a code pasted with its space as its letters only", async () => {
    await openCodeEntry();
    typeInto(input(), "KTQ MPR XDH WAB");
    expect(input().value).toBe("KTQ MPR XDH WAB");
    await settle();
    expect(api.startClientByCode).toHaveBeenCalledWith(CODE, true);
  });

  it("provides an accessible name for the code input", async () => {
    await openCodeEntry();
    expect(input().getAttribute("aria-label")).toBe("Link code");
  });

  it("connects with the code", async () => {
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    expect(api.startClientByCode).toHaveBeenCalledWith("123456", true);
  });

  it("connects when Enter is pressed on a full code only", async () => {
    await openCodeEntry();
    typeInto(input(), "123");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.startClientByCode).not.toHaveBeenCalled();
    typeInto(input(), "123456");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.startClientByCode).toHaveBeenCalledWith("123456", true);
  });

  it("shows a connection error and lets the user retry", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    expect(text()).toContain("code not found");
    expect(button("Connect").disabled).toBe(false);
  });

  it("clears connection error when going back to the role choice", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    expect(text()).toContain("code not found");
    expect(document.querySelector(".modal-error")).not.toBeNull();
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("code not found");
  });

  it("does not leak error to previous view if connect fails after user clicks Back", async () => {
    let rejectConnect!: (err: Error) => void;
    api.startClientByCode.mockImplementation(
      () => new Promise((_, reject) => { rejectConnect = reject; })
    );
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    // Connect is still in-flight. User hits Back now.
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
    expect(document.querySelector(".modal-error")).toBeNull();

    // Now the in-flight connect fails with mDNS resolution error
    await act(async () => {
      rejectConnect(new Error("No matching service found for link code 016142"));
    });

    // The error MUST NOT appear on the role choice!
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("No matching service found");
  });

  it("dismisses active error message when Escape is pressed", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    expect(document.querySelector(".modal-error")).not.toBeNull();

    // Hit Escape / back key
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();

    // The error disappears while staying on the screen
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(title()).toBe("Enter Link Code");
  });

  it("hides the connection error from its X", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    expect(document.querySelector(".modal-error")?.textContent).toContain("code not found");
    click(document.querySelector<HTMLButtonElement>('.modal-error [aria-label="Dismiss error"]')!);
    await settle();
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(title()).toBe("Enter Link Code");
  });

  it("auto-dismisses the connection error after 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      api.startClientByCode.mockRejectedValue(new Error("code not found"));
      await openCodeEntry();
      typeInto(input(), "123456");
      await press("Connect");
      expect(text()).toContain("code not found");
      expect(document.querySelector(".modal-error")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS);
      });
      expect(document.querySelector(".modal-error")).toBeNull();
      expect(text()).not.toContain("code not found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to the role choice", async () => {
    await openCodeEntry();
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
  });

  it("keeps the typed code when Try Again follows a failed connection", async () => {
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect");
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "The link to the other device broke." } } });
    await press("Try Again");
    expect(title()).toBe("Enter Link Code");
    expect(input().value).toBe("123 456");
  });
});

describe("transfer by file", () => {
  const codeInput = () => document.getElementById("pairing-join-code-input") as HTMLInputElement;

  /** Send and type the code; the search finds no one, so the file goes by AirDrop by itself. */
  async function sendWithCode() {
    api.startClientByCode.mockRejectedValue(SEARCH_FOUND_NO_ONE);
    render();
    await press("Send Accounts from This Device");
    typeInto(codeInput(), CODE);
    await settle();
  }

  /** A file the watch on Downloads picks up at its next poll. */
  async function arrives(opened: unknown) {
    api.pollForFile.mockResolvedValueOnce(opened);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    await settle();
  }

  it("names AirDrop on a Mac and sends the accounts as one file by itself", async () => {
    api.startClientByCode.mockRejectedValue(SEARCH_FOUND_NO_ONE);
    render();
    await press("Send Accounts from This Device");
    // No button: Wi-Fi first, then AirDrop by itself.
    expect(buttons().some((b) => b.textContent?.includes("Use AirDrop"))).toBe(false);
    typeInto(codeInput(), CODE);
    await settle();
    expect(api.sendFile).toHaveBeenCalledWith(CODE, true, { marker: true });
    expect(api.shareFile).toHaveBeenCalledTimes(1);
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(title()).toBe("Sending by AirDrop");
    // On a phone the share sheet covers the lower half: this dialog sits at the top instead.
    expect(document.querySelector(".pairing-modal")?.className).toContain("view-file-send");
    expect(text()).toContain("Choose the other device in AirDrop");
    expect(text()).toContain("Once the other device accepts the file and confirms, the accounts are added there.");
    // Nothing comes back: the sender waits for no file.
    expect(api.watchForFile).not.toHaveBeenCalled();
    await press("Done");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends no settings or layout when they are left out", async () => {
    api.startClientByCode.mockRejectedValue(SEARCH_FOUND_NO_ONE);
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await settle();
    await press("Send Accounts from This Device");
    typeInto(codeInput(), CODE);
    await settle();
    expect(api.sendFile).toHaveBeenCalledWith(CODE, false, undefined);
  });

  it("sends the file again or saves a copy", async () => {
    await sendWithCode();
    await press("Send again by AirDrop");
    expect(api.shareFile).toHaveBeenCalledTimes(2);
    await press("Save to a file instead");
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    expect(api.sendFile).toHaveBeenCalledTimes(1);
  });

  it("saves the file where there is no share menu", async () => {
    api.sendFile.mockResolvedValue(false);
    await sendWithCode();
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    expect(api.shareFile).not.toHaveBeenCalled();
    expect(text()).not.toContain("Send again by");
    expect(text()).toContain("Save to a file instead");
  });

  it("offers Try Again when the file can't be made", async () => {
    api.sendFile.mockRejectedValueOnce(new Error("disk full"));
    await sendWithCode();
    expect(text()).toContain("disk full");
    expect(title()).toBe("Sending by AirDrop");
    expect(api.shareFile).not.toHaveBeenCalled();
    await press("Try Again");
    expect(api.sendFile).toHaveBeenCalledTimes(2);
    expect(api.shareFile).toHaveBeenCalledTimes(1);
  });

  it("goes back to the code, still typed, from a file that couldn't be made", async () => {
    api.sendFile.mockRejectedValueOnce(new Error("disk full"));
    await sendWithCode();
    await press("Back");
    expect(title()).toBe("Enter Link Code");
    expect(codeInput().value).toBe("KTQ MPR XDH WAB");
  });

  it("asks before adding the accounts of a file that arrives while showing the code", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(api.watchForFile).toHaveBeenCalledTimes(1);
    await arrives(PREVIEW);
    // Asked in the dialog itself, with no popup over it.
    expect(document.querySelector(".confirm-dialog-backdrop")).toBeNull();
    expect(title()).toBe("Receiving by AirDrop");
    expect(text()).toContain("Are you sure you want to add these 2 accounts from the other device?");
    expect(text()).toContain("File received via AirDrop");
    expect(api.importFile).not.toHaveBeenCalled();
    await press("Add Accounts");
    expect(api.importFile).toHaveBeenCalledWith("ticket-1", true);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Devices linked");
  }, 10_000);

  it("adds nothing when Cancel is pressed, and closes Sync Devices", async () => {
    render();
    await press("Receive Accounts on This Device");
    await press("Received a file but nothing happened? Open it");
    expect(text()).toContain("Are you sure you want to add these 2 accounts");
    await press("Cancel");
    expect(api.importFile).not.toHaveBeenCalled();
    expect(cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says one account in the singular", async () => {
    api.openFile.mockResolvedValue({ accountCount: 1, ticket: "ticket-1" });
    render();
    await press("Receive Accounts on This Device");
    await press("Received a file but nothing happened? Open it");
    expect(text()).toContain("Are you sure you want to add this account from the other device?");
  });

  it("adds a file opened by hand once confirmed", async () => {
    render();
    await press("Receive Accounts on This Device");
    await press("Received a file but nothing happened? Open it");
    expect(api.openFile).toHaveBeenCalledTimes(1);
    await press("Add Accounts");
    expect(api.importFile).toHaveBeenCalledWith("ticket-1", true);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("keeps showing the code when the open dialog is cancelled", async () => {
    api.openFile.mockResolvedValue(null);
    render();
    await press("Receive Accounts on This Device");
    await press("Received a file but nothing happened? Open it");
    expect(api.importFile).not.toHaveBeenCalled();
    expect(title()).toBe("Your Link Code");
  });

  it("shows why a file that arrived did not open, and keeps waiting", async () => {
    render();
    await press("Receive Accounts on This Device");
    api.pollForFile.mockRejectedValueOnce({
      code: "pairing",
      message: "This file doesn't match the code shown here, or it is damaged.",
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    await settle();
    expect(document.querySelector(".modal-error")?.textContent).toContain("doesn't match the code shown here");
    expect(title()).toBe("Your Link Code");
    expect(api.importFile).not.toHaveBeenCalled();
  }, 10_000);

  it("says why the accounts couldn't be added, with Back to start over", async () => {
    api.openFile.mockResolvedValue(PREVIEW);
    api.importFile.mockRejectedValue(new Error("store locked"));
    render();
    await press("Receive Accounts on This Device");
    await press("Received a file but nothing happened? Open it");
    await press("Add Accounts");
    expect(text()).toContain("store locked");
    expect(title()).toBe("Receiving by AirDrop");
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
  });

  it("watches Downloads only while a twelve-letter code is shown", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(api.watchForFile).toHaveBeenCalledTimes(1);
    await press("Back");
    expect(api.stopWatchingForFile).toHaveBeenCalled();

    // Six digits for an older version go over Wi-Fi only.
    api.startHost.mockResolvedValue({ ...HOST_INIT, joinCode: "123456" });
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(api.startHost).toHaveBeenLastCalledWith(true, true);
    expect(text()).toContain("Waiting for the other device to connect…");
    expect(text()).not.toContain("Use AirDrop");
    expect(api.watchForFile).toHaveBeenCalledTimes(1);
  });

  it("never sends an older version's six digits by file", async () => {
    api.startClientByCode.mockRejectedValue(new Error("No device is showing a link code on this Wi-Fi network."));
    render();
    await press("Send Accounts from This Device");
    typeInto(codeInput(), "123456");
    await settle();
    expect(text()).toContain("No device is showing a link code");
    expect(text()).not.toContain("Use AirDrop");
    expect(api.sendFile).not.toHaveBeenCalled();
  });

  it("asks an Android receiver for file access in a popup, and nothing about being discoverable", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    api.watchForFile.mockResolvedValue({ watching: false, needsAccess: true });
    render();
    await press("Receive Accounts on This Device");
    // No Use Quick Share button on the receiving screen: the popup comes by itself.
    expect(buttons().some((b) => b.textContent?.includes("Use Quick Share"))).toBe(false);
    expect(popupTitle()).toBe("Allow file access");
    expect(popup()?.textContent).toContain(
      "Allow AI Usage Tracker to access files saved by Quick Share in Downloads so synced accounts are added automatically. Only Sync Devices files are opened.",
    );
    await pressIn("Allow");
    expect(api.requestFileAccess).toHaveBeenCalledTimes(1);
    // Asked once. No app can reach Quick Share's visibility setting on Android, so that isn't asked.
    expect(popup()).toBeNull();
    expect(title()).toBe("Your Link Code");
  });

  it("closes the file access popup from Not Now", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    api.watchForFile.mockResolvedValue({ watching: false, needsAccess: true });
    render();
    await press("Receive Accounts on This Device");
    await pressIn("Not Now");
    expect(api.requestFileAccess).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("asks nothing once file access is allowed, nor on the sending phone", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(popup()).toBeNull();
    await press("Back");
    await press("Send Accounts from This Device");
    expect(popup()).toBeNull();
  });

  it("asks a Mac receiving by AirDrop to be discoverable, and opens AirDrop", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(popup()?.textContent).toContain("AirDrop must allow everyone to share with this Mac.");
    expect(popup()?.textContent).toContain("If System Settings opens instead, go to General → AirDrop & Handoff.");
    await pressIn("Open AirDrop");
    expect(api.openReceiveSettings).toHaveBeenCalledTimes(1);
  });

  it("gives an iPhone the steps only, with nothing to open", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(popup()?.querySelector(".confirm-dialog-body")?.textContent).toBe(
      "Unless both devices use the same Apple Account, set AirDrop to Everyone for 10 Minutes.",
    );
    const box = popup()?.querySelector(".confirm-dialog-note")?.textContent;
    expect(box).toContain("Go to Settings → General → AirDrop, then return here.");
    expect(box).toContain("If Settings opens instead, search for AirDrop.");
    await pressIn("Done");
    expect(api.openReceiveSettings).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("points Windows to Quick Share's Receiving setting and opens Nearby sharing", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(popup()?.textContent).toContain("In the Quick Share app, set Receiving to Everyone, then return here.");
    await pressIn("Open Nearby Sharing Settings");
    expect(api.openReceiveSettings).toHaveBeenCalledTimes(1);
  });

  it("asks nothing about being discoverable for an older version's six digits", async () => {
    api.startHost.mockResolvedValue({ ...HOST_INIT, joinCode: "123456" });
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(popup()).toBeNull();
  });

  it("asks nothing about visibility where there is no AirDrop or Quick Share", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(document.querySelector(".confirm-dialog-backdrop")).toBeNull();
  });

  it("offers no AirDrop or Quick Share where there is none", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(text()).not.toContain("Use Quick Share");
    expect(api.watchForFile).not.toHaveBeenCalled();
    await press("Back");
    await press("Send Accounts from This Device");
    expect(text()).not.toContain("Use Quick Share");
  });

  describe("a file tapped in Quick Share", () => {
    const android = () =>
      Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    /** The app comes back to the front with a tapped file waiting. */
    const comeBackWithTappedFile = async () => {
      api.tappedFilePending.mockResolvedValue(true);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();
    };

    it("adds a tapped file on the device showing the code", async () => {
      android();
      api.openTappedFile.mockResolvedValue(PREVIEW);
      render();
      await press("Receive Accounts on This Device");
      expect(api.openTappedFile).not.toHaveBeenCalled();
      await comeBackWithTappedFile();
      expect(api.openTappedFile).toHaveBeenCalledTimes(1);
      await press("Add Accounts");
      expect(api.importFile).toHaveBeenCalledWith("ticket-1", true);
      expect(title()).toBe("Devices linked");
    });

    it("says why a tapped file did not open", async () => {
      android();
      api.openTappedFile.mockRejectedValue({
        code: "pairing",
        message: "This isn't a Sync Devices file. Choose the file the other device sent.",
      });
      render();
      await comeBackWithTappedFile();
      expect(document.querySelector(".modal-error")?.textContent).toContain("isn't a Sync Devices file");
    });

    it("opens a file Android says was tapped while the app was running", async () => {
      android();
      api.openTappedFile.mockResolvedValue(PREVIEW);
      render();
      await press("Receive Accounts on This Device");
      api.tappedFilePending.mockResolvedValue(true);
      await act(async () => {
        window.dispatchEvent(new Event(TRANSFER_FILE_TAPPED_EVENT));
      });
      await settle();
      await press("Add Accounts");
      expect(api.importFile).toHaveBeenCalledWith("ticket-1", true);
    });

    it("adds a file AirDropped to an iPhone while the app was running", async () => {
      Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", configurable: true });
      api.openTappedFile.mockResolvedValue(PREVIEW);
      render();
      await press("Receive Accounts on This Device");
      api.tappedFilePending.mockResolvedValue(true);
      await act(async () => {
        window.dispatchEvent(new Event(TRANSFER_FILE_TAPPED_EVENT));
      });
      await settle();
      await press("Add Accounts");
      expect(api.importFile).toHaveBeenCalledWith("ticket-1", true);
    });

    it("is not looked for on desktop", async () => {
      render();
      await comeBackWithTappedFile();
      expect(api.tappedFilePending).not.toHaveBeenCalled();
      expect(api.openTappedFile).not.toHaveBeenCalled();
    });
  });

  it("is offered on iPhone, which shares by AirDrop and saves from the share sheet", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", configurable: true });
    render();
    await press("Receive Accounts on This Device");
    expect(text()).toContain("Waiting for the other device on Wi-Fi or AirDrop");
    await pressIn("Not Now");
    await press("Back");
    api.startClientByCode.mockRejectedValue(SEARCH_FOUND_NO_ONE);
    await press("Send Accounts from This Device");
    typeInto(codeInput(), CODE);
    await settle();
    expect(api.shareFile).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Send again by AirDrop");
    // Save to Files is in the share sheet.
    expect(text()).not.toContain("Save to a file");
  });
});

describe("AirDrop or Quick Share when the code finds no one on the network", () => {
  const codeInput = () => document.getElementById("pairing-join-code-input") as HTMLInputElement;
  const NOT_FOUND = "No device is showing a link code on this Wi-Fi network.";
  const searchSeconds = async (seconds: number) => {
    await act(async () => {
      vi.advanceTimersByTime(seconds * 1000);
    });
    await settle();
  };
  /** Ends the network search: it found no one. */
  let notFound: () => Promise<void>;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    // The network search runs until the test ends it.
    api.startClientByCode.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          notFound = async () => {
            await act(async () => reject({ code: "not_found", message: NOT_FOUND }));
            await settle();
          };
        }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Send and type the code, which starts the search by itself. */
  async function searchForCode(code = CODE) {
    render();
    await press("Send Accounts from This Device");
    typeInto(codeInput(), code);
    await settle();
  }

  it("counts down the search, then sends by Quick Share by itself once it finds no one", async () => {
    await searchForCode();
    expect(api.startClientByCode).toHaveBeenCalledWith(CODE, true);
    expect(text()).toContain("Looking for the other device on Wi-Fi…");
    expect(text()).toContain("Not found within 10 seconds? Quick Share takes over by itself.");
    // No button: Wi-Fi first, and the switch is automatic.
    expect(buttons().some((b) => b.textContent?.includes("Use Quick Share"))).toBe(false);
    await searchSeconds(3);
    expect(document.querySelector("#pairing-code-help strong")?.textContent).toBe("7 seconds");
    await searchSeconds(7);
    expect(text()).toContain("Finishing the search on Wi-Fi…");
    // The countdown is only shown: the search's own end decides.
    expect(api.sendFile).not.toHaveBeenCalled();
    await notFound();
    expect(api.sendFile).toHaveBeenCalledWith(CODE, true, { marker: true });
    expect(api.shareFile).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(title()).toBe("Sending by Quick Share");
    expect(text()).toContain(
      "The other device wasn't found on this Wi-Fi network (a VPN on either device can hide it), so the accounts go by Quick Share.",
    );
    expect(text()).toContain("Send again by Quick Share");
  });

  it("still connects over Wi-Fi to a device found late in the search", async () => {
    await searchForCode();
    await searchSeconds(8);
    await emit({ status: "clientConnecting", data: { sessionId: "s1" } } as PairingStatus);
    await searchSeconds(10);
    expect(api.sendFile).not.toHaveBeenCalled();
    expect(text()).not.toContain("Sending by");
  });

  it("sends no file after going back from the search", async () => {
    await searchForCode();
    await searchSeconds(4);
    await press("Back");
    await notFound();
    expect(api.sendFile).not.toHaveBeenCalled();
    // A new search counts from the start again.
    await press("Send Accounts from This Device");
    typeInto(codeInput(), CODE);
    await settle();
    expect(text()).toContain("within 10 seconds?");
  });

  it("keeps an older version's six digits to Wi-Fi", async () => {
    await searchForCode("123456");
    expect(text()).not.toContain("takes over by itself");
    await notFound();
    expect(api.sendFile).not.toHaveBeenCalled();
    expect(text()).toContain(NOT_FOUND);
  });

  it("shows any other failure of the search as it is, without sending the file in its place", async () => {
    api.startClientByCode.mockRejectedValue({ code: "unclassified", message: "mDNS unavailable: no network interface" });
    await searchForCode();
    expect(document.querySelector(".modal-error")?.textContent).toContain("mDNS unavailable: no network interface");
    expect(api.sendFile).not.toHaveBeenCalled();
  });

  it("names AirDrop on iPhone", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", configurable: true });
    await searchForCode();
    expect(text()).toContain("AirDrop takes over by itself");
    await notFound();
    expect(api.sendFile).toHaveBeenCalledWith(CODE, true, { marker: true });
    expect(text()).toContain("Choose the other device in AirDrop");
  });

  it("sends by itself on a Mac and on Windows too", async () => {
    for (const userAgent of ["Mozilla/5.0 (Macintosh)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"]) {
      Object.defineProperty(navigator, "userAgent", { value: userAgent, configurable: true });
      api.sendFile.mockClear();
      await searchForCode();
      await notFound();
      expect(api.sendFile).toHaveBeenCalledWith(CODE, true, { marker: true });
      mounted.unmount();
    }
  });

  it("keeps to Wi-Fi where there is neither", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (X11; Linux x86_64)", configurable: true });
    await searchForCode();
    await notFound();
    expect(api.sendFile).not.toHaveBeenCalled();
    expect(text()).toContain(NOT_FOUND);
  });
});

describe("progress reported by the backend", () => {
  it("shows connecting and connected states", async () => {
    render();
    await settle();
    await emit({ status: "clientConnecting", data: { sessionId: "s1" } });
    expect(title()).toBe("Connecting");
    expect(text()).toContain("Finding the other device on your Wi-Fi and opening an encrypted link.");
    await emit({ status: "peerConnected", data: { sessionId: "s1" } });
    expect(title()).toBe("Connected");
    expect(document.querySelector('[aria-label="Step 2 of 3"]')).not.toBeNull();
  });

  it("applies a role chosen in step 1 as soon as the devices connect", async () => {
    render();
    await press("Send Accounts from This Device");
    await emit({ status: "roleSelection", data: { sessionId: "s1" } });
    await settle();
    expect(api.selectRole).toHaveBeenCalledWith("send");
    expect(text()).toContain("Sending from this device…");
  });

  it("asks which role to take if the devices connect with none chosen", async () => {
    render();
    await settle();
    await emit({ status: "roleSelection", data: { sessionId: "s1" } });
    expect(title()).toBe("Send or Receive Accounts");
    expect(text()).toContain("Devices are connected. Choose what this device should do:");
    await press("Receive Accounts on This Device");
    expect(api.selectRole).toHaveBeenCalledWith("receive");
  });

  it("shows the transfer in progress and blocks closing", async () => {
    render();
    await settle();
    await emit({ status: "transferring", data: { sessionId: "s1" } });
    expect(title()).toBe("Transferring");
    expect(document.querySelector<HTMLButtonElement>(".ui-modal-close")!.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
  });

  it("ignores a backdrop press while transferring, and honors it once idle", async () => {
    const pressBackdrop = async () => {
      await act(async () => {
        document.querySelector(".modal-backdrop")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
    };
    render();
    await settle();
    await emit({ status: "transferring", data: { sessionId: "s1" } });
    await pressBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    await emit({ status: "idle" });
    await pressBackdrop();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("sending once connected", () => {
  it("sends by itself, with what is being sent and no code to compare", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
    expect(title()).toBe("Sending");
    expect(document.querySelector('[aria-label="Step 3 of 3"]')).not.toBeNull();
    expect(text()).toContain("Sending 3 accounts…");
    expect(text()).not.toContain("Codes Match");
    expect(document.querySelector(".pairing-sas-badge")).toBeNull();
  });

  it("sends only once for a session, however often the status repeats", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    await emit(CONFIRM("sender"));
    expect(api.confirmTransfer).toHaveBeenCalledTimes(1);
  });

  it("gives the receiver nothing to confirm, only a way to cancel", async () => {
    render();
    await settle();
    await emit(CONFIRM("receiver"));
    expect(title()).toBe("Receiving");
    expect(text()).toContain("Receiving 3 accounts");
    expect(buttons().some((b) => b.textContent?.trim() === "Send")).toBe(false);
    await press("Cancel");
    expect(api.confirmTransfer).not.toHaveBeenCalled();
    expect(cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says one account in the singular", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender", { accountCount: 1 }));
    expect(text()).toContain("Sending 1 account…");
    expect(text()).not.toContain("1 accounts");
  });

  it("reads the same details from a snake_case payload", async () => {
    render();
    await settle();
    await emit({
      status: "confirmTransfer",
      data: { session_id: "s9", role: "sender", account_count: 5 },
    } as unknown as PairingStatus);
    expect(text()).toContain("Sending 5 accounts…");
    expect(api.confirmTransfer).toHaveBeenCalledWith("s9", true);
  });

  it("sends the settings and layout by default", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    expect(api.setIncludeSettings).toHaveBeenCalledWith(true);
    expect(api.setPendingUiState).toHaveBeenCalledWith({ marker: true });
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
  });

  it("excludes settings and layout when the sender unchecks the option", async () => {
    render();
    const toggle = document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!;
    click(toggle);
    await settle();
    await emit(CONFIRM("sender"));
    expect(api.setIncludeSettings).toHaveBeenCalledWith(false);
    expect(api.clearPendingUiState).toHaveBeenCalled();
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
  });

  it("still sends when the settings could not be prepared", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    api.setIncludeSettings.mockRejectedValue(new Error("nope"));
    render();
    await settle();
    await emit(CONFIRM("sender"));
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
  });

  it("shows an error and offers Send if sending fails", async () => {
    api.confirmTransfer.mockRejectedValue(new Error("link dropped"));
    render();
    await settle();
    await emit(CONFIRM("sender"));
    expect(text()).toContain("link dropped");
    expect(button("Send").disabled).toBe(false);
    await press("Send");
    expect(api.confirmTransfer).toHaveBeenCalledTimes(2);
  });
});

describe("accepting the other device's settings", () => {
  it("tells the backend this device's choice when it shows a link code", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(api.startHost).toHaveBeenLastCalledWith(true, false);
  });

  it("passes an unticked choice when it shows or enters a code", async () => {
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await settle();
    await press("Receive Accounts on This Device");
    expect(api.startHost).toHaveBeenLastCalledWith(false, false);
  });
});

describe("finishing", () => {
  const COMPLETED = { status: "completed", data: { summary: { added: 2, updated: 1, skipped: 4 } } } as unknown as PairingStatus;

  it("shows the summary and tells the app once", async () => {
    render();
    await settle();
    await emit(COMPLETED);
    expect(title()).toBe("Devices linked");
    expect(text()).toContain("+2");
    expect(text()).toContain("↻ 1");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    await emit(COMPLETED);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("shows no warning when everything was saved", async () => {
    render();
    await settle();
    await emit({ status: "completed", data: { summary: { added: 1, updated: 0, skipped: 0, warnings: [] } } } as unknown as PairingStatus);
    expect(document.querySelector("[role=alert]")).toBeNull();
    await emit(COMPLETED);
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("lists what could not be saved on this device", async () => {
    render();
    await settle();
    await emit({
      status: "completed",
      data: { summary: { added: 1, updated: 0, skipped: 0, warnings: ["Some settings couldn't be applied.", "The account order couldn't be saved."] } },
    } as unknown as PairingStatus);
    const alert = document.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("not everything could be saved");
    expect(alert?.textContent).toContain("Some settings couldn't be applied.");
    expect(alert?.textContent).toContain("The account order couldn't be saved.");
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("closes from Done without telling the app twice", async () => {
    render();
    await settle();
    await emit(COMPLETED);
    await press("Done");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelPairing).toHaveBeenCalled();
  });

  it("shows a failure with Try Again, which returns to the other ways to connect", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Scan QR Code");
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "peer vanished" } } });
    expect(text()).toContain("Pairing Failed");
    expect(text()).toContain("peer vanished");
    expect(document.querySelector(".pairing-step-dots")).toBeNull();
    await press("Try Again");
    expect(cancelPairing).toHaveBeenCalled();
    expect(title()).toBe("Other Ways to Connect");
  });

  it("keeps the pairing-failed reason past 10 seconds, until its X closes it", async () => {
    vi.useFakeTimers();
    try {
      render();
      await press("Send Accounts from This Device");
      await press("Other ways to connect");
      await press("Scan QR Code");
      const failed = { status: "failed" as const, data: { error: { code: "pairing" as const, message: "peer vanished" } } };
      api.status.mockResolvedValue(failed);
      await emit(failed);
      expect(document.querySelector(".modal-error")?.textContent).toContain("peer vanished");
      expect(text()).toContain("Pairing Failed");
      await act(async () => {
        vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS - 1);
        await Promise.resolve();
      });
      await emit(failed);
      expect(document.querySelector(".modal-error")?.textContent).toContain("peer vanished");
      await act(async () => {
        vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS * 2);
        await Promise.resolve();
      });
      expect(document.querySelector(".modal-error")?.textContent).toContain("peer vanished");
      click(document.querySelector<HTMLButtonElement>(".dialog-error-dismiss")!);
      await emit(failed);
      expect(document.querySelector(".modal-error")).toBeNull();
      expect(text()).toContain("Pairing Failed");
      expect(button("Try Again")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the host session from Try Again when showing a code", async () => {
    render();
    await press("Receive Accounts on This Device");
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "timed out" } } });
    await press("Try Again");
    expect(api.startHost).toHaveBeenCalledTimes(2);
  });

  it("offers Back and Try Again, not Close, after a failure", async () => {
    render();
    await settle();
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "x" } } });
    expect(button("Try Again")?.className).toContain("button primary");
    expect(button("Back")).toBeDefined();
    expect(buttons().some((b) => b.textContent === "Close")).toBe(false);
  });

  it("cancels the pairing when the dialog is closed", async () => {
    render();
    await settle();
    click(document.querySelector(".ui-modal-close")!);
    expect(cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("starts over each time it is reopened", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(title()).toBe("Your Link Code");
    mounted.rerender(<PairingModal open={false} onClose={onClose} onCompleted={onCompleted} />);
    expect(document.querySelector(".pairing-modal")).toBeNull();
    mounted.rerender(<PairingModal open onClose={onClose} onCompleted={onCompleted} />);
    await settle();
    expect(title()).toBe("Send or Receive Accounts");
  });
});

describe("air-gap transfer: sending", () => {
  async function openSender() {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Show QR Code");
  }

  it("prepares the export and shows the first frame with settings by default", async () => {
    await openSender();
    expect(api.prepareAirgapExport).toHaveBeenCalledWith(true, { marker: true });
    expect(title()).toBe("Show QR Code");
    expect(text()).toContain("A photo or screen recording of these frames can decrypt the accounts in this transfer.");
    expect(text()).toContain("Frame 1/3");
    // Drawn from the frame's modules inside the 4-module quiet zone, not from backend markup.
    expect(document.querySelector(".airgap-qr-card svg path")?.getAttribute("d")).toBe("M4 4h1v1h-1z");
    expect(document.querySelector(".airgap-qr-card svg")?.getAttribute("viewBox")).toBe("0 0 9 9");
  });

  it("excludes settings and layout when unchecking the option in step 1", async () => {
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Show QR Code");
    expect(api.prepareAirgapExport).toHaveBeenCalledWith(false, undefined);
  });

  it("pauses, resumes, and changes speed", async () => {
    await openSender();
    expect(button("Pause").classList.contains("primary")).toBe(true);
    expect(button("Pause").classList.contains("airgap-play-btn")).toBe(true);
    await press("Pause");
    expect(button("Play")).toBeDefined();
    expect(button("Play").classList.contains("primary")).toBe(true);
    expect(button("Play").classList.contains("airgap-play-btn")).toBe(true);
    await press("Play");
    expect(text()).toContain("Speed: Normal");
    await press("Speed: Normal");
    expect(text()).toContain("Speed: Slow");
  });

  it("steps through the frames while playing", async () => {
    await openSender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(text()).toMatch(/Frame [23]\/3/);
  });

  it("has no code to compare: Done closes the dialog and ends the transfer", async () => {
    await openSender();
    expect(text()).not.toContain("click here to continue");
    expect(document.querySelector(".pairing-sas-badge")).toBeNull();
    expect(text()).toContain("it asks there to add the accounts");
    await press("Done");
    expect(cancelPairing).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows why the export failed, with a retry instead of an endless spinner", async () => {
    api.prepareAirgapExport.mockRejectedValueOnce(new Error("too many accounts"));
    await openSender();
    expect(text()).toContain("Couldn't prepare the transfer");
    expect(document.querySelector(".pairing-panel-status .pairing-nav-row button")?.textContent).toContain("Back");
    expect(document.querySelectorAll(".error-panel.modal-error")).toHaveLength(1);
    expect(text()).toContain("too many accounts");
    expect(text()).not.toContain("Preparing animated transfer…");
    expect(document.querySelector(".spinner")).toBeNull();
    await press("Try Again");
    expect(api.prepareAirgapExport).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Frame 1/3");
  });

  it("auto-dismisses the export error after 10 seconds and keeps Try Again", async () => {
    vi.useFakeTimers();
    try {
      api.prepareAirgapExport.mockRejectedValueOnce(new Error("too many accounts"));
      await openSender();
      expect(text()).toContain("Couldn't prepare the transfer");
      expect(document.querySelector(".error-panel.modal-error")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(ERROR_AUTO_DISMISS_MS);
      });
      expect(document.querySelector(".error-panel.modal-error")).toBeNull();
      expect(text()).toContain("Couldn't prepare the transfer");
      expect(text()).not.toContain("Preparing animated transfer…");
      expect(button("Try Again")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to the other ways to connect when the export failed without carrying the error", async () => {
    api.prepareAirgapExport.mockRejectedValueOnce(new Error("The transfer was cancelled."));
    await openSender();
    expect(text()).toContain("The transfer was cancelled.");
    expect(document.querySelector(".airgap-sender-view")).not.toBeNull();
    await press("Back");
    expect(title()).toBe("Other Ways to Connect");
    expect(document.querySelector(".airgap-sender-view")).toBeNull();
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("The transfer was cancelled.");

    // Navigating forward to "Enter Link Code" also has no leftover error banner
    await press("Enter Link Code");
    expect(title()).toBe("Enter Link Code");
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("The transfer was cancelled.");
  });

  it("returns to the other ways to connect from Back", async () => {
    await openSender();
    await press("Back");
    expect(title()).toBe("Other Ways to Connect");
    expect(document.querySelector(".airgap-sender-view")).toBeNull();
  });

  it("cancels the transfer on Back exactly as Escape does", async () => {
    await openSender();
    cancelPairing.mockClear();
    await press("Back");
    expect(cancelPairing).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Other Ways to Connect");

    await press("Show QR Code");
    cancelPairing.mockClear();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(cancelPairing).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Other Ways to Connect");
    expect(document.querySelector(".airgap-sender-view")).toBeNull();
  });
});

describe("scanning", () => {
  async function openScanner() {
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Scan QR Code");
  }

  it("asks for camera permission, then shows the scanner", async () => {
    await openScanner();
    expect(api.ensureCameraPermission).toHaveBeenCalled();
    expect(title()).toBe("Scan QR Code");
    expect(document.querySelector(".pairing-scanner-view")).not.toBeNull();
    expect(scanner.options?.active).toBe(true);
  });

  it("still shows the scanner when the permission request fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    api.ensureCameraPermission.mockRejectedValue(new Error("denied"));
    await openScanner();
    expect(document.querySelector(".pairing-scanner-view")).not.toBeNull();
  });

  it("shows a camera error, hides the scan beam, and retries the camera", async () => {
    await openScanner();
    const video = document.querySelector<HTMLVideoElement>(".pairing-scanner-video")!;
    await act(async () => {
      video.dispatchEvent(new Event("playing"));
    });
    expect(document.querySelector(".pairing-scan-beam")).not.toBeNull();
    await act(async () => scanner.setCameraError!("No camera found"));
    expect(text()).toContain("No camera found");
    expect(document.querySelector(".pairing-scan-beam")).toBeNull();
    const restartKey = scanner.options!.restartKey;
    await press("Retry Camera");
    expect(scanner.options!.restartKey).toBe(restartKey + 1);
    expect(text()).not.toContain("No camera found");
    expect(document.querySelector(".pairing-scan-beam")).not.toBeNull();
  });

  it("keeps Retry Camera and hides the scan beam after the camera error message goes away", async () => {
    await openScanner();
    const video = document.querySelector<HTMLVideoElement>(".pairing-scanner-video")!;
    await act(async () => {
      video.dispatchEvent(new Event("playing"));
    });
    await act(async () => scanner.setCameraError!("No camera found"));
    expect(text()).toContain("No camera found");
    // The scanner hook dismisses the message by itself after a few seconds (its own test covers that).
    await act(async () => scanner.setCameraError!(null));
    expect(text()).not.toContain("No camera found");
    expect(button("Retry Camera")).toBeDefined();
    expect(document.querySelector(".pairing-scan-beam")).toBeNull();
  });

  it("places the camera error message below the Back button and controls", async () => {
    await openScanner();
    await act(async () => scanner.setCameraError!("Camera permission was denied."));
    const errorEl = document.querySelector(".pairing-camera-error")!;
    const backBtn = document.querySelector(".pairing-scan-actions .pairing-back-btn")!;
    expect(errorEl).not.toBeNull();
    expect(backBtn).not.toBeNull();
    expect(Boolean(backBtn.compareDocumentPosition(errorEl) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("announces status changes through a live region", async () => {
    render();
    await settle();
    const live = document.querySelector("[role=status]");
    expect(live?.classList.contains("sr-only")).toBe(true);
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toContain("Send or Receive Accounts");
    await press("Send Accounts from This Device");
    expect(live?.textContent).toContain("Link Code");
  });

  it("heads failures Pairing Failed, shows the reason as an alert and moves focus to Try Again", async () => {
    render();
    await settle();
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "The other device left." } } });
    expect(title()).toBe("Pairing Failed");
    expect(document.querySelectorAll("h2, h3").length).toBe(1);
    expect(document.querySelector(".modal-error")?.getAttribute("role")).toBe("alert");
    expect(document.querySelector(".modal-error")?.textContent).toBe("The other device left.");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(document.activeElement).toBe(button("Try Again"));
  });

  it("uses spans, not headings, inside the send/receive buttons", () => {
    render();
    expect(document.querySelector(".pairing-role-card h4")).toBeNull();
    expect(document.querySelector(".pairing-role-card p")).toBeNull();
    expect(document.querySelector(".pairing-role-card .pairing-role-card-title")?.textContent).toContain("Send Accounts");
  });

  it("forwards taps and camera switches to the scanner", async () => {
    await openScanner();
    click(document.querySelector(".pairing-scanner-box")!);
    expect(scanner.handleScannerTap).toHaveBeenCalled();
    click(document.querySelector('[aria-label="Switch camera"]') ?? document.createElement("i"));
  });

  it("styles the Back button as the default (primary) button", async () => {
    await openScanner();
    const backBtn = document.querySelector(".pairing-scan-actions .pairing-back-btn");
    expect(backBtn?.classList.contains("primary")).toBe(true);
    expect(backBtn?.classList.contains("ghost")).toBe(false);
    expect(backBtn?.classList.contains("button")).toBe(true);
  });

  it("places the switch camera button in the same controls row as the Back button", async () => {
    await openScanner();
    const controls = document.querySelector(".pairing-scan-actions")!;
    const switchBtn = controls.querySelector(".pairing-switch-camera-fab");
    const backBtn = controls.querySelector(".pairing-back-btn");
    expect(controls).not.toBeNull();
    expect(switchBtn).not.toBeNull();
    expect(backBtn).not.toBeNull();
  });

  it("cancels the pairing and goes back from Back", async () => {
    await openScanner();
    await press("Back");
    expect(cancelPairing).toHaveBeenCalled();
    expect(title()).toBe("Other Ways to Connect");
    expect(scanner.options?.active).toBe(false);
  });

  it("scans for the air-gap sender's animated code", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Scan QR Code");
    expect(title()).toBe("Scan QR Code");
    expect(text()).toContain("Point the camera at the QR code on the other device.");
  });
});

describe("air-gap transfer: receiving", () => {
  const FRAME_1 = "aiut-airgap://1/sess-1/1/2/aa?d=a";
  const FRAME_2 = "aiut-airgap://1/sess-1/2/2/bb?d=b";

  /** Feeds scanned frames to the screen the way the scanner hook does. */
  async function scan(...codes: string[]) {
    for (const code of codes) {
      await act(async () => {
        await scanner.options!.onDecoded(code, { stopCamera: scanner.stopCamera });
      });
    }
  }

  async function captureAll() {
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Scan QR Code");
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    await scan(FRAME_1);
    now.mockReturnValue(1_007_000);
    await scan(FRAME_2);
    now.mockRestore();
    await settle();
  }

  it("opens the captured frames and asks to add the accounts, with no code to compare", async () => {
    api.previewAirgapFrames.mockResolvedValue({ sessionId: "sess-1", totalChunks: 2, accountCount: 3, ticket: "ticket-1" });
    await captureAll();
    expect(api.previewAirgapFrames).toHaveBeenCalledWith([FRAME_1, FRAME_2]);
    expect(title()).toBe("Add the accounts");
    expect(text()).toContain("Captured all 2 frames in 7 seconds");
    expect(text()).toContain("Add 3 accounts from the other device?");
    expect(document.querySelector(".pairing-sas-badge")).toBeNull();
    // Nothing is imported until the user agrees.
    expect(api.importAirgapFrames).not.toHaveBeenCalled();
  });

  it("imports the frames once the user agrees to add them", async () => {
    api.previewAirgapFrames.mockResolvedValue({ sessionId: "sess-1", totalChunks: 2, accountCount: 3, ticket: "ticket-1" });
    api.importAirgapFrames.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    await captureAll();
    await press("Add Accounts");
    // The receiving device's own "Also Sync Settings and Layout" choice goes with the import.
    expect(api.importAirgapFrames).toHaveBeenCalledWith([FRAME_1, FRAME_2], "ticket-1", true);
    expect(title()).toBe("Devices linked");
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("shows an import error and stays on the comparison", async () => {
    api.previewAirgapFrames.mockResolvedValue({ sessionId: "sess-1", totalChunks: 2, accountCount: 3, ticket: "ticket-1" });
    api.importAirgapFrames.mockRejectedValue(new Error("wrong key"));
    await captureAll();
    await press("Add Accounts");
    expect(text()).toContain("wrong key");
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("restarts the scan when the frames fail verification", async () => {
    api.previewAirgapFrames.mockRejectedValue(new Error("frames damaged"));
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Scan QR Code");
    const before = scanner.options!.restartKey;
    await scan("aiut-airgap://1/sess-1/1/1/aa?d=a");
    await settle();
    expect(text()).toContain("frames damaged");
    expect(scanner.options!.restartKey).toBe(before + 1);
    expect(document.querySelector(".airgap-pin-prompt-card")).toBeNull();
  });

  it("returns to scanning from Back on the prompt", async () => {
    api.previewAirgapFrames.mockResolvedValue({ sessionId: "sess-1", totalChunks: 2, accountCount: 3, ticket: "ticket-1" });
    await captureAll();
    const before = scanner.options!.restartKey;
    await press("Back");
    expect(document.querySelector(".airgap-pin-prompt-card")).toBeNull();
    expect(document.querySelector(".pairing-scanner-view")).not.toBeNull();
    expect(scanner.options!.restartKey).toBe(before + 1);
  });
});
