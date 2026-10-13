import { describe, expect, it } from "vitest";
import { cleanReleaseNotes } from "./releaseNotesText";

const body = `## v0.4.1 - 2026-10-12 (3 changes)

### Fixed (3)

- One.

<details>
<summary>&nbsp;🟣 <strong>Show more</strong> (2 more changes)</summary>

<p></p>

- Two.

### Added (1)

- Three.

</details>

---

<details>
<summary>&nbsp;🟢 <strong>Which download should I use?</strong></summary>

<h6></h6>

| Platform | File |
| --- | --- |
| Windows | -setup.exe |

</details>
`;

describe("cleanReleaseNotes", () => {
  it("keeps every change, including the folded ones, as plain markdown", () => {
    const out = cleanReleaseNotes(body);
    expect(out).toBe("## v0.4.1 - 2026-10-12 (3 changes)\n\n### Fixed (3)\n\n- One.\n\n- Two.\n\n### Added (1)\n\n- Three.");
  });

  it("drops the download guide and every HTML tag, marker and separator", () => {
    const out = cleanReleaseNotes(body);
    expect(out).not.toMatch(/download|Platform|setup\.exe|<|&nbsp;|🟣|🟢|^---$/im);
  });

  it("leaves plain changelog text untouched", () => {
    expect(cleanReleaseNotes("### Fixed (1)\n\n- A fix.\n")).toBe("### Fixed (1)\n\n- A fix.");
  });
});
