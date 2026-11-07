// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type Mounted } from "../../test-utils/react";
import { ProviderIcon } from "./ProviderIcon";

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("ProviderIcon", () => {
  it("uses the official Antigravity mark and keeps the Google G for AI Studio", () => {
    mounted = mount(
      <>
        <ProviderIcon provider="antigravity" />
        <ProviderIcon provider="google_ai_studio" />
      </>,
    );
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.alt).toBe("Antigravity");
    expect(img!.getAttribute("src")).toBeTruthy();
    expect(img!.getAttribute("draggable")).toBe("false");
    const svgs = document.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0]!.getAttribute("aria-label")).toBe("Google");
  });
});
