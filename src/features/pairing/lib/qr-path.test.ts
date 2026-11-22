import { describe, expect, it } from "vitest";
import { QR_QUIET_ZONE, qrPath } from "./qr-path";

describe("qrPath", () => {
  it("draws each run of dark modules in a row as one rectangle, inside the quiet zone", () => {
    const q = QR_QUIET_ZONE;
    // 1 1 0
    // 0 0 0
    // 1 0 1
    expect(qrPath({ size: 3, modules: "110000101" })).toBe(
      `M${q} ${q}h2v1h-2z` + `M${q} ${q + 2}h1v1h-1z` + `M${q + 2} ${q + 2}h1v1h-1z`,
    );
  });

  it("draws nothing for a light grid", () => {
    expect(qrPath({ size: 2, modules: "0000" })).toBe("");
  });

  it("draws nothing for a grid that is not a complete square of 0s and 1s", () => {
    for (const qr of [
      { size: 3, modules: "1111" },
      { size: 0, modules: "" },
      { size: 2, modules: "1x01" },
      { size: 1.5, modules: "11" },
    ]) {
      expect(qrPath(qr)).toBe("");
    }
  });
});
