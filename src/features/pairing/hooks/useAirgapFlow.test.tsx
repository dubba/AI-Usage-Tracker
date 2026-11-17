// @vitest-environment happy-dom
import { act, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ prepareAirgapExport: vi.fn(), importAirgapFrames: vi.fn() }));
vi.mock("../../../shared/lib/api", () => ({ pairingApi: api }));
vi.mock("../../layout/ui-state", () => ({ collectUiState: () => ({ layout: "saved" }) }));

import { mount, type Mounted } from "../../../test-utils/react";
import { useLatestRequest } from "../../../shared/hooks/useLatestRequest";
import type { AirgapExport } from "../../../types";
import type { useAirgapCapture } from "./useAirgapCapture";
import { useAirgapFlow } from "./useAirgapFlow";
import type { PairingActionContext } from "./usePairingSession";

type Flow = ReturnType<typeof useAirgapFlow>;
type Capture = ReturnType<typeof useAirgapCapture>;
let flow: Flow;
let request: ReturnType<typeof useLatestRequest>;
let hasCompletedRef: { current: boolean };

const spies = {
  setBusy: vi.fn(),
  setErrorMessage: vi.fn(),
  showError: vi.fn(),
  stopCamera: vi.fn(),
  showView: vi.fn(),
  setAirgapPrepareError: vi.fn(),
  setStatus: vi.fn(),
  onCompleted: vi.fn(),
  setImporting: vi.fn(),
  closePrompt: vi.fn(),
};

/** Only the parts of the capture the flow reads. */
function fakeCapture(overrides: Partial<Capture> = {}): Capture {
  return {
    importing: false,
    accountCount: 2,
    chunks: new Map([
      [1, "frame-1"],
      [2, "frame-2"],
    ]),
    setImporting: spies.setImporting,
    closePrompt: spies.closePrompt,
    ...overrides,
  } as unknown as Capture;
}

function keep(value: Flow, latestRequest: ReturnType<typeof useLatestRequest>, completed: typeof hasCompletedRef) {
  flow = value;
  request = latestRequest;
  hasCompletedRef = completed;
}

type Props = { includeSettings?: boolean; senderViewActive?: boolean; capture?: Capture };

function Harness({ includeSettings = false, senderViewActive = true, capture = fakeCapture() }: Props) {
  const latestRequest = useLatestRequest();
  const completed = useRef(false);
  const context: PairingActionContext = {
    request: latestRequest,
    busy: false,
    setBusy: spies.setBusy,
    setStatus: vi.fn(),
    setErrorMessage: spies.setErrorMessage,
    showError: spies.showError,
  };
  keep(
    useAirgapFlow({
      context,
      senderViewActive,
      includeSettings,
      capture,
      stopCamera: spies.stopCamera,
      showView: spies.showView,
      setAirgapPrepareError: spies.setAirgapPrepareError,
      setStatus: spies.setStatus,
      hasCompletedRef: completed,
      onCompleted: spies.onCompleted,
    }),
    latestRequest,
    completed,
  );
  return null;
}

