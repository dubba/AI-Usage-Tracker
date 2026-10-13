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
