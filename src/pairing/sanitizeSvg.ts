export const ALLOWED_SVG_TAGS = new Set(["svg", "path", "rect", "g", "defs", "clippath"]);
export const ALLOWED_SVG_ATTRS = new Set([
  "viewbox",
  "width",
  "height",
  "fill",
  "stroke",
  "stroke-width",
  "d",
  "shape-rendering",
  "xmlns",
  "version",
  "x",
  "y",
  "id",
  "class",
]);

export function sanitizeQrSvg(rawSvg: string): string {
  if (!rawSvg || typeof rawSvg !== "string") return "";

  const trimmed = rawSvg.replace(/^<\?xml[^>]*\?>/i, "").trim();
  if (!trimmed) return "";

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, "image/svg+xml");

    if (doc.getElementsByTagName("parsererror").length > 0) {
      return "";
    }

    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg") {
      return "";
    }

    const elements = Array.from(doc.getElementsByTagName("*"));
    for (const el of elements) {
      const tag = el.nodeName.toLowerCase();
      if (!ALLOWED_SVG_TAGS.has(tag)) {
        el.remove();
        continue;
      }

      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();
        const attrValue = attr.value.trim().toLowerCase();

        if (
          attrName.startsWith("on") ||
          attrName.includes("href") ||
          attrValue.includes("javascript:") ||
          attrValue.includes("data:") ||
          !ALLOWED_SVG_ATTRS.has(attrName)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }

    return new XMLSerializer().serializeToString(root);
  } catch {
    return "";
  }
}
