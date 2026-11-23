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
  openWifiSettings: vi.fn(),
  makeFileRequest: vi.fn(),
  makeFileReply: vi.fn(),
  shareFile: vi.fn(),
  saveFile: vi.fn(),
  openFileRequest: vi.fn(),
  openFileReply: vi.fn(),
  importFileReply: vi.fn(),
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
async function emit(status: PairingStatus) {
  await act(async () => {
    events.handler?.({ payload: status });
  });
}

const HOST_INIT = { sessionId: "s1", joinCode: "123456", expiresAt: Math.floor(Date.now() / 1000) + 125 };
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
  api.wifiEnabled.mockResolvedValue(true);
  api.openWifiSettings.mockResolvedValue(undefined);
  // A Mac: the files go out through the share menu.
  api.makeFileRequest.mockResolvedValue(true);
  api.makeFileReply.mockResolvedValue(true);
  api.shareFile.mockResolvedValue(undefined);
  api.saveFile.mockResolvedValue(true);
  api.openFileRequest.mockResolvedValue({ accountCount: 3 });
  api.openFileReply.mockResolvedValue({ accountCount: 2, ticket: "ticket-1" });
  api.importFileReply.mockResolvedValue({ added: 2, updated: 0, skipped: 0, warnings: [] });
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
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
    expect(document.querySelector(".modal-kicker")?.textContent).toBe("Sync devices over local network");
    expect(document.querySelector('[aria-label="Step 1 of 3"]')).not.toBeNull();
    expect(text()).toContain("Send Accounts from This Device");
    expect(text()).toContain("Receive Accounts on This Device");
    expect(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")?.checked).toBe(true);
    expect(document.querySelector(".pairing-settings-toggle span")?.textContent).toContain("Also Transfer Settings & Layout");
    expect(document.querySelector(".pairing-settings-toggle small")?.textContent).toBe(
      "Includes appearance, menu bar labels, launch at startup, whether the local API is on, account refresh intervals, automatic updates, app alerts, and card ordering."
    );
  });

  it("shows a link code at once when sending", async () => {
    render();
    await press("Send Accounts from This Device");
    expect(title()).toBe("Link Code");
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(text()).toContain("go to Settings → Sync Devices, select Receive, and enter this code");
  });

  it("asks for the link code at once when receiving", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(title()).toBe("Enter Link Code");
    expect(api.startHost).not.toHaveBeenCalled();
    expect(text()).toContain("shown on the sending device");
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

  it("lets a receiver show the code instead, for an older sender", async () => {
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(title()).toBe("Link Code");
    expect(api.startHost).toHaveBeenCalledTimes(1);
  });

  it("goes back from the other ways to the role choice", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Other ways to connect");
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
  });
});

describe("mobile Wi-Fi prompt for link codes", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14)",
      configurable: true,
    });
  });

  it("starts the host session when Wi-Fi is already on", async () => {
    render();
    await press("Send Accounts from This Device");
    expect(api.wifiEnabled).toHaveBeenCalled();
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain("Turn on Wi-Fi");
  });

  it("asks to turn Wi-Fi on instead of starting a session when it is off", async () => {
    api.wifiEnabled.mockResolvedValue(false);
    render();
    await press("Send Accounts from This Device");
    expect(api.startHost).not.toHaveBeenCalled();
    expect(document.querySelector(".confirm-dialog-backdrop")?.textContent).toContain("Turn on Wi-Fi");
    expect(title()).toBe("Send or Receive Accounts");
  });

  it("opens system Wi-Fi settings from the prompt", async () => {
    api.wifiEnabled.mockResolvedValue(false);
    render();
    await press("Send Accounts from This Device");
    await press("Turn On Wi-Fi");
    expect(api.openWifiSettings).toHaveBeenCalledTimes(1);
    expect(api.startHost).not.toHaveBeenCalled();
  });

  it("offers the other ways to connect when the prompt is declined", async () => {
    api.wifiEnabled.mockResolvedValue(false);
    render();
    await press("Send Accounts from This Device");
    const decline = document.querySelector<HTMLButtonElement>(".confirm-dialog-backdrop .button.ghost")!;
    expect(decline.textContent).toBe("Other Ways");
    click(decline);
    await settle();
    expect(document.querySelector(".confirm-dialog-backdrop")).toBeNull();
    expect(api.startHost).not.toHaveBeenCalled();
    expect(title()).toBe("Other Ways to Connect");
  });

  it("continues into Enter Link Code after Wi-Fi is turned on", async () => {
    api.wifiEnabled.mockResolvedValue(false);
    render();
    await press("Receive Accounts on This Device");
    expect(title()).toBe("Send or Receive Accounts");
    expect(document.querySelector(".confirm-dialog-backdrop")).not.toBeNull();
    api.wifiEnabled.mockResolvedValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(document.querySelector(".confirm-dialog-backdrop")).toBeNull();
    expect(title()).toBe("Enter Link Code");
  });
});

