import { setCustomAccountEmail } from "./account-metadata";

const REGISTRY_KEY = "ai-subscription-tracker:opencode-account-emails";

type OpenCodeEmailRecord = {
  accountId: string;
  label: string;
  email: string;
};

function loadRecords(): OpenCodeEmailRecord[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REGISTRY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is OpenCodeEmailRecord => Boolean(
      entry
      && typeof entry === "object"
      && typeof (entry as OpenCodeEmailRecord).accountId === "string"
      && typeof (entry as OpenCodeEmailRecord).label === "string"
      && typeof (entry as OpenCodeEmailRecord).email === "string",
    ));
  } catch {
    return [];
  }
}

function saveRecords(records: OpenCodeEmailRecord[]): void {
  try {
    window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(records));
  } catch {
    // The account remains usable if WebView storage is unavailable.
  }
}

export function saveOpenCodeAccountEmail(accountId: string, label: string, email: string): void {
  const normalized = email.trim();
  setCustomAccountEmail(accountId, normalized);
  if (!normalized) return;

  const records = loadRecords();
  const existing = records.find((record) => record.accountId === accountId);
  if (existing) {
    existing.label = label.trim();
    existing.email = normalized;
  } else {
    records.push({ accountId, label: label.trim(), email: normalized });
  }
  saveRecords(records);
}

export function getOpenCodeEmailRecord(accountId: string): OpenCodeEmailRecord | null {
  return loadRecords().find((record) => record.accountId === accountId) ?? null;
}

export function resolveOpenCodeEmailRecord(
  label: string,
  usedAccountIds: ReadonlySet<string>,
): OpenCodeEmailRecord | null {
  const records = loadRecords();
  return [...records]
    .reverse()
    .find((record) => !usedAccountIds.has(record.accountId) && record.label === label)
    ?? null;
}

export function renameOpenCodeEmailRecord(accountId: string, label: string): void {
  const records = loadRecords();
  const record = records.find((candidate) => candidate.accountId === accountId);
  if (!record || record.label === label) return;
  record.label = label;
  saveRecords(records);
}
