// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ tappedFilePending: vi.fn() }));
vi.mock("../../../shared/lib/api", () => ({ pairingApi: api }));
vi.mock("../../../shared/hooks/useTauriEvent", () => ({ useTauriEvent: () => {} }));
vi.mock("../../layout/ui-state", () => ({ applyUiState: () => {} }));

import { mount, settle, type Mounted } from "../../../test-utils/react";
import { usePairingEvents } from "./usePairingEvents";

let mounted: Mounted | null = null;
const latest: { current: ReturnType<typeof usePairingEvents> | null } = { current: null };

function Probe() {
  const events = usePairingEvents();
  useEffect(() => {
    latest.current = events;
  });
  return null;
}

const comeBack = async () => {
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle();
};

beforeEach(() => {
  api.tappedFilePending.mockReset();
  api.tappedFilePending.mockResolvedValue(false);
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 14)", configurable: true });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("a transfer file tapped in Quick Share", () => {
  it("opens Sync Devices when the app comes back with one waiting", async () => {
    mounted = mount(<Probe />);
    await settle();
    expect(latest.current?.pairingOpen).toBe(false);
    api.tappedFilePending.mockResolvedValue(true);
    await comeBack();
    expect(latest.current?.pairingOpen).toBe(true);
  });

  it("opens Sync Devices when the app starts from a tapped file", async () => {
    api.tappedFilePending.mockResolvedValue(true);
    mounted = mount(<Probe />);
    await settle();
    expect(latest.current?.pairingOpen).toBe(true);
  });

  it("leaves Sync Devices closed when nothing was tapped, and off Android", async () => {
    mounted = mount(<Probe />);
    await comeBack();
    expect(latest.current?.pairingOpen).toBe(false);
    mounted.unmount();
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh)", configurable: true });
    api.tappedFilePending.mockClear();
    mounted = mount(<Probe />);
    await comeBack();
    expect(api.tappedFilePending).not.toHaveBeenCalled();
  });
});