describe("showing a link code", () => {
  async function openHost() {
    render();
    await press("Send Accounts from This Device");
  }

  it("starts a host session and shows the code and a countdown", async () => {
    await openHost();
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Link Code");
    expect(text()).toContain("123 456");
    expect(text()).toMatch(/Expires in\s*2:0\d/);
    expect(text()).toContain("Waiting for the other device to connect…");
  });

  it("shows a progress message until the code arrives", async () => {
    api.startHost.mockReturnValue(new Promise(() => {}));
    render();
    await press("Send Accounts from This Device");
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
    await press("Receive Accounts on This Device");
  }
  const input = () => document.getElementById("pairing-join-code-input") as HTMLInputElement;

  it("keeps only digits, at most six, and enables Connect at six", async () => {
    await openCodeEntry();
    expect(title()).toBe("Enter Link Code");
    expect(button("Connect to Device").disabled).toBe(true);
    typeInto(input(), "12ab34c");
    expect(input().value).toBe("1234");
    expect(button("Connect to Device").disabled).toBe(true);
    typeInto(input(), "1234567890");
    expect(input().value).toBe("123456");
    expect(button("Connect to Device").disabled).toBe(false);
  });

  it("provides an accessible name for the code input", async () => {
    await openCodeEntry();
    expect(input().getAttribute("aria-label")).toBe("Link code");
  });

  it("connects with the code", async () => {
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect to Device");
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
    await press("Connect to Device");
    expect(text()).toContain("code not found");
    expect(button("Connect to Device").disabled).toBe(false);
  });

  it("clears connection error when going back to the role choice", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect to Device");
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
    await press("Connect to Device");
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
    await press("Connect to Device");
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
    await press("Connect to Device");
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
      await press("Connect to Device");
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
    await press("Connect to Device");
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "The link to the other device broke." } } });
    await press("Try Again");
    expect(title()).toBe("Enter Link Code");
    expect(input().value).toBe("123456");
  });
});

