type CardProvider = "openai" | "anthropic" | "antigravity" | "google_ai_studio" | "grok" | "opencode_go";

function cardProvider(card: HTMLElement): CardProvider | null {
  const icon = card.querySelector<HTMLElement>(".account-card-provider-icon");
  if (icon?.classList.contains("provider-openai")) return "openai";
  if (icon?.classList.contains("provider-anthropic")) return "anthropic";
  if (icon?.classList.contains("provider-antigravity")) return "antigravity";
  if (icon?.classList.contains("provider-google_ai_studio")) return "google_ai_studio";
  if (icon?.classList.contains("provider-grok")) return "grok";
  if (icon?.classList.contains("provider-opencode_go")) return "opencode_go";
  return null;
}

function refineHeader(card: HTMLElement): void {
  const remove = card.querySelector<HTMLButtonElement>(".account-card-name-actions .remove-action, .account-card-header-actions .remove-action");
  remove?.classList.toggle("showing-spinner", Boolean(remove.querySelector(".mini-spinner")));
}

function refineMetric(metric: HTMLElement, provider: CardProvider): void {
  const label = metric.querySelector<HTMLElement>(".metric-label");
  if (!label) return;

  metric.classList.remove("ui-hidden-metric");
  label.classList.remove("ui-hidden-metric-label");

  const labelText = label.textContent?.trim() ?? "";

  if (provider === "openai" && (labelText.toLowerCase() === "session" || labelText.toLowerCase() === "remaining limit")) {
    label.textContent = "GPT · Remaining Limit";
  }

  if (provider === "antigravity") {
    const cleaned = labelText.replace(/\s*·\s*(?:five hour|5 hour|weekly) limit\s*$/i, "").trim();
    if (cleaned && cleaned !== labelText) label.textContent = cleaned;
  }
}

function refineCredits(card: HTMLElement, provider: CardProvider): void {
  const credits = card.querySelector<HTMLElement>(".account-credit-metric");
  if (!credits) return;

  credits.classList.toggle("ui-hidden-credit", provider === "antigravity" || provider === "opencode_go");

  if (provider === "openai") {
    for (const child of Array.from(credits.children)) {
      child.classList.toggle(
        "ui-hidden-credit-helper",
        child.textContent?.trim() === "Provider-reported remaining credit balance",
      );
    }
  }
}

function refineAccountCard(card: HTMLElement): void {
  const provider = cardProvider(card);
  if (!provider) return;
  card.dataset.provider = provider;
  refineHeader(card);
  for (const metric of Array.from(card.querySelectorAll<HTMLElement>(".account-usage-metric"))) {
    refineMetric(metric, provider);
  }
  refineCredits(card, provider);
}

function modalCancelButton(modal: HTMLElement): HTMLButtonElement | null {
  const explicit = modal.querySelector<HTMLButtonElement>("button[data-modal-close], button[data-modal-cancel]");
  if (explicit) return explicit;

  const actionsButton = Array.from(modal.querySelectorAll<HTMLButtonElement>(".modal-actions button"))
    .find((button) => {
      const label = button.textContent?.trim().toLowerCase();
      return label === "cancel" || label === "close" || label === "done";
    });
  if (actionsButton) return actionsButton;

  return Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => {
      if (button.classList.contains("ui-modal-close")) return false;
      const label = button.textContent?.trim().toLowerCase();
      return label === "cancel" || label === "close" || label === "done";
    }) ?? null;
}

function refineModalCloseButton(modal: HTMLElement): void {
  if (modal.querySelector<HTMLButtonElement>(":scope > .ui-modal-close[data-react-close]")) {
    return;
  }

  let close = modal.querySelector<HTMLButtonElement>(":scope > .ui-modal-close");
  if (!close) {
    close = document.createElement("button");
    close.type = "button";
    close.className = "ui-modal-close";
    close.setAttribute("aria-label", "Close dialog");
    close.setAttribute("data-tooltip", "Close");
    close.textContent = "×";
    modal.prepend(close);
  }

  const cancel = modalCancelButton(modal);
  close.disabled = cancel ? cancel.disabled : false;
  close.onclick = () => {
    const target = modalCancelButton(modal);
    if (target && !target.disabled) {
      target.click();
    }
  };
}

