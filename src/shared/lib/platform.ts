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

export function isIOS(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1))
  );
}

/** A Mac (not an iPad, which can also report "Macintosh"). */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent) && !isIOS();
}

export function isWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}
