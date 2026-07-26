import {
  getOpenCodeEmailRecord,
  renameOpenCodeEmailRecord,
  resolveOpenCodeEmailRecord,
} from "./opencode-account-email";

type CardProvider = "openai" | "anthropic" | "antigravity" | "opencode_go";

function cardProvider(card: HTMLElement): CardProvider | null {
  const icon = card.querySelector<HTMLElement>(".account-card-provider-icon");
  if (icon?.classList.contains("provider-openai")) return "openai";
  if (icon?.classList.contains("provider-anthropic")) return "anthropic";
  if (icon?.classList.contains("provider-antigravity")) return "antigravity";
  if (icon?.classList.contains("provider-opencode_go")) return "opencode_go";
  return null;
}

function refineHeader(card: HTMLElement): void {
  const nameRow = card.querySelector<HTMLElement>(".account-card-name-row");
  const plan = card.querySelector<HTMLElement>(".account-plan-badge");
  if (nameRow && plan?.textContent?.trim()) {
    nameRow.dataset.plan = plan.textContent.trim();
  } else if (nameRow) {
    delete nameRow.dataset.plan;
  }

  const remove = Array.from(card.querySelectorAll<HTMLButtonElement>(".account-card-header-actions button"))
    .find((button) => button.title === "Remove this account");
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

function refineOpenCodeEmails(cards: HTMLElement[]): void {
  const usedAccountIds = new Set<string>();
  const openCodeCards = cards.filter((candidate) => candidate.dataset.provider === "opencode_go");

  for (const card of [...openCodeCards].reverse()) {
    const name = card.querySelector<HTMLElement>(".account-card-name-row h2")?.textContent?.trim();
    const subtitle = card.querySelector<HTMLElement>(".account-card-identity > p");
    if (!name || !subtitle) continue;

    const assignedId = card.dataset.emailAccountId;
    const assignedRecord = assignedId ? getOpenCodeEmailRecord(assignedId) : null;
    const record = assignedRecord && !usedAccountIds.has(assignedRecord.accountId)
      ? assignedRecord
      : resolveOpenCodeEmailRecord(name, usedAccountIds);
    if (!record) continue;

    usedAccountIds.add(record.accountId);
    card.dataset.emailAccountId = record.accountId;
    renameOpenCodeEmailRecord(record.accountId, name);
    if (subtitle.textContent !== record.email) subtitle.textContent = record.email;
  }
}

function applyRefinements(): void {
  const cards = Array.from(document.querySelectorAll<HTMLElement>(".provider-account-card"));
  for (const card of cards) refineAccountCard(card);
  refineOpenCodeEmails(cards);
}

export function installUiRefinements(): void {
  applyRefinements();
  const observer = new MutationObserver(() => applyRefinements());
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
