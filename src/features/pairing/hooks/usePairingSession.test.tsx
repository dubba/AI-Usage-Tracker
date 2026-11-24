// @vitest-environment happy-dom
import { act, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  startHost: vi.fn(),
  startClientByCode: vi.fn(),
  selectRole: vi.fn(),
  setIncludeSettings: vi.fn(),
  setPendingUiState: vi.fn(),
  clearPendingUiState: vi.fn(),
  confirmTransfer: vi.fn(),
}));
vi.mock("../../../shared/lib/api", () => ({ pairingApi: api }));
vi.mock("../../layout/ui-state", () => ({ collectUiState: () => ({ layout: "saved" }) }));

import { mount, type Mounted } from "../../../test-utils/react";
import { useLatestRequest } from "../../../shared/hooks/useLatestRequest";
import { usePairingSession, type PairingActionContext } from "./usePairingSession";

type Session = ReturnType<typeof usePairingSession>;
let session: Session;
let request: ReturnType<typeof useLatestRequest>;
let roleAutoSelectedRef: { current: boolean };

const spies = {
  setBusy: vi.fn(),
  setStatus: vi.fn(),
  setErrorMessage: vi.fn(),
  showError: vi.fn(),
  setConfirmed: vi.fn(),
};

function capture(value: Session, latestRequest: ReturnType<typeof useLatestRequest>, auto: typeof roleAutoSelectedRef) {
  session = value;
  request = latestRequest;
  roleAutoSelectedRef = auto;
}

function Harness({ busy = false, includeSettings = false }: { busy?: boolean; includeSettings?: boolean }) {
  const latestRequest = useLatestRequest();
  const auto = useRef(true);
  const context: PairingActionContext = {
    request: latestRequest,
    busy,
    setBusy: spies.setBusy,
    setStatus: spies.setStatus,
    setErrorMessage: spies.setErrorMessage,
    showError: spies.showError,
  };
  capture(
    usePairingSession({
      context,
      roleAutoSelectedRef: auto,
      includeSettings,
      setConfirmed: spies.setConfirmed,
    }),
    latestRequest,
    auto,
  );
  return null;
}

let mounted: Mounted | null = null;
const render = (props: { busy?: boolean; includeSettings?: boolean } = {}) => {
  mounted = mount(<Harness {...props} />);
};