let mounted: Mounted | null = null;
const render = (props: Props = {}) => {
  mounted = mount(<Harness {...props} />);
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const exported: AirgapExport = {
  sessionId: "s1",
  totalChunks: 3,
  frames: [1, 2, 3].map((chunkIndex) => ({ chunkIndex, totalChunks: 3, uri: `aiut-airgap://1/s1/${chunkIndex}/3/ab?d=x`, svg: "<svg/>" })),
};
const summary = { added: 2, updated: 1, skipped: 0, warnings: [] };

beforeEach(() => {
  for (const spy of [...Object.values(api), ...Object.values(spies)]) spy.mockReset();
  api.prepareAirgapExport.mockResolvedValue(exported);
  api.importAirgapFrames.mockResolvedValue(summary);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe("useAirgapFlow: sending", () => {
  it("stops the camera, shows the sender view and holds the prepared export", async () => {
    render();
    await act(() => flow.startAirgapSender());
    expect(spies.stopCamera).toHaveBeenCalledTimes(1);
    expect(spies.showView).toHaveBeenCalledWith("airgap-sender");
    expect(spies.setErrorMessage).toHaveBeenCalledWith(null);
    expect(spies.setAirgapPrepareError).toHaveBeenCalledWith(null);
    expect(api.prepareAirgapExport).toHaveBeenCalledWith(false, undefined);
    expect(flow.airgapExport).toBe(exported);
    expect(spies.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("sends the layout when settings are included, and lets the argument override the checkbox", async () => {
    render({ includeSettings: true });
    await act(() => flow.startAirgapSender());
    expect(api.prepareAirgapExport).toHaveBeenLastCalledWith(true, { layout: "saved" });
    await act(() => flow.startAirgapSender(false));
    expect(api.prepareAirgapExport).toHaveBeenLastCalledWith(false, undefined);
    mounted?.rerender(<Harness includeSettings={false} />);
    await act(() => flow.startAirgapSender(true));
    expect(api.prepareAirgapExport).toHaveBeenLastCalledWith(true, { layout: "saved" });
  });

  it("puts a failure under the sender view, not in the dialog's error line", async () => {
    api.prepareAirgapExport.mockRejectedValue(new Error("nothing to send"));
    render();
    await act(() => flow.startAirgapSender());
    const message = spies.setAirgapPrepareError.mock.calls.at(-1)?.[0];
    expect(message).toContain("Couldn't prepare the transfer");
    expect(spies.showError).not.toHaveBeenCalled();
    expect(flow.airgapExport).toBeNull();
    expect(spies.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("drops an export that arrives after the user moved on", async () => {
    const pending = deferred<AirgapExport>();
    api.prepareAirgapExport.mockReturnValue(pending.promise);
    render();
    let running!: Promise<void>;
    act(() => {
      running = flow.startAirgapSender();
    });
    request.cancel();
    pending.resolve(exported);
    await act(() => running);
    expect(flow.airgapExport).toBeNull();
    expect(spies.setBusy.mock.calls).toEqual([[true]]);
  });

  it("plays the frames while the sender view is showing, and restarts from the first on a new export", async () => {
    vi.useFakeTimers();
    render();
    await act(() => flow.startAirgapSender());
    expect(flow.player.frameIndex).toBe(0);
    act(() => {
      vi.advanceTimersByTime(150 * 2);
    });
    expect(flow.player.frameIndex).toBe(2);
    await act(() => flow.startAirgapSender());
    expect(flow.player.frameIndex).toBe(0);
  });

  it("does not play while the sender view is hidden", async () => {
    vi.useFakeTimers();
    render({ senderViewActive: false });
    await act(() => flow.startAirgapSender());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(flow.player.frameIndex).toBe(0);
  });

  it("clearExport forgets the export", async () => {
    render();
    await act(() => flow.startAirgapSender());
    act(() => flow.clearExport());
    expect(flow.airgapExport).toBeNull();
  });
});

describe("useAirgapFlow: receiving", () => {
  it("imports the captured frames and marks the transfer complete", async () => {
    render();
    await act(() => flow.handleAirgapImport());
    expect(api.importAirgapFrames).toHaveBeenCalledWith(["frame-1", "frame-2"], false);
    expect(hasCompletedRef.current).toBe(true);
    expect(spies.closePrompt).toHaveBeenCalledTimes(1);
    expect(spies.stopCamera).toHaveBeenCalledTimes(1);
    expect(spies.setStatus).toHaveBeenCalledWith({ status: "completed", data: { summary } });
    expect(spies.onCompleted).toHaveBeenCalledTimes(1);
    expect(spies.setImporting.mock.calls).toEqual([[true], [false]]);
  });

  it("does nothing before the frames are opened, or while an import is running", async () => {
    render({ capture: fakeCapture({ accountCount: null }) });
    await act(() => flow.handleAirgapImport());
    mounted?.rerender(<Harness capture={fakeCapture({ importing: true })} />);
    await act(() => flow.handleAirgapImport());
    expect(api.importAirgapFrames).not.toHaveBeenCalled();
    expect(spies.setImporting).not.toHaveBeenCalled();
  });

  it("shows why the import failed and leaves the comparison open", async () => {
    const cause = new Error("codes did not match");
    api.importAirgapFrames.mockRejectedValue(cause);
    render();
    await act(() => flow.handleAirgapImport());
    expect(spies.showError).toHaveBeenCalledWith("Couldn't import the accounts", cause);
    expect(hasCompletedRef.current).toBe(false);
    expect(spies.closePrompt).not.toHaveBeenCalled();
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.onCompleted).not.toHaveBeenCalled();
    expect(spies.setImporting).toHaveBeenLastCalledWith(false);
  });

  it("drops an import that finishes after the dialog moved on", async () => {
    const pending = deferred<typeof summary>();
    api.importAirgapFrames.mockReturnValue(pending.promise);
    render();
    let running!: Promise<void>;
    act(() => {
      running = flow.handleAirgapImport();
    });
    request.cancel();
    pending.resolve(summary);
    await act(() => running);
    expect(hasCompletedRef.current).toBe(false);
    expect(spies.setStatus).not.toHaveBeenCalled();
    expect(spies.onCompleted).not.toHaveBeenCalled();
    expect(spies.setImporting.mock.calls).toEqual([[true]]);
  });
});
