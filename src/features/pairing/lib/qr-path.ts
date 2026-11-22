import type { QrMatrix } from "../../../types";

/** The light border a QR code needs around it to be read, in modules (the standard four). */
export const QR_QUIET_ZONE = 4;

/**
 * The SVG path of a QR code's dark modules, in module units with the quiet zone included: one
 * rectangle per run of dark modules in a row. Empty when `qr` is not a complete square grid.
 */
export function qrPath(qr: QrMatrix): string {
  const { size, modules } = qr;
  if (!Number.isInteger(size) || size <= 0 || modules.length !== size * size || /[^01]/.test(modules)) return "";
  let path = "";
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (modules[y * size + x] !== "1") {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && modules[y * size + x] === "1") x += 1;
      path += `M${start + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${x - start}v1h-${x - start}z`;
    }
  }
  return path;
}
