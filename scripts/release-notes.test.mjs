import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractChangelogSection, renderReleaseNotes } from "./release-notes.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const changelog = `# Changelog

## Unreleased (1 items)

### Added (1)

- Not shipped yet.

## 0.4.1 - 2026-10-12 (4 items)

### Improved (1)

- Setup is easier.

### Fixed (2)

- First fix.

- Second fix that wraps
  onto a second line.

### Security (1)

- Tighter token check.

## 0.4.0 - 2026-10-07 (1 item)

### Changed (1)

- Older change.
`;

test("extracts a stamped version's sections, counts bullets, and ignores neighbours", () => {
  const section = extractChangelogSection(changelog, "v0.4.1");
  assert.equal(section.date, "2026-10-12");
  assert.deepEqual(
    section.sections.map((s) => [s.title, s.items.length]),
    [["Improved", 1], ["Fixed", 2], ["Security", 1]],
  );
  assert.equal(section.sections[1].items[1], "- Second fix that wraps\n  onto a second line.");
});

test("falls back to Unreleased until the version is stamped, and for pre-releases", () => {
  const stable = extractChangelogSection(changelog, "0.4.2");
  assert.equal(stable.stamped, false);
  assert.equal(stable.sections[0].items[0], "- Not shipped yet.");
  assert.equal(extractChangelogSection(changelog, "0.4.1-beta.1").stamped, false);
});

test("a version is not matched by a longer version that starts with it", () => {
  const text = "## 0.4.10 - 2026-11-01 (1 item)\n\n### Fixed (1)\n\n- Ten.\n\n## 0.4.1 - 2026-10-12 (1 item)\n\n### Fixed (1)\n\n- One.\n";
  assert.equal(extractChangelogSection(text, "0.4.1").sections[0].items[0], "- One.");
});

test("returns null when there is nothing to show", () => {
  assert.equal(extractChangelogSection("# Changelog\n\n## Unreleased (0 items)\n\n", "0.4.2"), null);
  assert.equal(extractChangelogSection("", "0.4.2"), null);
});

test("the title carries the version, date, and change count", () => {
  const notes = renderReleaseNotes({ changelog, version: "0.4.1", guide: "## Which download should I use?\n" });
  assert.match(notes, /^## v0\.4\.1 - 2026-10-12 \(4 changes\)\n\n### Improved \(1\)/);
  assert.doesNotMatch(notes, /·/, "no separate date line under the title");
  assert.doesNotMatch(notes, /Older change|Not shipped yet/);
  assert.ok(notes.indexOf("## v0.4.1") < notes.indexOf("Which download should I use?"));
});

test("the download guide is folded, titled by its own heading, and comes last", () => {
  const notes = renderReleaseNotes({
    changelog,
    version: "0.4.1",
    guide: "## Which download should I use?\n\n| a | b |\n\n### Extra\n\nText.\n",
  });
  assert.ok(
    notes.endsWith(
      "<details>\n<summary>&nbsp;🟢 <strong>Which download should I use?</strong></summary>\n\n<h6></h6>\n\n| a | b |\n\n### Extra\n\nText.\n\n</details>\n",
    ),
    notes.slice(-200),
  );
  assert.doesNotMatch(notes, /^## Which download/m, "the heading became the summary");
});

test("a short changelog is shown in full with nothing folded", () => {
  const notes = renderReleaseNotes({ changelog, version: "0.4.1", guide: "g" });
  assert.doesNotMatch(notes, /Show more/);
  assert.equal(notes.split("<details>").length, 2, "only the download guide is folded");
});

test("items past the cutoff fold into one block that spans sections, losing nothing", () => {
  const notes = renderReleaseNotes({ changelog, version: "0.4.1", guide: "g", visible: 2 });
  const [shown, folded] = notes.split("<details>");
  // Two items visible: Improved's one, then the first of Fixed. The rest folds.
  assert.match(shown, /### Improved \(1\)\n\n- Setup is easier\.\n\n### Fixed \(2\)\n\n- First fix\.\n\n$/);
  assert.match(folded, /<summary>&nbsp;🟣 <strong>Show more<\/strong> \(2 more changes\)<\/summary>/);
  assert.match(folded, /- Second fix that wraps\n  onto a second line\.\n\n### Security \(1\)\n\n- Tighter token check\.\n\n<\/details>/);
  assert.equal(notes.split("<details>").length, 3, "one changelog fold, then the download guide");
  // Every changelog item appears exactly once.
  for (const item of ["Setup is easier", "First fix", "Second fix that wraps", "Tighter token check"]) {
    assert.equal(notes.split(item).length, 2, item);
  }
});

test("a cutoff that lands on a section boundary starts the fold at the next heading", () => {
  const notes = renderReleaseNotes({ changelog, version: "0.4.1", guide: "g", visible: 1 });
  const [shown, folded] = notes.split("<details>");
  assert.match(shown, /### Improved \(1\)\n\n- Setup is easier\.\n\n$/);
  assert.doesNotMatch(shown, /### Fixed/);
  assert.match(folded, /<\/summary>\n\n<p><\/p>\n\n### Fixed \(2\)\n\n- First fix\./);
});

test("a release with no changelog items still gets the download guide", () => {
  const notes = renderReleaseNotes({ changelog: "", version: "0.4.2", guide: "## Guide\n\nSteps.\n" });
  assert.equal(notes, "<details>\n<summary>&nbsp;🟢 <strong>Guide</strong></summary>\n\n<h6></h6>\n\nSteps.\n\n</details>\n");
});

test("the Unreleased fallback is dated by the release date it is given", () => {
  const notes = renderReleaseNotes({ changelog, version: "0.4.2", guide: "g", date: "2026-10-15" });
  assert.match(notes, /^## v0\.4\.2 - 2026-10-15 \(1 change\)\n/);
});

test("the real download guide covers every platform and the first-launch steps", () => {
  const guide = readFileSync(resolve(root, ".github/release-notes/download-guide.md"), "utf-8");
  for (const needle of ["-setup.exe", ".msi", ".dmg", ".apk", ".ipa", "Run anyway", "Open Anyway"]) {
    assert.ok(guide.includes(needle), `guide mentions ${needle}`);
  }
});
