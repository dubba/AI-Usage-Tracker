import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseDateEastern } from "./resolve-release-version.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultChangelogPath = resolve(rootDir, "CHANGELOG.md");
const defaultGuidePath = resolve(rootDir, ".github/release-notes/download-guide.md");

// Changelog items shown before the rest folds away behind "Show more", so a long
// list does not push the downloads off screen. Whole items, whatever the section.
export const VISIBLE_ITEMS = 8;

// Each fold label is normal-size bold text behind a coloured dot. GitHub strips
// style, class and <font>, so the text itself cannot be coloured, and a badge
// image was tried and dropped: GitHub wraps every image in a link, so clicking it
// opened the picture in a new tab instead of toggling the fold. The dots are
// coloured emoji, so purple here is close to, not exactly, the scrollbar's #6d3bd7.
const CHANGELOG_FOLD_MARKER = "🟣"; // purple
const GUIDE_FOLD_MARKER = "🟢"; // green

// A non-breaking space opens the summary so there is a gap between the browser's
// own triangle marker and the first word.
const SUMMARY_GAP = "&nbsp;";

// An empty heading is a spacer: it has no height, and its 24px top margin and 16px
// bottom margin collapse through it into one 24px gap, the same gap a "###"
// heading gets above it. That puts the table clear of the folded title, which
// would otherwise sit directly on it.
const TITLE_SPACER = "<h6></h6>";

// The same idea for the changelog fold, sized to the 16px a list leaves below it,
// so the gap under "Show more" matches the gap above it. (When a section heading
// comes first in the fold, its own 24px top margin wins, as it does anywhere.)
const LIST_SPACER = "<p></p>";

/**
 * Finds a release's section in CHANGELOG.md: "## <version> - <date> (N items)",
 * or "## Unreleased" when the version has not been stamped yet (a release is
 * built before the stamp commit lands, and pre-releases are never stamped).
 * Returns the date, the section titles, and each section's bullet text, or null
 * when neither heading exists or the section holds no items.
 */
export function extractChangelogSection(changelog, version) {
  const clean = version.trim().replace(/^v/i, "");
  const text = changelog.replace(/\r\n/g, "\n");
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stable = !clean.includes("-");

  let heading = stable ? new RegExp(`^## ${escaped}(?=\\s|$)(?: - (\\d{4}-\\d{2}-\\d{2}))?[^\\n]*$`, "m").exec(text) : null;
  let stamped = heading !== null;
  if (!heading) heading = /^## Unreleased[^\n]*$/m.exec(text);
  if (!heading) return null;

  const rest = text.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;

  const sections = [];
  for (const chunk of body.split(/^### /m).slice(1)) {
    const newline = chunk.indexOf("\n");
    const title = chunk.slice(0, newline === -1 ? undefined : newline).replace(/\s*\(\d+\)\s*$/, "").trim();
    const items = (newline === -1 ? "" : chunk.slice(newline + 1))
      .split("\n")
      .reduce((all, line) => {
        if (/^- /.test(line)) all.push(line);
        else if (/^\s+\S/.test(line) && all.length > 0) all[all.length - 1] += `\n${line}`;
        return all;
      }, []);
    if (items.length > 0) sections.push({ title, items });
  }
  if (sections.length === 0) return null;

  return { date: stamped ? heading[1] || null : null, stamped, sections };
}

/**
 * The release page: what changed in this version, then the download guide.
 * Everything comes from CHANGELOG.md and the guide file, so a release needs no
 * hand-written notes. The first VISIBLE_ITEMS changelog items show; the rest sit
 * in one <details> block that continues straight on, across section headings
 * if need be. Nothing is left out, only folded.
 *
 * The download guide is folded the same way, titled by its own "## " heading. The
 * title is bold text, not a heading: GitHub strips every other way of enlarging
 * text, and a heading inside the summary brings its own 24px/16px margins, which
 * stack on the divider and the box padding.
 *
 * GitHub release pages strip CSS and scripts, so <details> is the only way to
 * fold content, and its summary text cannot change when it opens. The summary
 * therefore reads the same either way and the browser flips its triangle.
 */
export function renderReleaseNotes({ changelog, version, guide, date = releaseDateEastern(), visible = VISIBLE_ITEMS }) {
  const clean = version.trim().replace(/^v/i, "");
  const section = extractChangelogSection(changelog, clean);
  const parts = [];

  if (section) {
    const total = section.sections.reduce((sum, s) => sum + s.items.length, 0);
    const when = section.date || date;
    const lines = [`## v${clean} - ${when} (${total} ${total === 1 ? "change" : "changes"})`, ""];

    let shown = 0;
    let folded = false;
    for (const { title, items } of section.sections) {
      const heading = `### ${title} (${items.length})`;
      const room = Math.max(0, visible - shown);
      const head = folded ? [] : items.slice(0, room);
      const tail = items.slice(head.length);

      if (head.length > 0) lines.push(heading, "", ...head, "");
      shown += head.length;

      if (tail.length > 0) {
        if (!folded) {
          folded = true;
          const hidden = total - shown;
          lines.push(
            "<details>",
            `<summary>${SUMMARY_GAP}${CHANGELOG_FOLD_MARKER} <strong>Show more</strong> (${hidden} more ${hidden === 1 ? "change" : "changes"})</summary>`,
            "",
            LIST_SPACER,
            "",
          );
        }
        if (head.length === 0) lines.push(heading, "");
        lines.push(...tail, "");
      }
    }
    if (folded) lines.push("</details>", "");
    parts.push(lines.join("\n").trimEnd());
  }

  const guideText = guide.replace(/\r\n/g, "\n").trim();
  if (guideText) {
    const titled = /^## +([^\n]+)\n?/.exec(guideText);
    const title = titled ? titled[1].trim() : "Which download should I use?";
    const body = titled ? guideText.slice(titled[0].length).trim() : guideText;
    parts.push(
      ["<details>", `<summary>${SUMMARY_GAP}${GUIDE_FOLD_MARKER} <strong>${title}</strong></summary>`, "", TITLE_SPACER, "", body, "", "</details>"].join("\n"),
    );
  }
  return `${parts.join("\n\n---\n\n")}\n`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { version: null, changelog: defaultChangelogPath, guide: defaultGuidePath, output: null, date: null };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--version" && value) options.version = args[++i];
    else if (args[i] === "--changelog" && value) options.changelog = resolve(args[++i]);
    else if (args[i] === "--guide" && value) options.guide = resolve(args[++i]);
    else if (args[i] === "--output" && value) options.output = resolve(args[++i]);
    else if (args[i] === "--date" && value) options.date = args[++i];
  }
  return options;
}

function main() {
  const options = parseArgs();
  if (!options.version) {
    console.error("Usage: node scripts/release-notes.mjs --version <version> [--changelog path] [--guide path] [--output path]");
    process.exit(2);
  }
  if (!existsSync(options.guide)) {
    console.error(`Download guide not found: ${options.guide}`);
    process.exit(1);
  }
  const changelog = existsSync(options.changelog) ? readFileSync(options.changelog, "utf-8") : "";
  const notes = renderReleaseNotes({
    changelog,
    version: options.version,
    guide: readFileSync(options.guide, "utf-8"),
    ...(options.date ? { date: options.date } : {}),
  });
  if (options.output) writeFileSync(options.output, notes, "utf-8");
  else process.stdout.write(notes);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
