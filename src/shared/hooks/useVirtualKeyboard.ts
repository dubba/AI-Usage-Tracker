import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { watchVirtualKeyboard } from "../lib/virtual-keyboard";

/**
 * Whether the on-screen keyboard is showing while `open` is true. The setter lets a
 * field flag the keyboard early, before the viewport has resized; the next
 * re-evaluation overrides it with the detected state.
 */
export function useVirtualKeyboard(open: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setKeyboardOpen(false);
      return;
    }
    return watchVirtualKeyboard(setKeyboardOpen).dispose;
  }, [open]);

  return [keyboardOpen, setKeyboardOpen];
}
