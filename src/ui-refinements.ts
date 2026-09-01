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

  const labelText = label.textContent?.trim() ?? "";

  // v0.2.29 mistakenly hid the complete OpenAI metric when its label was
  // "Session". Keep the quota value, window badge, bar, and reset time;
  // only hide the redundant heading text.
  metric.classList.remove("ui-hidden-metric");
  label.classList.toggle(
    "ui-hidden-metric-label",
    provider === "openai" && labelText.toLowerCase() === "session",
  );

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
  return Array.from(modal.querySelectorAll<HTMLButtonElement>(".modal-actions button"))
    .find((button) => {
      const label = button.textContent?.trim().toLowerCase();
      return label === "cancel" || label === "close";
    }) ?? null;
}

function refineModalCloseButton(modal: HTMLElement): void {
  let close = modal.querySelector<HTMLButtonElement>(":scope > .ui-modal-close");
  if (!close) {
    close = document.createElement("button");
    close.type = "button";
    close.className = "ui-modal-close";
    close.setAttribute("aria-label", "Close dialog");
    close.title = "Close";
    close.textContent = "×";
    modal.prepend(close);
  }

  close.disabled = false;
  close.onclick = () => {
    modalCancelButton(modal)?.click();
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

export function installUiRefinements(): void {
  applyRefinements();

  const observer = new MutationObserver(() => {
    applyRefinements();
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
