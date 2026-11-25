import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useModalA11y } from "../../shared/hooks/useModalA11y";
import { useModalClosePolicy } from "../../shared/hooks/useModalClosePolicy";
import { useAccentColor, useThemePreference } from "../../shared/hooks/usePreferences";
import {
  DEFAULT_ACCENT_COLOR,
  MODAL_ACCENT_PRESETS,
  contrastingTextOnFill,
  hexToHsv,
  hsvToHex,
  normalizeAccentColor,
  type Hsv,
} from "../../shared/lib/accent-color";
import { resolveTheme } from "../../shared/lib/theme";
import { ChevronIcon, PlusIcon } from "../../shared/ui/icons";
import { ModalDialog } from "../../shared/ui/ModalDialog";

/** Full-spectrum conic gradient for the custom color wheel button (data-driven gradient, not a theme token). */
export const RAINBOW_WHEEL_GRADIENT =
  "conic-gradient(from 0deg, #ff3b30, #ff9500, #ffcc00, #34c759, #00c7be, #007aff, #5856d6, #af52de, #ff2d55, #ff3b30)";

const HUE_SLIDER_GRADIENT =
  "linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)";

const SV_OVERLAY_GRADIENT =
  "linear-gradient(to top, #000000, rgba(0, 0, 0, 0)), linear-gradient(to right, #ffffff, rgba(255, 255, 255, 0))";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** How close to the circle's center a press counts as a tap on it, in CSS pixels. */
const THUMB_HIT_RADIUS_PX = 16;
/** How far a press on the circle may move and still count as a tap rather than a drag. */
const TAP_SLOP_PX = 6;

function systemPrefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches === true;
}

/**
 * Custom in-app "Pick accent color" dialog:
 * - Always shows the 4 × 3 circular swatch grid (11 curated presets + custom `+` circle).
 * - Tapping an already-selected preset, or the circle on the custom color square, toggles between
 *   Light and Dark mode. Dragging the circle picks a color.
 * - Tapping the `+` circle swaps the grid for the "Custom Color" view in the same dialog
 *   (2D saturation/brightness square, hue slider, preview swatch, hex input, Reset) — no OS
 *   picker. "Presets" (left of "Done") goes back to the grid.
 * - "Done", bottom right in both views, closes the dialog (colors apply as they are tapped).
 */
export function AccentColorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <AccentColorModalContent onClose={onClose} />;
}

