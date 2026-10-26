import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHA = 'a' * 40

class BundleSelectionTest(unittest.TestCase):
    def run_case(self, artifacts):
        with tempfile.TemporaryDirectory() as directory:
            directory = pathlib.Path(directory)
            run = dict(id=42, head_sha=SHA, head_branch='main', conclusion='success', event='workflow_dispatch', head_repository=dict(full_name='owner/repo'))
            (directory / 'runs.json').write_text(json.dumps(dict(workflow_runs=[run])))
            (directory / 'artifacts.json').write_text(json.dumps(dict(artifacts=artifacts)))
            gh = directory / 'gh'
            gh.write_text('#!/usr/bin/env python3\nimport pathlib,sys\nroot=pathlib.Path(__file__).parent\nprint((root / ("artifacts.json" if "/artifacts?" in sys.argv[2] else "runs.json")).read_text())\n')
            gh.chmod(0o755)
            env = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ['PATH'], GITHUB_ENV=str(directory / 'env'))
            result = subprocess.run(['node', 'scripts/select-ci-bundle.mjs', 'owner/repo', SHA], cwd=ROOT, env=env, capture_output=True, text=True)
            content = (directory / 'env').read_text() if (directory / 'env').exists() else ''
            return result, content

    def test_manual_exact_sha_with_live_bundle_is_usable(self):
        result, content = self.run_case([dict(name='server-bundle', expired=False, expires_at='2099-01-01T00:00:00Z')])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('STREAM_PANEL_CI_RUN=42\n', content)
        self.assertIn('STREAM_PANEL_RELEASE=' + SHA, content)

    def test_expired_or_missing_bundle_fails_before_publishing_run_id(self):
        for artifacts in ([], [dict(name='server-bundle', expired=True, expires_at='2099-01-01T00:00:00Z')], [dict(name='server-bundle', expired=False, expires_at='2000-01-01T00:00:00Z')]):
            result, content = self.run_case(artifacts)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(content, '')
            self.assertIn('Rerun Quality gate on this exact main SHA', result.stderr)