describe("transfer by file", () => {
  const codeInput = () => document.getElementById("pairing-join-code-input") as HTMLInputElement;

  async function receiveWithCode() {
    render();
    await press("Receive Accounts on This Device");
    typeInto(codeInput(), "123456");
  }

  it("makes a request for the typed code, shares it, then opens and adds the reply", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(button("Use a file instead").disabled).toBe(true);
    typeInto(codeInput(), "123456");
    await press("Use a file instead");
    expect(api.makeFileRequest).toHaveBeenCalledWith("123456");
    expect(api.shareFile).toHaveBeenCalledTimes(1);
    expect(api.saveFile).not.toHaveBeenCalled();
    expect(title()).toBe("Receive by File");
    expect(text()).toContain("Request ready");

    await press("Open Reply…");
    expect(text()).toContain("Add 2 accounts?");
    expect(api.importFileReply).not.toHaveBeenCalled();
    await press("Add Accounts");
    expect(api.importFileReply).toHaveBeenCalledWith("ticket-1", true);
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("shares again or saves a copy of the request", async () => {
    await receiveWithCode();
    await press("Use a file instead");
    await press("Share the request again");
    expect(api.shareFile).toHaveBeenCalledTimes(2);
    await press("Save the request to a file");
    expect(api.saveFile).toHaveBeenCalledTimes(1);
  });

  it("saves the request where there is no share menu", async () => {
    api.makeFileRequest.mockResolvedValue(false);
    await receiveWithCode();
    await press("Use a file instead");
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    expect(api.shareFile).not.toHaveBeenCalled();
    expect(text()).not.toContain("Share the request again");
    expect(text()).toContain("Save the request to a file");
  });

  it("stays on the code when the request can't be made", async () => {
    api.makeFileRequest.mockRejectedValue({ code: "pairing", message: "Enter the 6-digit code shown on the other device." });
    await receiveWithCode();
    await press("Use a file instead");
    expect(title()).toBe("Enter Link Code");
    expect(document.querySelector(".modal-error")?.textContent).toContain("Enter the 6-digit code");
  });

  it("keeps waiting when the open dialog is cancelled, and goes back to the code", async () => {
    api.openFileReply.mockResolvedValue(null);
    await receiveWithCode();
    await press("Use a file instead");
    await press("Open Reply…");
    expect(text()).toContain("Request ready");
    await press("Back");
    expect(title()).toBe("Enter Link Code");
  });

  it("shows why a reply did not open", async () => {
    api.openFileReply.mockRejectedValue({
      code: "pairing",
      message: "This reply doesn't match the code you entered, or the file is damaged. Start again on both devices.",
    });
    await receiveWithCode();
    await press("Use a file instead");
    await press("Open Reply…");
    expect(document.querySelector(".modal-error")?.textContent).toContain("doesn't match the code you entered");
  });

  it("answers a request while showing the code, after the user agrees", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Open a request file");
    expect(title()).toBe("Send by File");
    expect(text()).toContain("Send 3 accounts?");
    expect(api.makeFileReply).not.toHaveBeenCalled();
    await press("Send Reply");
    expect(api.makeFileReply).toHaveBeenCalledWith(true, { marker: true });
    expect(api.shareFile).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Reply ready");
    await press("Save the reply to a file");
    expect(api.saveFile).toHaveBeenCalledTimes(1);
    expect(api.makeFileReply).toHaveBeenCalledTimes(1);
    await press("Done");
    expect(onClose).toHaveBeenCalled();
  });

  it("sends no layout when settings are left out", async () => {
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await settle();
    await press("Send Accounts from This Device");
    await press("Open a request file");
    await press("Send Reply");
    expect(api.makeFileReply).toHaveBeenCalledWith(false, undefined);
  });

  it("goes back to the code without ending the session", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Open a request file");
    cancelPairing.mockClear();
    await press("Back");
    expect(title()).toBe("Link Code");
    expect(cancelPairing).not.toHaveBeenCalled();
  });

  it("is not offered on a phone yet", async () => {
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
    render();
    await press("Send Accounts from This Device");
    expect(text()).not.toContain("Open a request file");
    await press("Back");
    await press("Receive Accounts on This Device");
    expect(text()).not.toContain("Use a file instead");
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

describe("confirming the transfer", () => {
  it("asks the sender once, with what will be sent and no code to compare", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    expect(title()).toBe("Confirm the transfer");
    expect(document.querySelector('[aria-label="Step 3 of 3"]')).not.toBeNull();
    expect(text()).toContain("Send to the other device?");
    expect(text()).toContain("send 3 accounts");
    expect(text()).not.toContain("Codes Match");
    expect(document.querySelector(".pairing-sas-badge")).toBeNull();
  });

  it("gives the receiver nothing to confirm, only a way to cancel", async () => {
    render();
    await settle();
    await emit(CONFIRM("receiver"));
    expect(title()).toBe("Devices connected");
    expect(text()).toContain("Waiting for the other device");
    expect(text()).toContain("receive 3 accounts");
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
    expect(text()).toContain("send 1 account");
    expect(text()).not.toContain("1 accounts");
  });

  it("reads the same details from a snake_case payload", async () => {
    render();
    await settle();
    await emit({
      status: "confirmTransfer",
      data: { session_id: "s9", role: "sender", account_count: 5 },
    } as unknown as PairingStatus);
    expect(text()).toContain("send 5 accounts");
    await press("Send");
    expect(api.confirmTransfer).toHaveBeenCalledWith("s9", true);
  });

  it("sends the settings and layout by default when the sender confirms", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    await press("Send");
    expect(api.setIncludeSettings).toHaveBeenCalledWith(true);
    expect(api.setPendingUiState).toHaveBeenCalledWith({ marker: true });
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
    expect(text()).toContain("Sending…");
  });

  it("excludes settings and layout when the sender unchecks the option", async () => {
    render();
    const toggle = document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!;
    click(toggle);
    await settle();
    await emit(CONFIRM("sender"));
    await press("Send");
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
    await press("Send");
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
  });

  it("declines from the sender's Cancel", async () => {
    render();
    await settle();
    await emit(CONFIRM("sender"));
    await press("Cancel");
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", false);
    expect(api.setIncludeSettings).not.toHaveBeenCalled();
  });

  it("shows an error and re-enables Send if confirming fails", async () => {
    api.confirmTransfer.mockRejectedValue(new Error("link dropped"));
    render();
    await settle();
    await emit(CONFIRM("sender"));
    await press("Send");
    expect(text()).toContain("link dropped");
    expect(button("Send").disabled).toBe(false);
  });
});

describe("accepting the other device's settings", () => {
  it("tells the backend this device's choice when it shows a link code", async () => {
    render();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(api.startHost).toHaveBeenLastCalledWith(true);
  });

  it("passes an unticked choice when it shows or enters a code", async () => {
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await settle();
    await press("Receive Accounts on This Device");
    await press("Other ways to connect");
    await press("Show Link Code");
    expect(api.startHost).toHaveBeenLastCalledWith(false);
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

  it("auto-dismisses the pairing-failed detail after 10 seconds even if the poll repeats it", async () => {
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
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(document.querySelector(".modal-error")).toBeNull();
      expect(text()).toContain("Pairing Failed");
      expect(button("Try Again")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the host session from Try Again when showing a code", async () => {
    render();
    await press("Send Accounts from This Device");
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "timed out" } } });
    await press("Try Again");
    expect(api.startHost).toHaveBeenCalledTimes(2);
  });

  it("closes with Close after a failure", async () => {
    render();
    await settle();
    await emit({ status: "failed", data: { error: { code: "pairing" as const, message: "x" } } });
    await press("Close");
    expect(onClose).toHaveBeenCalled();
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
    await press("Send Accounts from This Device");
    expect(title()).toBe("Link Code");
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
    // The receiving device's own "Also Transfer Settings & Layout" choice goes with the import.
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
