import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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

test('consecutive coverage runs use separate raw and browser directories and report only their own input',async()=>{
 const runner=resolve('scripts/test-with-coverage.mjs'),dir=await mkdtemp(join(tmpdir(),'sp-coverage-runs-'));
 try {
  for(const path of ['dist/packages/core/test','apps/web/src','node_modules/c8/bin'])await mkdir(join(dir,path),{recursive:true});
  await writeFile(join(dir,'dist/packages/core/test/fixture.test.js'),`const test=require('node:test');const assert=require('node:assert/strict');test('runner environment',()=>{assert.match(process.env.NODE_V8_COVERAGE,/run-[^/]+\\/raw$/);assert.equal(process.env.STREAM_PANEL_BROWSER_COVERAGE_DIR,require('node:path').join(require('node:path').dirname(process.env.NODE_V8_COVERAGE),'browser'));});`);
  await writeFile(join(dir,'apps/web/src/fixture.test.ts'),`import test from 'node:test';test('web fixture',()=>{});`);
  await writeFile(join(dir,'node_modules/c8/bin/c8.js'),`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const args=process.argv.slice(2),raw=args[args.indexOf('--temp-directory')+1],report=args[args.indexOf('--reports-dir')+1];assert.match(raw,/run-[^/]+\\/raw$/);assert.equal(report,path.join(path.dirname(raw),'node'));assert.ok(fs.readdirSync(raw).some(f=>f.endsWith('.json')));fs.appendFileSync('runs.jsonl',JSON.stringify({raw,report})+'\\n');`);
  const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
  await execute(process.execPath,[runner,'unit'],{cwd:dir,env:childEnv});await execute(process.execPath,[runner,'unit'],{cwd:dir,env:childEnv});
  const [a,b]=(await readFile(join(dir,'runs.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.notEqual(a.raw,b.raw);assert.notEqual(a.report,b.report);
 }finally{await rm(dir,{recursive:true,force:true});}
});
