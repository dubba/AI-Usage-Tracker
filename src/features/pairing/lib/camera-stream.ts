export async function getCameraStream(
  getUserMediaFn: (c: MediaStreamConstraints) => Promise<MediaStream>,
  deviceId: string | null,
  isMobile: boolean
): Promise<MediaStream> {
  if (deviceId) {
    // Attempt 1: exact deviceId with ideal 720p resolution
    try {
      return await getUserMediaFn({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch {
      // Attempt 2: exact deviceId without resolution constraints.
      // Auxiliary lenses (telephoto, periscope, ultra-wide) on Android often reject
      // standard resolution constraints; relaxing them allows the HAL to use native lens resolution.
      try {
        return await getUserMediaFn({
          video: {
            deviceId: { exact: deviceId },
          },
        });
      } catch {
        // Attempt 3: ideal deviceId constraint
        try {
          return await getUserMediaFn({
            video: {
              deviceId: { ideal: deviceId },
            },
          });
        } catch {
          // Fall through to general constraints below
        }
      }
    }
  }

  // Desktop / USB webcams: never ask for facingMode "user". WebKit treats that as a
  // laptop FaceTime camera and fails on Mac mini / external webcams even when `ideal`.
  if (!isMobile) {
    try {
      return await getUserMediaFn({ video: true });
    } catch {
      return await getUserMediaFn({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    }
  }

  try {
    return await getUserMediaFn({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch {
    return await getUserMediaFn({ video: true });
  }
}

export async function applyAutofocusAndZoom(track: MediaStreamTrack | undefined) {
  if (!track) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trackAny = track as any;
    const capabilities = trackAny.getCapabilities?.() || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const advanced: any = {};

    if (capabilities.focusMode && Array.isArray(capabilities.focusMode)) {
      if (capabilities.focusMode.includes("continuous")) {
        advanced.focusMode = "continuous";
      } else if (capabilities.focusMode.includes("auto")) {
        advanced.focusMode = "auto";
      }
    }

    if (capabilities.zoom && typeof capabilities.zoom.min === "number") {
      const idealZoom = Math.max(capabilities.zoom.min, 1);
      if (capabilities.zoom.max >= idealZoom) {
        advanced.zoom = idealZoom;
      }
    }

    if (Object.keys(advanced).length > 0 && typeof trackAny.applyConstraints === "function") {
      await trackAny.applyConstraints({ advanced: [advanced] });
    }
  } catch {
    // Constraints are optional enhancements
  }
}
