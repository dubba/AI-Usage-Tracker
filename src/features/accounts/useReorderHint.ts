import { useEffect } from "react";
import { useSessionHint } from "../../shared/hooks/useSessionHint";
import { onReorderDone } from "../../shared/lib/events";
import type { HintPage } from "../../shared/lib/storage";

/**
 * The "you can drag or move cards" hint of the accounts or usage page: a `useSessionHint` that is
 * done for good once the user reorders a card or a sidebar group while on this page.
 */
export function useReorderHint(canReorder: boolean, page: HintPage = "accounts") {
  const hint = useSessionHint("reorder", page, canReorder);
  const { show, complete } = hint;

  // A reorder on another page, Settings included, leaves this page's hint alone, so each page
  // teaches dragging on its own.
  useEffect(() => {
    if (!show) return;
    return onReorderDone((reorderedOn) => {
      if (reorderedOn === page) complete();
    });
  }, [show, complete, page]);

  return hint;
}
