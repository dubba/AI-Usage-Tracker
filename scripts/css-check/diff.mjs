// Compares two recordings made by dump.mjs and prints every element whose computed styles differ.
//
//   node scripts/css-check/diff.mjs <before.json> <after.json> [max lines shown, default 40]
//
// Exits 1 when anything differs.
import { readFileSync } from "node:fs";
import { PROPS } from "./props.mjs";

const [beforePath, afterPath, limitArg] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("usage: node scripts/css-check/diff.mjs <before.json> <after.json> [max lines]");
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const limit = limitArg ? Number(limitArg) : 40;

let total = 0;
let shown = 0;
let viewsWithDifferences = 0;
const elements = Object.values(before).reduce((sum, view) => sum + Object.keys(view).length, 0);
console.log(`views ${Object.keys(before).length} ${Object.keys(after).length}, elements ${elements}`);

const report = (line) => {
  if (shown < limit) console.log(line);
  shown += 1;
};

for (const view of Object.keys(after)) {
  if (!(view in before)) {
    console.log(`MISSING view in before: ${view}`);
    total += 1;
  }
}
for (const [view, a] of Object.entries(before)) {
  const b = after[view];
  if (!b) {
    console.log(`MISSING view in after: ${view}`);
    total += 1;
    continue;
  }
  let count = 0;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] === b[key]) continue;
    count += 1;
    if (!(key in a) || !(key in b)) {
      report(`  ${view} ${key} only in ${key in a ? "before" : "after"}`);
      continue;
    }
    const x = a[key].split("|");
    const y = b[key].split("|");
    const changes = PROPS.filter((_, i) => x[i] !== y[i]).map((prop) => {
      const i = PROPS.indexOf(prop);
      return `${prop}: ${x[i]} -> ${y[i]}`;
    });
    report(`  ${view} ${key.slice(-90)} ${changes.join("; ").slice(0, 200)}`);
  }
  total += count;
  if (count) viewsWithDifferences += 1;
}
if (shown > limit) console.log(`  ... ${shown - limit} more not shown`);
console.log(`differences: ${total} in ${viewsWithDifferences} views`);
process.exit(total ? 1 : 0);
