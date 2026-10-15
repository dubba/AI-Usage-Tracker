// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AirgapExport, PairingStatus } from "../../types";

const api = vi.hoisted(() => ({
  startHost: vi.fn(),
  startClient: vi.fn(),
  startClientByCode: vi.fn(),
  selectRole: vi.fn(),
  confirmSas: vi.fn(),
  cancel: vi.fn(),
  status: vi.fn(),
  getPendingPairingUri: vi.fn(),
  setIncludeSettings: vi.fn(),
  setPendingUiState: vi.fn(),
  clearPendingUiState: vi.fn(),
  prepareAirgapExport: vi.fn(),
  verifyAirgapFrames: vi.fn(),
  importAirgapFrames: vi.fn(),
  ensureCameraPermission: vi.fn(),
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
  setCameraError: (value: string | null) => void;
  setAirgapCapturedChunks: (value: Map<number, string>) => void;
  setAirgapTotalChunks: (value: number) => void;
  setAirgapPinPrompt: (value: boolean) => void;
  setAirgapCaptureSecs: (value: number | null) => void;
  airgapVerifyPromptRef: { current: boolean };
};
const scanner = vi.hoisted(() => ({
  options: null as null | ScannerOptions,
  videoRef: { current: null },
  streamRef: { current: null },
  handleScannerTap: vi.fn(),
  handleSwitchCamera: vi.fn(),
}));
vi.mock("./hooks/useQrScanner", () => ({
  useQrScanner: (options: ScannerOptions) => {
    scanner.options = options;
    return {
      videoRef: scanner.videoRef,
      streamRef: scanner.streamRef,
      handleScannerTap: scanner.handleScannerTap,
      handleSwitchCamera: scanner.handleSwitchCamera,
    };
  },
}));
vi.mock("../dashboard/ui-state", () => ({ collectUiState: () => ({ marker: true }) }));

import { click, mount, settle, typeInto, type Mounted } from "../../test-utils/react";
import { PairingModal } from "./PairingModal";

const onClose = vi.fn();
const onCompleted = vi.fn();
let mounted: Mounted;

const QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>';
const AIRGAP: AirgapExport = {
  frames: [{ svg: QR }, { svg: QR }, { svg: QR }],
  totalChunks: 3,
  verifyCode: "482 193",
} as unknown as AirgapExport;

function render(props: { open?: boolean; initialJoinUri?: string | null } = {}) {
  mounted = mount(<PairingModal open={props.open ?? true} initialJoinUri={props.initialJoinUri} onClose={onClose} onCompleted={onCompleted} />);
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

const HOST_INIT = { sessionId: "s1", qrSvg: QR, qrUri: "aiusage-pair:abc", fingerprint: "ff:ee", joinCode: "123456", expiresAt: Math.floor(Date.now() / 1000) + 125 };
const SAS = (role: "sender" | "receiver", extra: object = {}) =>
  ({ status: "sasVerification", data: { sessionId: "s1", sasCode: "905 112", fingerprint: "ff", role, accountCount: 3, ...extra } }) as PairingStatus;

beforeEach(() => {
  vi.clearAllMocks();
  events.handler = null;
  scanner.options = null;
  api.status.mockResolvedValue({ status: "idle" });
  api.getPendingPairingUri.mockResolvedValue(null);
  api.startHost.mockResolvedValue(HOST_INIT);
  api.startClient.mockResolvedValue(undefined);
  api.startClientByCode.mockResolvedValue(undefined);
  api.selectRole.mockResolvedValue(undefined);
  api.confirmSas.mockResolvedValue(undefined);
  api.cancel.mockResolvedValue(undefined);
  api.setIncludeSettings.mockResolvedValue(undefined);
  api.setPendingUiState.mockResolvedValue(undefined);
  api.clearPendingUiState.mockResolvedValue(undefined);
  api.prepareAirgapExport.mockResolvedValue(AIRGAP);
  api.ensureCameraPermission.mockResolvedValue(undefined);
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
    expect(document.querySelector('[aria-label="Step 1 of 3"]')).not.toBeNull();
    expect(text()).toContain("Send Accounts from This Device");
    expect(text()).toContain("Receive Accounts on This Device");
    expect(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")?.checked).toBe(true);
  });

  it("offers every way to connect when sending", async () => {
    render();
    await press("Send Accounts from This Device");
    expect(title()).toBe("How to Connect Devices");
    for (const label of ["Show Link Code", "Enter Link Code", "Show QR Code", "Scan QR Code"]) expect(text()).toContain(label);
  });

  it("does not offer the animated QR code when receiving", async () => {
    render();
    await press("Receive Accounts on This Device");
    expect(text()).toContain("Show Link Code");
    expect(text()).not.toContain("Show QR Code");
  });

  it("goes back from the connection choices to the role choice", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Back");
    expect(title()).toBe("Send or Receive Accounts");
  });
});

describe("showing a link code", () => {
  async function openHost() {
    render();
    await press("Send Accounts from This Device");
    await press("Show Link Code");
  }

  it("starts a host session and shows the code and a countdown", async () => {
    await openHost();
    expect(api.startHost).toHaveBeenCalledTimes(1);
    expect(title()).toBe("Show Link Code");
    expect(text()).toContain("123 456");
    expect(text()).toMatch(/Expires in\s*2:0\d/);
    expect(text()).toContain("Waiting for the other device to connect…");
  });

  it("shows a progress message until the code arrives", async () => {
    api.startHost.mockReturnValue(new Promise(() => {}));
    render();
    await press("Send Accounts from This Device");
    await press("Show Link Code");
    expect(text()).toContain("Starting pairing session…");
  });

  it("shows why the session could not start", async () => {
    api.startHost.mockRejectedValue(new Error("no network"));
    await openHost();
    expect(text()).toContain("no network");
  });

  it("cancels the session and returns to the choices on Back", async () => {
    await openHost();
    await press("Back");
    expect(cancelPairing).toHaveBeenCalled();
    expect(title()).toBe("How to Connect Devices");
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
    await press("Enter Link Code");
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
    expect(api.startClientByCode).toHaveBeenCalledWith("123456");
  });

  it("connects when Enter is pressed on a full code only", async () => {
    await openCodeEntry();
    typeInto(input(), "123");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.startClientByCode).not.toHaveBeenCalled();
    typeInto(input(), "123456");
    act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(api.startClientByCode).toHaveBeenCalledWith("123456");
  });

  it("shows a connection error and lets the user retry", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect to Device");
    expect(text()).toContain("code not found");
    expect(button("Connect to Device").disabled).toBe(false);
  });

  it("clears connection error when going back to the connection choices", async () => {
    api.startClientByCode.mockRejectedValue(new Error("code not found"));
    await openCodeEntry();
    typeInto(input(), "123456");
    await press("Connect to Device");
    expect(text()).toContain("code not found");
    expect(document.querySelector(".modal-error")).not.toBeNull();
    await press("Back");
    expect(title()).toBe("How to Connect Devices");
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
    expect(title()).toBe("How to Connect Devices");
    expect(document.querySelector(".modal-error")).toBeNull();

    // Now the in-flight connect fails with mDNS resolution error
    await act(async () => {
      rejectConnect(new Error("No matching service found for link code 016142"));
    });

    // The error MUST NOT appear on "How to Connect Devices"!
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

  it("auto-dismisses the connection error after 6 seconds", async () => {
    vi.useFakeTimers();
    try {
      api.startClientByCode.mockRejectedValue(new Error("code not found"));
      await openCodeEntry();
      typeInto(input(), "123456");
      await press("Connect to Device");
      expect(text()).toContain("code not found");
      expect(document.querySelector(".modal-error")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(6000);
      });
      expect(document.querySelector(".modal-error")).toBeNull();
      expect(text()).not.toContain("code not found");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes back to the connection choices", async () => {
    await openCodeEntry();
    await press("Back");
    expect(title()).toBe("How to Connect Devices");
  });
});

describe("opening from a pairing link", () => {
  it("connects straight away with the link it was opened with", async () => {
    render({ initialJoinUri: "aiusage-pair:xyz" });
    await settle();
    expect(api.startClient).toHaveBeenCalledWith("aiusage-pair:xyz");
    expect(title()).toBe("Connecting");
  });

  it("uses a link the backend already holds", async () => {
    api.getPendingPairingUri.mockResolvedValue("aiusage:held");
    render();
    await settle();
    expect(api.startClient).toHaveBeenCalledWith("aiusage:held");
  });

  it("ignores a held value that is not a pairing link", async () => {
    api.getPendingPairingUri.mockResolvedValue("https://example.com");
    render();
    await settle();
    expect(api.startClient).not.toHaveBeenCalled();
    expect(title()).toBe("Send or Receive Accounts");
  });

  it("shows the failure when the link cannot be used", async () => {
    api.startClient.mockRejectedValue(new Error("expired link"));
    render({ initialJoinUri: "aiusage-pair:xyz" });
    await settle();
    expect(text()).toContain("Pairing Failed");
    expect(text()).toContain("expired link");
  });

  it("repeats the link join on Try Again instead of dropping to the mode picker", async () => {
    api.startClient.mockRejectedValueOnce(new Error("expired link"));
    render({ initialJoinUri: "aiusage-pair:xyz" });
    await settle();
    expect(text()).toContain("Pairing Failed");
    await press("Try Again");
    expect(api.startClient).toHaveBeenCalledTimes(2);
    expect(api.startClient).toHaveBeenLastCalledWith("aiusage-pair:xyz");
    expect(title()).toBe("Connecting");
  });
});

describe("progress reported by the backend", () => {
  it("shows connecting and connected states", async () => {
    render();
    await settle();
    await emit({ status: "clientConnecting", data: { sessionId: "s1" } });
    expect(title()).toBe("Connecting");
    expect(text()).toContain("Finding the other device on your Wi-Fi and opening an encrypted link.");
    await emit({ status: "peerConnected", data: { sessionId: "s1", fingerprint: "ff", sasCode: "1" } });
    expect(title()).toBe("Connected");
    expect(document.querySelector('[aria-label="Step 2 of 3"]')).not.toBeNull();
  });

  it("applies a role chosen in step 1 as soon as the devices connect", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Show Link Code");
    await emit({ status: "roleSelection", data: { sessionId: "s1", fingerprint: "ff", sasCode: "1" } });
    await settle();
    expect(api.selectRole).toHaveBeenCalledWith("send");
    expect(text()).toContain("Sending from this device…");
  });

  it("asks which role to take when the devices connected through a link", async () => {
    render({ initialJoinUri: "aiusage-pair:xyz" });
    await settle();
    await emit({ status: "roleSelection", data: { sessionId: "s1", fingerprint: "ff", sasCode: "1" } });
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

describe("confirming the code", () => {
  it("shows the code and what will be transferred", async () => {
    render();
    await settle();
    await emit(SAS("receiver"));
    expect(title()).toBe("Confirm the connection");
    expect(document.querySelector('[aria-label="Step 3 of 3"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Verification code 905 112"]')).not.toBeNull();
    expect(text()).toContain("Compare all three groups. Confirm only when every group matches.");
    expect(text()).toContain("receive 3 account(s)");
  });

  it("describes a sender as sending", async () => {
    render();
    await settle();
    await emit(SAS("sender"));
    expect(text()).toContain("send 3 account(s)");
  });

  it("reads the same details from a snake_case payload", async () => {
    render();
    await settle();
    await emit({
      status: "sasVerification",
      data: { sas_code: "777 888", session_id: "s9", role: "receiver", account_count: 5 },
    } as unknown as PairingStatus);
    expect(document.querySelector('[aria-label="Verification code 777 888"]')).not.toBeNull();
    expect(text()).toContain("receive 5 account(s)");
    await press("Yes, Codes Match");
    expect(api.confirmSas).toHaveBeenCalledWith("s9", true);
  });

  it("confirms without sending settings from a receiver", async () => {
    render();
    await settle();
    await emit(SAS("receiver"));
    await press("Yes, Codes Match");
    expect(api.setIncludeSettings).toHaveBeenCalledWith(false);
    expect(api.clearPendingUiState).toHaveBeenCalled();
    expect(api.confirmSas).toHaveBeenCalledWith("s1", true);
    expect(text()).toContain("Confirmed on this device. Waiting for the other device to confirm…");
  });

  it("sends the settings and layout by default when a sender confirms", async () => {
    render();
    await settle();
    await emit(SAS("sender"));
    await press("Yes, Codes Match");
    expect(api.setIncludeSettings).toHaveBeenCalledWith(true);
    expect(api.setPendingUiState).toHaveBeenCalledWith({ marker: true });
    expect(api.confirmSas).toHaveBeenCalledWith("s1", true);
  });

  it("excludes settings and layout when a sender unchecks the option", async () => {
    render();
    const toggle = document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!;
    click(toggle);
    await settle();
    await emit(SAS("sender"));
    await press("Yes, Codes Match");
    expect(api.setIncludeSettings).toHaveBeenCalledWith(false);
    expect(api.clearPendingUiState).toHaveBeenCalled();
    expect(api.confirmSas).toHaveBeenCalledWith("s1", true);
  });

  it("still confirms when the settings could not be prepared", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    api.setIncludeSettings.mockRejectedValue(new Error("nope"));
    render();
    await settle();
    await emit(SAS("receiver"));
    await press("Yes, Codes Match");
    expect(api.confirmSas).toHaveBeenCalledWith("s1", true);
  });

  it("declines when the codes do not match", async () => {
    render();
    await settle();
    await emit(SAS("receiver"));
    await press("Cancel");
    expect(api.confirmSas).toHaveBeenCalledWith("s1", false);
    expect(api.setIncludeSettings).not.toHaveBeenCalled();
  });

  it("shows an error and re-enables the buttons if confirming fails", async () => {
    api.confirmSas.mockRejectedValue(new Error("link dropped"));
    render();
    await settle();
    await emit(SAS("receiver"));
    await press("Yes, Codes Match");
    expect(text()).toContain("link dropped");
    expect(button("Yes, Codes Match").disabled).toBe(false);
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

  it("closes from Done without telling the app twice", async () => {
    render();
    await settle();
    await emit(COMPLETED);
    await press("Done");
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(cancelPairing).toHaveBeenCalled();
  });

  it("shows a failure with Try Again, which returns to the connection choices", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Scan QR Code");
    await emit({ status: "failed", data: { error: "peer vanished" } });
    expect(text()).toContain("Pairing Failed");
    expect(text()).toContain("peer vanished");
    expect(document.querySelector(".pairing-step-dots")).toBeNull();
    await press("Try Again");
    expect(cancelPairing).toHaveBeenCalled();
    expect(title()).toBe("How to Connect Devices");
  });

  it("restarts the host session from Try Again when showing a code", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Show Link Code");
    await emit({ status: "failed", data: { error: "timed out" } });
    await press("Try Again");
    expect(api.startHost).toHaveBeenCalledTimes(2);
  });

  it("closes with Close after a failure", async () => {
    render();
    await settle();
    await emit({ status: "failed", data: { error: "x" } });
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
    expect(title()).toBe("How to Connect Devices");
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
    await press("Show QR Code");
  }

  it("prepares the export and shows the first frame with settings by default", async () => {
    await openSender();
    expect(api.prepareAirgapExport).toHaveBeenCalledWith(true, { marker: true });
    expect(title()).toBe("Show QR Code");
    expect(text()).toContain("A photo or screen recording of these frames can decrypt the accounts in this transfer.");
    expect(text()).toContain("Frame 1/3");
    expect(document.querySelector(".airgap-qr-card svg")).not.toBeNull();
  });

  it("excludes settings and layout when unchecking the option in step 1", async () => {
    render();
    click(document.querySelector<HTMLInputElement>(".pairing-settings-toggle input")!);
    await press("Send Accounts from This Device");
    await press("Show QR Code");
    expect(api.prepareAirgapExport).toHaveBeenCalledWith(false, undefined);
  });

  it("pauses, resumes, and changes speed", async () => {
    await openSender();
    await press("Pause");
    expect(button("Play")).toBeDefined();
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

  it("shows the verification code to compare, and goes back", async () => {
    await openSender();
    await press("After all frames are scanned, click here to continue.");
    expect(title()).toBe("Confirm the connection");
    expect(document.querySelector('[aria-label="Verification code 482 193"]')).not.toBeNull();
    await press("Back");
    expect(title()).toBe("Show QR Code");
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

  it("goes back to the connection choices when the export failed without carrying the error", async () => {
    api.prepareAirgapExport.mockRejectedValueOnce(new Error("The transfer was cancelled."));
    await openSender();
    expect(text()).toContain("The transfer was cancelled.");
    expect(document.querySelector(".airgap-sender-view")).not.toBeNull();
    await press("Back");
    expect(title()).toBe("How to Connect Devices");
    expect(document.querySelector(".airgap-sender-view")).toBeNull();
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("The transfer was cancelled.");

    // Navigating forward to "Enter Link Code" also has no leftover error banner
    await press("Enter Link Code");
    expect(title()).toBe("Enter Link Code");
    expect(document.querySelector(".modal-error")).toBeNull();
    expect(text()).not.toContain("The transfer was cancelled.");
  });

  it("returns to the connection choices from Back", async () => {
    await openSender();
    await press("Back");
    expect(title()).toBe("How to Connect Devices");
    expect(document.querySelector(".airgap-sender-view")).toBeNull();
  });
});

describe("scanning", () => {
  async function openScanner() {
    render();
    await press("Receive Accounts on This Device");
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
    await act(async () => scanner.options!.setCameraError("No camera found"));
    expect(text()).toContain("No camera found");
    expect(document.querySelector(".pairing-scan-beam")).toBeNull();
    const restartKey = scanner.options!.restartKey;
    await press("Retry Camera");
    expect(scanner.options!.restartKey).toBe(restartKey + 1);
    expect(text()).not.toContain("No camera found");
    expect(document.querySelector(".pairing-scan-beam")).not.toBeNull();
  });

  it("places the camera error message below the Back button and controls", async () => {
    await openScanner();
    await act(async () => scanner.options!.setCameraError("Camera permission was denied."));
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
    expect(live?.textContent).toContain("How to Connect Devices");
  });

  it("marks failures as alerts and moves focus to Try Again", async () => {
    api.startClient.mockRejectedValue(new Error("expired link"));
    render({ initialJoinUri: "aiusage-pair:xyz" });
    await settle();
    expect(document.querySelector(".pairing-error-card")?.getAttribute("role")).toBe("alert");
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
    expect(title()).toBe("How to Connect Devices");
    expect(scanner.options?.active).toBe(false);
  });

  it("scans for the air-gap sender's animated code", async () => {
    render();
    await press("Send Accounts from This Device");
    await press("Scan QR Code");
    expect(title()).toBe("Scan QR Code");
    expect(text()).toContain("Point the camera at the QR code on the other device.");
  });
});

describe("air-gap transfer: receiving", () => {
  async function captureAll() {
    render();
    await press("Receive Accounts on This Device");
    await press("Scan QR Code");
    await act(async () => {
      scanner.options!.airgapVerifyPromptRef.current = true;
      scanner.options!.setAirgapTotalChunks(2);
      scanner.options!.setAirgapCapturedChunks(new Map([[0, "a"], [1, "b"]]));
      scanner.options!.setAirgapCaptureSecs(7);
      scanner.options!.setAirgapPinPrompt(true);
    });
    await settle();
  }

  it("verifies the captured frames and shows the code to compare", async () => {
    api.verifyAirgapFrames.mockResolvedValue({ verifyCode: "311 207" });
    await captureAll();
    expect(api.verifyAirgapFrames).toHaveBeenCalledWith(["a", "b"]);
    expect(title()).toBe("Confirm the connection");
    expect(text()).toContain("Captured all 2 frames in 7 seconds");
    expect(document.querySelector('[aria-label="Verification code 311 207"]')).not.toBeNull();
  });

  it("imports the frames once the codes are confirmed", async () => {
    api.verifyAirgapFrames.mockResolvedValue({ verifyCode: "311 207" });
    api.importAirgapFrames.mockResolvedValue({ added: 1, updated: 0, skipped: 0 });
    await captureAll();
    await press("Yes, They Match");
    expect(api.importAirgapFrames).toHaveBeenCalledWith(["a", "b"]);
    expect(title()).toBe("Devices linked");
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("shows an import error and stays on the comparison", async () => {
    api.verifyAirgapFrames.mockResolvedValue({ verifyCode: "311 207" });
    api.importAirgapFrames.mockRejectedValue(new Error("wrong key"));
    await captureAll();
    await press("Yes, They Match");
    expect(text()).toContain("wrong key");
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("restarts the scan when the frames fail verification", async () => {
    api.verifyAirgapFrames.mockRejectedValue(new Error("frames damaged"));
    render();
    await press("Receive Accounts on This Device");
    await press("Scan QR Code");
    const before = scanner.options!.restartKey;
    await act(async () => {
      scanner.options!.airgapVerifyPromptRef.current = true;
      scanner.options!.setAirgapTotalChunks(1);
      scanner.options!.setAirgapCapturedChunks(new Map([[0, "a"]]));
      scanner.options!.setAirgapPinPrompt(true);
    });
    await settle();
    expect(text()).toContain("frames damaged");
    expect(scanner.options!.restartKey).toBe(before + 1);
    expect(document.querySelector(".airgap-pin-prompt-card")).toBeNull();
  });

  it("returns to scanning from Back on the comparison", async () => {
    api.verifyAirgapFrames.mockResolvedValue({ verifyCode: "311 207" });
    await captureAll();
    const before = scanner.options!.restartKey;
    await press("Back");
    expect(document.querySelector(".airgap-pin-prompt-card")).toBeNull();
    expect(document.querySelector(".pairing-scanner-view")).not.toBeNull();
    expect(scanner.options!.restartKey).toBe(before + 1);
  });
});
