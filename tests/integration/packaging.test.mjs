import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("package-release script produces linux portable archive layout (--skip-runtime)", () => {
  assert.ok(existsSync(join(root, "scripts/package-release.mjs")));
  assert.ok(existsSync(join(root, "scripts/windows-launcher.cs")));
  assert.ok(existsSync(join(root, "dist/apps/daemon/src/index.js")), "run pnpm build first");

  const out = join(root, "artifacts", "release");
  rmSync(out, { recursive: true, force: true });

  const result = spawnSync(
    process.execPath,
    ["scripts/package-release.mjs", "--skip-build", "--skip-runtime"],
    { cwd: root, encoding: "utf8", env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.ok(manifest.version);
  assert.ok(manifest.artifacts.length >= 1);
  assert.ok(existsSync(join(out, "SHA256SUMS")));

  if (process.platform === "linux") {
    const tar = manifest.artifacts.find((a) => a.file.endsWith(".tar.gz"));
    assert.ok(tar, "expected linux tar.gz");
    const list = spawnSync("tar", ["-tzf", join(out, tar.file)], {
      encoding: "utf8",
    });
    assert.equal(list.status, 0);
    assert.match(list.stdout, /stream-panel-\d/);
    assert.match(list.stdout, /\/app\/dist\/apps\/daemon\/src\/index\.js/);
    assert.match(list.stdout, /\/stream-panel$/m);
    assert.match(list.stdout, /apps\/web\/dist\/index\.html/);
  }
});
