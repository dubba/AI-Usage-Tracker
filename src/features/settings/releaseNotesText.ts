const DETAILS_BLOCK = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi;

/**
 * Turns a GitHub release body into plain changelog markdown for the update
 * modal: the "Show more" fold is opened so every change shows, every other
 * fold (the download guide) is dropped, and leftover HTML and separators go.
 */
export function cleanReleaseNotes(body: string): string {
  return body
    .replace(DETAILS_BLOCK, (_all, summary: string, content: string) => (/show more/i.test(summary) ? `\n${content}\n` : "\n"))
    .replace(/<\/?details[^>]*>|<summary[\s\S]*?<\/summary>/gi, "")
    .replace(/<[a-z/][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/^\s*(?:---+|\*\*\*+)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns the update's publish time into a short local date. The desktop updater hands it over as
 * Rust prints it ("2026-10-17 3:51:37.748 +00:00:00"), which `Date` cannot read, so that shape is
 * rewritten as ISO first. GitHub's ISO timestamps pass straight through. An unreadable value is
 * returned as it came.
 */
export function formatReleaseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const rust = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})(\.\d+)? ([+-])(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  const iso = rust
    ? `${rust[1]}T${rust[2].padStart(2, "0")}:${rust[3]}:${rust[4]}${rust[5] ?? ""}${rust[6]}${rust[7]}:${rust[8]}`
    : value;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