function AccentColorModalContent({ onClose }: { onClose: () => void }) {
  const [accentColor, setAccentColor] = useAccentColor();
  const [themePreference, setThemePreference] = useThemePreference();
  const isInitialCustom = !MODAL_ACCENT_PRESETS.some((preset) => preset.hex === accentColor);
  const [customOpen, setCustomOpen] = useState(isInitialCustom);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(accentColor));
  const [hexDraft, setHexDraft] = useState(accentColor.toUpperCase());

  const dialogRef = useRef<HTMLElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const requestClose = useModalClosePolicy(true, onClose);
  useModalA11y(dialogRef, true, requestClose);

  const isCustomActive = !MODAL_ACCENT_PRESETS.some((preset) => preset.hex === accentColor);
  const hexInputRef = useRef<HTMLInputElement>(null);
  const customTileRef = useRef<HTMLButtonElement>(null);
  const viewSwitched = useRef(false);

  // Switching views removes the focused button: move focus into the new view.
  useEffect(() => {
    if (!viewSwitched.current) return;
    (customOpen ? hexInputRef : customTileRef).current?.focus();
  }, [customOpen]);

  const showView = (custom: boolean) => {
    viewSwitched.current = true;
    setCustomOpen(custom);
  };

  const toggleLightDark = () => {
    const resolved = resolveTheme(themePreference, systemPrefersLight());
    setThemePreference(resolved === "light" ? "dark" : "light");
  };

  const handlePresetClick = (hex: string) => {
    if (accentColor === hex) {
      toggleLightDark();
      return;
    }
    setAccentColor(hex);
    setHsv(hexToHsv(hex));
    setHexDraft(hex.toUpperCase());
  };

  const openCustom = () => {
    setHsv(hexToHsv(accentColor));
    setHexDraft(accentColor.toUpperCase());
    showView(true);
  };

  const applyHsv = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexDraft(hex.toUpperCase());
    setAccentColor(hex);
  };

  const updateSvFromPointer = (clientX: number, clientY: number) => {
    const rect = svRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const s = clamp01((clientX - rect.left) / rect.width);
    const v = clamp01(1 - (clientY - rect.top) / rect.height);
    applyHsv({ h: hsv.h, s, v });
  };

  const updateHueFromPointer = (clientX: number) => {
    const rect = hueRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = clamp01((clientX - rect.left) / rect.width);
    applyHsv({ h: ratio * 359.9, s: hsv.s, v: hsv.v });
  };

  /** Where a press on the circle began, while it may still be a tap (it toggles Light/Dark). */
  const thumbPress = useRef<{ x: number; y: number } | null>(null);

  const onSvPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = svRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      const thumbX = rect.left + hsv.s * rect.width;
      const thumbY = rect.top + (1 - hsv.v) * rect.height;
      if (Math.hypot(event.clientX - thumbX, event.clientY - thumbY) <= THUMB_HIT_RADIUS_PX) {
        // On the circle: wait to see whether this is a tap or the start of a drag.
        thumbPress.current = { x: event.clientX, y: event.clientY };
        return;
      }
    }
    thumbPress.current = null;
    updateSvFromPointer(event.clientX, event.clientY);
  };

  const onSvPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0 && event.pointerType === "mouse") return;
    const press = thumbPress.current;
    if (press) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < TAP_SLOP_PX) return;
      thumbPress.current = null;
    }
    updateSvFromPointer(event.clientX, event.clientY);
  };

  const onSvPointerUp = () => {
    if (!thumbPress.current) return;
    thumbPress.current = null;
    toggleLightDark();
  };

  const onSvPointerCancel = () => {
    thumbPress.current = null;
  };

  const onHuePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateHueFromPointer(event.clientX);
  };

  const onHuePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0 && event.pointerType === "mouse") return;
    updateHueFromPointer(event.clientX);
  };

  const onHueKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 15 : 5;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      applyHsv({ ...hsv, h: (hsv.h + step) % 360 });
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      applyHsv({ ...hsv, h: (hsv.h - step + 360) % 360 });
    }
  };

  const onHexChange = (raw: string) => {
    const cleaned = (raw.startsWith("#") ? raw : `#${raw}`).toUpperCase();
    setHexDraft(cleaned);
    const normalized = normalizeAccentColor(cleaned);
    if (normalized) {
      setHsv(hexToHsv(normalized));
      setAccentColor(normalized);
    }
  };

  const hueBaseHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return createPortal(
    <ModalDialog
      dialogRef={dialogRef}
      labelledBy={titleId}
      describedBy={customOpen ? undefined : subtitleId}
      className="accent-color-modal"
      backdropClassName="accent-color-modal-backdrop"
      // Focus starts on the hex input in Custom Color, and on the × in Presets.
      focusCloseFirst={!customOpen}
      onClose={requestClose}
    >
      <h2 id={titleId} className="accent-color-modal-title">
        Pick accent color
      </h2>
      {customOpen ? null : (
        <p id={subtitleId} className="accent-color-modal-subtitle">
          Tap the color twice to toggle between Light and Dark mode
        </p>
      )}

      {customOpen ? (
        <div className="accent-custom-view">
          <h3 className="accent-custom-title">Custom Color</h3>

          <div
            ref={svRef}
            className="accent-sv-plane"
            style={{ backgroundColor: hueBaseHex, backgroundImage: SV_OVERLAY_GRADIENT }}
            onPointerDown={onSvPointerDown}
            onPointerMove={onSvPointerMove}
            onPointerUp={onSvPointerUp}
            onPointerCancel={onSvPointerCancel}
          >
            <span
              className="accent-sv-thumb"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                backgroundColor: accentColor,
              }}
            />
          </div>

          <div
            ref={hueRef}
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            className="accent-hue-slider"
            style={{ background: HUE_SLIDER_GRADIENT }}
            onPointerDown={onHuePointerDown}
            onPointerMove={onHuePointerMove}
            onKeyDown={onHueKeyDown}
          >
            <span className="accent-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
          </div>

          <div className="accent-hex-row">
            <span className="accent-hex-preview" style={{ backgroundColor: accentColor }} aria-hidden="true" />
            <label className="sr-only" htmlFor="accent-custom-hex-input">
              Hex color
            </label>
            <input
              ref={hexInputRef}
              id="accent-custom-hex-input"
              type="text"
              className="text-input accent-hex-input"
              value={hexDraft}
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              aria-label="Hex color"
              data-autofocus
              onChange={(event) => onHexChange(event.target.value)}
            />
            <button
              type="button"
              className="button ghost accent-reset-btn"
              disabled={accentColor === DEFAULT_ACCENT_COLOR}
              onClick={() => {
                setAccentColor(DEFAULT_ACCENT_COLOR);
                setHsv(hexToHsv(DEFAULT_ACCENT_COLOR));
                setHexDraft(DEFAULT_ACCENT_COLOR.toUpperCase());
              }}
            >
              Reset
            </button>
          </div>
        </div>
      ) : (
        <div className="accent-color-grid" role="radiogroup" aria-labelledby={titleId}>
          {MODAL_ACCENT_PRESETS.map((preset) => {
            const selected = accentColor === preset.hex;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={preset.label}
                data-tooltip={`${preset.label} · ${preset.hex.toUpperCase()}`}
                className={`accent-color-tile${selected ? " is-selected" : ""}`}
                style={{ backgroundColor: preset.hex }}
                onClick={() => handlePresetClick(preset.hex)}
              />
            );
          })}
          <button
            ref={customTileRef}
            type="button"
            aria-label="Custom color picker"
            data-tooltip={isCustomActive ? `Custom color · ${accentColor.toUpperCase()}` : "Pick a custom color"}
            className={`accent-color-tile accent-color-tile-wheel${isCustomActive ? " is-selected" : ""}`}
            style={
              isCustomActive
                ? { backgroundColor: accentColor, color: contrastingTextOnFill(accentColor) }
                : { background: RAINBOW_WHEEL_GRADIENT }
            }
            onClick={openCustom}
          >
            <PlusIcon className="accent-color-wheel-plus" />
          </button>
        </div>
      )}

      {/* Done in the same place in both views; Presets beside it in the Custom Color view. */}
      <div className="accent-modal-actions">
        {customOpen ? (
          <button
            type="button"
            className="button ghost accent-presets-btn"
            onClick={() => showView(false)}
          >
            <ChevronIcon style={{ transform: "rotate(180deg)" }} />
            <span>Presets</span>
          </button>
        ) : null}
        <button type="button" className="button primary accent-done-btn" onClick={requestClose}>
          Done
        </button>
      </div>
    </ModalDialog>,
    document.body,
  );
}
