export const metrics = ["lines", "branches", "functions"];
export function failures(map, expected) {
  const result = expected
    .filter((path) => !map.files().includes(path))
    .map((path) => `Missing source coverage: ${path}`);
  for (const metric of metrics) {
    const pct = map.getCoverageSummary().data[metric].pct;
    if (typeof pct !== "number" || pct < 95)
      result.push(`Total ${metric}: ${pct}% <95%`);
  }
  for (const path of map.files()) {
    const pct = map.fileCoverageFor(path).toSummary().data.lines.pct;
    if (typeof pct !== "number" || pct < 95)
      result.push(`${path}: lines ${pct}% <95%`);
  }
  return result;
}
