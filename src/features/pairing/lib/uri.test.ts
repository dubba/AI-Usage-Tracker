import { describe, expect, it } from "vitest";
import { isPairingUri } from "./uri";

describe("isPairingUri", () => {
  it("accepts both pairing schemes", () => {
    expect(isPairingUri("aiusage-pair://192.168.1.2:9000?session=a&key=b&nonce=c")).toBe(true);
    expect(isPairingUri("aiusage:abc")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const value of [null, undefined, "", "https://example.com", "aiusagepair:x", " aiusage:x", "AIUSAGE:x", "javascript:alert(1)"]) {
      expect(isPairingUri(value), String(value)).toBe(false);
    }
  });
});