function applyRefinements(): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".provider-account-card"));
  for (const card of cards) refineAccountCard(card);

  const modals = Array.from(document.querySelectorAll<HTMLElement>(".modal-card[role=\"dialog\"]"));
  for (const modal of modals) refineModalCloseButton(modal);
}

function closeOpenDialog(): boolean {
  const modals = Array.from(document.querySelectorAll<HTMLElement>('.modal-card[role="dialog"]'));
  const modal = modals.at(-1);
  if (!modal) return false;
  const close = modal.querySelector<HTMLButtonElement>(":scope > .ui-modal-close");
  if (close && !close.disabled) {
    close.click();
    return true;
  }
  const cancel = modalCancelButton(modal);
  if (cancel && !cancel.disabled) {
    cancel.click();
    return true;
  }
  return false;
}

let activeMobileTooltipEl: HTMLElement | null = null;
let activeMobileTooltipTimeout: number | null = null;

function isMobileOrTouch(event?: Event): boolean {
  if (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    return true;
  }
  if (event && "pointerType" in event && (event as PointerEvent).pointerType === "touch") {
    return true;
  }
  if (event && event.type.startsWith("touch")) {
    return true;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    if (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(hover: none)").matches) {
      return true;
    }
  }
  return false;
}

function dismissActiveMobileTooltip(): void {
  if (activeMobileTooltipTimeout !== null) {
    window.clearTimeout(activeMobileTooltipTimeout);
    activeMobileTooltipTimeout = null;
  }
  if (activeMobileTooltipEl) {
    activeMobileTooltipEl.removeAttribute("data-tooltip-active");
    activeMobileTooltipEl.setAttribute("data-tooltip-dismissed", "true");
    activeMobileTooltipEl.blur();
    activeMobileTooltipEl = null;
  }
}

function triggerMobileTooltip(el: HTMLElement): void {
  if (activeMobileTooltipEl && activeMobileTooltipEl !== el) {
    dismissActiveMobileTooltip();
  }

  el.removeAttribute("data-tooltip-dismissed");
  el.setAttribute("data-tooltip-active", "true");
  activeMobileTooltipEl = el;

  if (activeMobileTooltipTimeout !== null) {
    window.clearTimeout(activeMobileTooltipTimeout);
  }

  activeMobileTooltipTimeout = window.setTimeout(() => {
    if (activeMobileTooltipEl === el) {
      dismissActiveMobileTooltip();
    }
  }, 3000);
}

export function installMobileTooltips(): void {
  if (typeof window === "undefined") return;

  const handlePointerInteraction = (event: Event) => {
    if (!isMobileOrTouch(event)) return;

    const target = event.target as HTMLElement | null;
    const tooltipTarget = target?.closest<HTMLElement>("[data-tooltip]");

    if (tooltipTarget) {
      triggerMobileTooltip(tooltipTarget);
    } else {
      dismissActiveMobileTooltip();
    }
  };

  window.addEventListener("pointerdown", handlePointerInteraction, { capture: true, passive: true });
  window.addEventListener("touchstart", handlePointerInteraction, { capture: true, passive: true });
  window.addEventListener(
    "focusin",
    (event: FocusEvent) => {
      if (!isMobileOrTouch(event)) return;
      const target = event.target as HTMLElement | null;
      const tooltipTarget = target?.closest<HTMLElement>("[data-tooltip]");
      if (tooltipTarget) {
        triggerMobileTooltip(tooltipTarget);
      }
    },
    { capture: true, passive: true }
  );
}

export function upgradeNativeTooltips(root: ParentNode = document): void {
  if (typeof document === "undefined") return;
  const elements = root.querySelectorAll<HTMLElement>("body [title], [title]:not(title)");
  for (const el of Array.from(elements)) {
    const titleText = el.getAttribute("title");
    if (titleText && titleText.trim()) {
      if (!el.hasAttribute("data-tooltip")) {
        el.setAttribute("data-tooltip", titleText.trim());
      }
      if (!el.hasAttribute("aria-label")) {
        el.setAttribute("aria-label", titleText.trim());
      }
      el.removeAttribute("title");
    }
  }
}

export function installUiRefinements(): void {
  applyRefinements();
  upgradeNativeTooltips();
  installMobileTooltips();

  const observer = new MutationObserver(() => {
    applyRefinements();
    upgradeNativeTooltips();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target instanceof HTMLElement && event.target.closest(".account-card-name-input")) return;
    if (closeOpenDialog()) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}
