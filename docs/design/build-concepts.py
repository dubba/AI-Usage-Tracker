#!/usr/bin/env python3
"""Generate one standalone mockup page per concept from the combined prototype."""
import re
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SRC = (HERE / "usage-redesign-concepts.html").read_text()

CONCEPTS = {
    "A": {
        "name": "Calendar heat",
        "blurb": "Every day is a cell: a month grid on 30 days, a quarter of week columns on 90. The 7-day bars are unchanged.",
    },
    "B": {
        "name": "Weekly cycles",
        "blurb": "The weekly limit resets, so the cycle is the unit: cumulative burn-up per week on 30 days, fill and pace on 90.",
    },
    "C": {
        "name": "Portfolio",
        "blurb": "Page-level health first, then compact account rows: a combined stacked burn chart and detail that opens in place.",
    },
}

TABS = re.compile(r'\n\s*<div class="concept-tabs".*?</div>\n', re.S)
COMPARE = re.compile(r'\n\s*<section class="compare">.*?</section>\n', re.S)

for key, meta in CONCEPTS.items():
    html = SRC
    html = TABS.sub("\n", html)
    html = COMPARE.sub("\n", html)
    html = html.replace("<title>Usage page — three redesign directions</title>", f"<title>Usage page — concept {key}</title>")
    html = html.replace('<div class="kicker">Usage page · design exploration</div>', f'<div class="kicker">Usage page · concept {key} of 3</div>')
    html = html.replace("<h1>Three directions for the 30- and 90-day views</h1>", f"<h1>{key} · {meta['name']}</h1>")
    html = html.replace(
        "Same accounts, same data, three different information architectures. The 7-day bars stay close to what works today; the longer ranges get treatments built for them. Switch period inside each concept, and hover the marks for exact values.",
        meta["blurb"] + " Switch the period to see 7, 30 and 90 days; hover any mark for its exact value.",
    )
    html = html.replace('const state = { concept: "A", period: "30d" };', f'const state = {{ concept: "{key}", period: "30d" }};')
    out = HERE / f"concept-{key.lower()}.html"
    out.write_text(html)
    print("wrote", out.name, len(html), "bytes")
