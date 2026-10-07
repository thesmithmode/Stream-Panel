import { spawn } from "node:child_process";
import { rm, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
export async function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
await rm("coverage", { recursive: true, force: true });
await mkdir("coverage/raw", { recursive: true });
const files = [];
for (const dir of [
  "dist/packages/core/test",
  "dist/apps/daemon/test",
  "tests/e2e",
  "tests/integration",
])
  for (const file of await readdir(dir))
    if (/\.test\.(m?js)$/.test(file)) files.push(join(dir, file));
const webUnit = [];
for (const file of await readdir("apps/web/src"))
  if (/\.test\.ts$/.test(file)) webUnit.push(join("apps/web/src", file));
const exitMain = await run(
  process.execPath,
  ["--test", "--test-concurrency=2", ...files],
  {
    ...process.env,
    NODE_V8_COVERAGE: resolve("coverage/raw"),
    STREAM_PANEL_COVERAGE: "1",
  },
);
const exitWeb = webUnit.length
  ? await run(
      process.execPath,
      [
        "--experimental-strip-types",
        "--test",
        "--test-concurrency=2",
        ...webUnit,
      ],
      {
        ...process.env,
        NODE_V8_COVERAGE: resolve("coverage/raw"),
        STREAM_PANEL_COVERAGE: "1",
      },
    )
  : 0;
const exit = exitMain || exitWeb;
const report = await run(process.execPath, [
  "node_modules/c8/bin/c8.js",
  "report",
]);
const gate = await run(process.execPath, ["scripts/coverage-gate.mjs"]);
process.exitCode = exit || report || gate;
