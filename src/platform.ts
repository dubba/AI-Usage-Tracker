const MOBILE_UA = /Android|iPhone|iPad|iPod/i;

/** True when the user agent identifies a phone or tablet. */
export function isMobileUserAgent(): boolean {
  return typeof navigator !== "undefined" && MOBILE_UA.test(navigator.userAgent);
}

/** Mobile user agent, or a coarse primary pointer (touch-first devices that spoof a desktop UA). */
export function isMobileDevice(): boolean {
  return (
    isMobileUserAgent() ||
    (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true)
  );
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}
