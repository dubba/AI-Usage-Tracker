import { KNOWN_PROVIDERS, uniqueStrings } from "../dashboard/sidebar-order";
import type { Provider } from "../../types";
import type { ActiveDrag, DragDescriptor } from "./types";

export function isInteractivePointerTarget(target: Element): boolean {
  return Boolean(
    target.closest(
      "button, a, input, textarea, select, label, .account-card-action, .account-card-provider-icon, .account-name-edit, .account-name-confirm, .account-name-cancel",
    ),
  );
}

export function groupIdFromRow(row: HTMLElement): string | null {
  const groupId = row.dataset.groupId?.trim();
  return groupId ? groupId : null;
}

export function providerOf(element: HTMLElement): Provider | null {
  const provider = element.dataset.reorderProvider as Provider | undefined;
  return provider && KNOWN_PROVIDERS.includes(provider) ? provider : null;
}

export function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function groupRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-summary-row"))
    .filter((row) => row.dataset.groupId !== "all" && !row.classList.contains("is-all-row"));
}

export function accountCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .provider-account-card"));
}

export function visibleAccountIds(container: HTMLElement): string[] {
  return uniqueStrings(
    accountCards(container)
      .map((card) => card.dataset.accountId?.trim() ?? "")
      .filter((accountId) => accountId.length > 0),
  );
}

export function dragFromPointerTarget(target: Element): DragDescriptor | null {
  const groupRow = target.closest<HTMLElement>(".provider-summary-row[data-reorder-enabled='true']");
  if (groupRow) {
    const groupId = groupIdFromRow(groupRow);
    const provider = providerOf(groupRow) ?? "openai";
    return groupId ? { kind: "group", groupId, provider, source: groupRow } : null;
  }

  if (target.closest("input, textarea, select, [contenteditable='true'], .remove-account-confirmation")) return null;
  const card = target.closest<HTMLElement>(".provider-account-card[data-reorder-enabled='true']");
  if (!card) return null;
  const accountId = card.dataset.accountId;
  const provider = providerOf(card);
  return accountId && provider ? { kind: "account", accountId, provider, source: card } : null;
}

export function originalOrder(descriptor: DragDescriptor, container: HTMLElement): string[] {
  if (descriptor.kind === "group") {
    return groupRows(container)
      .map(groupIdFromRow)
      .filter((id): id is string => Boolean(id));
  }
  return visibleAccountIds(container);
}

export function committedOrder(drag: ActiveDrag): string[] {
  if (drag.descriptor.kind === "group") {
    const ids = groupRows(drag.container)
      .map(groupIdFromRow)
      .filter((id): id is string => Boolean(id));
    return uniqueStrings(ids);
  }
  return visibleAccountIds(drag.container);
}

export function accountScrollContainer(source: HTMLElement): HTMLElement {
  return source.closest<HTMLElement>(".dashboard-scroll")
    ?? source.closest<HTMLElement>(".dashboard-content")
    ?? source.parentElement
    ?? document.documentElement;
}
