import test from "node:test";
import assert from "node:assert/strict";
import lib from "istanbul-lib-coverage";
import { failures } from "../../scripts/coverage-policy.mjs";
function map(hit, total = 20) {
  const loc = (i) => ({
    start: { line: i + 1, column: 0 },
    end: { line: i + 1, column: 1 },
  });
  const path = "/runtime.ts",
    statementMap = {},
    fnMap = {},
    branchMap = {},
    s = {},
    f = {},
    b = {};
  for (let i = 0; i < total; i++) {
    statementMap[i] = loc(i);
    fnMap[i] = { name: "f" + i, decl: loc(i), loc: loc(i) };
    branchMap[i] = { type: "if", loc: loc(i), locations: [loc(i)] };
    s[i] = f[i] = i < hit ? 1 : 0;
    b[i] = [s[i]];
  }
  return lib.createCoverageMap({
    [path]: { path, statementMap, fnMap, branchMap, s, f, b },
  });
}
test("quality gate requires 95 percent of lines, branches and functions even when tests succeeded", () => {
  assert.deepEqual(failures(map(19), ["/runtime.ts"]), []);
  assert.deepEqual(failures(map(20), ["/runtime.ts"]), []);
  const low = failures(map(18), ["/runtime.ts"]);
  assert.ok(low.some((s) => s.includes("Total lines")));
  assert.ok(low.some((s) => s.includes("Total branches")));
  assert.ok(low.some((s) => s.includes("Total functions")));
  assert.ok(low.some((s) => s.includes("/runtime.ts: lines")));
  assert.match(
    failures(map(20), ["/runtime.ts", "/new-file.ts"]).join("\n"),
    /Missing source coverage: \/new-file.ts/,
  );
  assert.match(failures(map(0), ["/runtime.ts"]).join("\n"), /<95%/);
});
