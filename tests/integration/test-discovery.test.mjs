import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);

test("empty test segments fail before node can silently discover another suite", async () => {
  const runner = resolve("scripts/test-with-coverage.mjs");
  for (const [segment, directory] of [["unit", "dist/packages/core/test"], ["integration", "dist/apps/daemon/test"], ["e2e", "tests/e2e"]]) {
    const dir = await mkdtemp(join(tmpdir(), "sp-empty-tests-"));
    try {
      await mkdir(join(dir, directory), { recursive: true });
      await assert.rejects(execute(process.execPath, [runner, segment], { cwd: dir }), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /NO_TESTS_IN_DIRECTORY/);
        assert.doesNotMatch(error.stdout, /tests [1-9]/);
        return true;
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
