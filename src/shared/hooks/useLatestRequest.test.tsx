// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { useLatestRequest } from "./useLatestRequest";

let request: ReturnType<typeof useLatestRequest>;

function capture(value: ReturnType<typeof useLatestRequest>) {
  request = value;
}

function Probe() {
  capture(useLatestRequest());
  return null;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("useLatestRequest", () => {
  it("only the newest ticket is current", () => {
    mounted = mount(<Probe />);
    const first = request.begin();
    expect(request.isLatest(first)).toBe(true);
    const second = request.begin();
    expect(request.isLatest(first)).toBe(false);
    expect(request.isLatest(second)).toBe(true);
  });

  it("cancel makes every ticket stale, and a later request is current again", () => {
    mounted = mount(<Probe />);
    const ticket = request.begin();
    request.cancel();
    expect(request.isLatest(ticket)).toBe(false);
    expect(request.isLatest(request.begin())).toBe(true);
  });

  it("keeps the same object between renders, so it can be a dependency", () => {
    mounted = mount(<Probe />);
    const first = request;
    mounted.rerender(<Probe />);
    expect(request).toBe(first);
  });
});