/** A promise the test settles by hand, to hold a backend call open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const hostInit = { sessionId: "s1", joinCode: "123456", expiresAt: 1_790_000_000 };

beforeEach(() => {
  for (const spy of [...Object.values(api), ...Object.values(spies)]) spy.mockReset();
  for (const call of Object.values(api)) call.mockResolvedValue(undefined);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("usePairingSession: showing a link code", () => {
  it("puts the host session on screen and clears busy", async () => {
    api.startHost.mockResolvedValue(hostInit);
    render();
    await act(() => session.initHostSession());
    expect(spies.setErrorMessage).toHaveBeenCalledWith(null);
    expect(spies.setStatus).toHaveBeenCalledWith({ status: "hostWaiting", data: hostInit });
    expect(spies.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("tells the backend whether this device accepts the other one's settings", async () => {
    api.startHost.mockResolvedValue(hostInit);
    render({ includeSettings: true });
    await act(() => session.initHostSession());
    expect(api.startHost).toHaveBeenLastCalledWith(true, false);
    mounted?.rerender(<Harness includeSettings={false} />);
    await act(() => session.initHostSession());
    expect(api.startHost).toHaveBeenLastCalledWith(false, false);
  });

  it("asks for six digits for a device with an older version", async () => {
    api.startHost.mockResolvedValue(hostInit);
    render({ includeSettings: true });
    await act(() => session.initHostSession(true));
    expect(api.startHost).toHaveBeenLastCalledWith(true, true);
  });

  it("shows why the session could not start", async () => {
    const cause = new Error("no wifi");
    api.startHost.mockRejectedValue(cause);
    render();
    await act(() => session.initHostSession());
    expect(spies.showError).toHaveBeenCalledWith("Couldn't start the pairing session", cause);
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("drops an answer that arrives after the user moved on", async () => {
    const pending = deferred<typeof hostInit>();
    api.startHost.mockReturnValue(pending.promise);
    render();
    let running!: Promise<void>;
    act(() => {
      running = session.initHostSession();
    });
    request.cancel();
    pending.resolve(hostInit);
    await act(() => running);
    expect(spies.setStatus).not.toHaveBeenCalled();
    // Busy belongs to whatever replaced this request, so it is left alone.
    expect(spies.setBusy.mock.calls).toEqual([[true]]);
  });

  it("stays quiet about a failure the user no longer waits for", async () => {
    const pending = deferred<typeof hostInit>();
    api.startHost.mockReturnValue(pending.promise);
    render();
    let running!: Promise<void>;
    act(() => {
      running = session.initHostSession();
    });
    request.cancel();
    pending.reject(new Error("late"));
    await act(() => running);
    expect(spies.showError).not.toHaveBeenCalled();
  });
});

describe("usePairingSession: joining with a typed code", () => {
  it("sends a link code's letters only, capitalized", async () => {
    render();
    await act(() => session.handleConnectByCode("ktqmp-rxdhw"));
    expect(api.startClientByCode).toHaveBeenCalledWith("KTQMPRXDHW", false);
    expect(spies.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("sends only the digits of an older version's code", async () => {
    render();
    await act(() => session.handleConnectByCode("12 34-56"));
    expect(api.startClientByCode).toHaveBeenCalledWith("123456", false);
  });

  it("tells the backend whether this device accepts the other one's settings", async () => {
    render({ includeSettings: true });
    await act(() => session.handleConnectByCode("123456"));
    expect(api.startClientByCode).toHaveBeenCalledWith("123456", true);
  });

  it("ignores a code that is too short, and any code while busy", async () => {
    render();
    await act(() => session.handleConnectByCode("12345"));
    await act(() => session.handleConnectByCode("KTQMPRXDH"));
    mounted?.rerender(<Harness busy />);
    await act(() => session.handleConnectByCode("123456"));
    expect(api.startClientByCode).not.toHaveBeenCalled();
    expect(spies.setBusy).not.toHaveBeenCalled();
  });

  it("shows why the code was refused", async () => {
    const cause = new Error("wrong code");
    api.startClientByCode.mockRejectedValue(cause);
    render();
    await act(() => session.handleConnectByCode("123456"));
    expect(spies.showError).toHaveBeenCalledWith("Couldn't connect with that code", cause);
    expect(spies.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("leaves a failure to find the device to onUnreachable when it takes over", async () => {
    api.startClientByCode.mockRejectedValue(new Error("not found"));
    render();
    const takeOver = vi.fn(() => true);
    await act(() => session.handleConnectByCode("KTQMPRXDHW", takeOver));
    expect(takeOver).toHaveBeenCalledTimes(1);
    expect(spies.showError).not.toHaveBeenCalled();
    const decline = vi.fn(() => false);
    await act(() => session.handleConnectByCode("KTQMPRXDHW", decline));
    expect(spies.showError).toHaveBeenCalledTimes(1);
  });
});

describe("usePairingSession: choosing send or receive", () => {
  it("applies the role and stays busy until the backend answers with a status", async () => {
    render();
    await act(() => session.handleSelectRole("send"));
    expect(api.selectRole).toHaveBeenCalledWith("send");
    expect(spies.setBusy.mock.calls).toEqual([[true]]);
    expect(roleAutoSelectedRef.current).toBe(true);
  });

  it("on failure shows the error and lets the role be chosen again", async () => {
    const cause = new Error("peer left");
    api.selectRole.mockRejectedValue(cause);
    render();
    await act(() => session.handleSelectRole("receive"));
    expect(spies.showError).toHaveBeenCalledWith("Couldn't apply the send or receive role", cause);
    expect(roleAutoSelectedRef.current).toBe(false);
    expect(spies.setBusy).toHaveBeenLastCalledWith(false);
  });
});

describe("usePairingSession: confirming the transfer", () => {
  it("with settings on, sends the layout before confirming", async () => {
    render({ includeSettings: true });
    await act(() => session.handleConfirmTransfer("s1", true));
    expect(spies.setConfirmed).toHaveBeenCalledWith(true);
    expect(api.setIncludeSettings).toHaveBeenCalledWith(true);
    expect(api.setPendingUiState).toHaveBeenCalledWith({ layout: "saved" });
    expect(api.clearPendingUiState).not.toHaveBeenCalled();
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
    expect(api.setPendingUiState.mock.invocationCallOrder[0]).toBeLessThan(api.confirmTransfer.mock.invocationCallOrder[0]);
    expect(spies.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("with settings off, clears any layout waiting to be sent", async () => {
    render({ includeSettings: false });
    await act(() => session.handleConfirmTransfer("s1", true));
    expect(api.setIncludeSettings).toHaveBeenCalledWith(false);
    expect(api.clearPendingUiState).toHaveBeenCalledTimes(1);
    expect(api.setPendingUiState).not.toHaveBeenCalled();
  });

  it("still confirms when the settings step fails", async () => {
    api.setIncludeSettings.mockRejectedValue(new Error("settings store busy"));
    render({ includeSettings: true });
    await act(() => session.handleConfirmTransfer("s1", true));
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", true);
    expect(spies.showError).not.toHaveBeenCalled();
  });

  it("declining skips the settings step", async () => {
    render({ includeSettings: true });
    await act(() => session.handleConfirmTransfer("s1", false));
    expect(spies.setConfirmed).not.toHaveBeenCalled();
    expect(api.setIncludeSettings).not.toHaveBeenCalled();
    expect(api.confirmTransfer).toHaveBeenCalledWith("s1", false);
  });

  it("takes the confirmation back when the backend refuses it", async () => {
    const cause = new Error("session expired");
    api.confirmTransfer.mockRejectedValue(cause);
    render();
    await act(() => session.handleConfirmTransfer("s1", true));
    expect(spies.showError).toHaveBeenCalledWith("Couldn't start the transfer", cause);
    expect(spies.setConfirmed.mock.calls).toEqual([[true], [false]]);
    expect(spies.setBusy).toHaveBeenLastCalledWith(false);
  });
});
