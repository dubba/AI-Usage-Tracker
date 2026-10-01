// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ALLOWED_SVG_ATTRS, ALLOWED_SVG_TAGS, sanitizeQrSvg } from "./sanitizeSvg";

function parse(svg: string): SVGElement {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") throw new Error("not an svg");
  return root as unknown as SVGElement;
}

describe("sanitizeQrSvg", () => {
  it("preserves allowlisted tags and attributes", () => {
    const out = sanitizeQrSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10">' +
        '<g class="modules"><path d="M0 0h1v1H0z" fill="#000" stroke="none" stroke-width="1"/></g>' +
        '<rect x="0" y="0" width="1" height="1" shape-rendering="crispEdges"/></svg>'
    );
    expect(out).not.toBe("");
    const root = parse(out);
    expect(root.getAttribute("viewBox")).toBe("0 0 10 10");
    const g = root.querySelector("g");
    expect(g).not.toBeNull();
    expect(g?.getAttribute("class")).toBe("modules");
    expect(root.querySelector("path")?.getAttribute("d")).toBe("M0 0h1v1H0z");
    expect(root.querySelector("path")?.getAttribute("fill")).toBe("#000");
    expect(root.querySelector("rect")?.getAttribute("shape-rendering")).toBe("crispEdges");
  });

  it("strips event-handler attributes", () => {
    const out = sanitizeQrSvg(
      '<svg viewBox="0 0 10 10" onclick="alert(1)"><path d="M0 0h1v1H0z" onload="alert(2)"/></svg>'
    );
    expect(out).not.toBe("");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onload");
    expect(out).not.toContain("alert");
    const root = parse(out);
    expect(root.querySelector("path")?.getAttribute("d")).toBe("M0 0h1v1H0z");
  });

  it("drops script elements and non-allowlisted tags", () => {
    const out = sanitizeQrSvg(
      '<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div>hi</div></foreignObject><path d="M0 0h1v1H0z"/></svg>'
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("foreignObject");
    expect(out).not.toContain("alert");
    const root = parse(out);
    expect(root.querySelector("path")).not.toBeNull();
  });

  it("removes href attributes and javascript:/data: attribute values", () => {
    const out = sanitizeQrSvg(
      '<svg viewBox="0 0 10 10"><a xlink:href="javascript:alert(1)"><path d="M0 0h1v1H0z" id="p"/></a></svg>'
    );
    expect(out).not.toContain("javascript:");
    // `a` is not an allowlisted tag and must be dropped entirely.
    expect(out).not.toContain("<a");
    const svg2 = sanitizeQrSvg('<svg><path d="x" fill="data:text/html;base64,AAAA"/></svg>');
    expect(svg2).not.toContain("data:");
  });

  it("rejects non-string, empty, and non-SVG input", () => {
    expect(sanitizeQrSvg("")).toBe("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(sanitizeQrSvg(undefined as any)).toBe("");
    expect(sanitizeQrSvg("   ")).toBe("");
    expect(sanitizeQrSvg("<div>not svg</div>")).toBe("");
    expect(sanitizeQrSvg("not even markup")).toBe("");
  });

  it("handles the XML prolog and keeps the allowlists minimal", () => {
    const out = sanitizeQrSvg('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>');
    expect(out).not.toBe("");
    expect(out).toContain("svg");
    expect(ALLOWED_SVG_TAGS.has("script")).toBe(false);
    expect(ALLOWED_SVG_ATTRS.has("onclick")).toBe(false);
  });
});
