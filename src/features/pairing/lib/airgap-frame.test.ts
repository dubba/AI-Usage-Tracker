import { describe, expect, it } from "vitest";
import { isAirgapFrameCode, parseAirgapFrame } from "./airgap-frame";

describe("parseAirgapFrame", () => {
  it("reads the session and position, with or without the version segment", () => {
    expect(parseAirgapFrame("aiut-airgap://1/sess-1/2/5/abcdef?d=payload")).toEqual({ sessionId: "sess-1", chunkIndex: 2, totalChunks: 5 });
    expect(parseAirgapFrame("aiut-airgap://sess-1/1/1/0F?d=x")).toEqual({ sessionId: "sess-1", chunkIndex: 1, totalChunks: 1 });
  });

  it("rejects malformed frames and non-positive positions", () => {
    for (const bad of [
      "aiut-airgap://1/sess/0/5/abc?d=x",
      "aiut-airgap://1/sess/2/0/abc?d=x",
      "aiut-airgap://1/sess/2/5/xyz?d=x",
      "aiut-airgap://1/sess/2/5/abc",
      "aiut-airgap:garbage",
      "https://example.com",
      "",
    ]) {
      expect(parseAirgapFrame(bad), bad).toBeNull();
    }
  });
});

describe("isAirgapFrameCode", () => {
  it("only looks at the scheme", () => {
    expect(isAirgapFrameCode("aiut-airgap:garbage")).toBe(true);
    expect(isAirgapFrameCode("aiusage-pair:abc")).toBe(false);
  });
});
