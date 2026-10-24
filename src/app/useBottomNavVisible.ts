import { useVirtualKeyboard } from "../shared/hooks/useVirtualKeyboard";

/**
 * Whether the bottom navigation bar shows: only while the sidebar is an off-canvas overlay
 * (`overlay`), and not while the on-screen keyboard is open, where it would sit on top of the
 * field being typed in and take room from the page.
 */
export function useBottomNavVisible(overlay: boolean): boolean {
  const [keyboardOpen] = useVirtualKeyboard(overlay);
  return overlay && !keyboardOpen;
}
