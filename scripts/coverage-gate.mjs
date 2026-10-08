import lib from "istanbul-lib-coverage";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { failures } from "./coverage-policy.mjs";
const expected = [];
async function inventory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await inventory(path);
    else if (/\.(ts|svelte)$/.test(path) && !path.endsWith(".d.ts") && !path.endsWith(".test.ts"))
      expected.push(resolve(path));
  }
}
for (const dir of ["packages/core/src", "apps/daemon/src", "apps/web/src"])
  await inventory(dir);
const map = lib.createCoverageMap({});
async function collect(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if(entry.isDirectory())await collect(path);
    else if(entry.name==="coverage-final.json"||directory.endsWith("browser")&&entry.name.endsWith(".json")) {
      const raw=JSON.parse(await readFile(path,"utf8"));
      for(const [source,data] of Object.entries(raw)) if(expected.includes(resolve(source)))map.addFileCoverage({...data,path:resolve(source)});
    }
  }
}
if(process.argv[2]==="segments")await collect("coverage/segments");
else {await collect("coverage/node");try{await collect("coverage/browser");}catch(e){if(e.code!=="ENOENT")throw e;}}
const violations = failures(map, expected);
const summary = map.getCoverageSummary();
console.log("Combined Node + browser coverage:", summary.data);
const perFile = Object.fromEntries(
  map.files().map((path) => [path, map.fileCoverageFor(path).toSummary().data]),
);
await mkdir("coverage", { recursive: true });
await writeFile("coverage/coverage-final.json", JSON.stringify(map.toJSON()));
await writeFile(
  "coverage/coverage-summary.json",
  JSON.stringify({ total: summary.data, ...perFile }, null, 2),
);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
