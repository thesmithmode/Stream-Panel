import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ReceiverUpdateTests(unittest.TestCase):
    def run_update(self, payload, key='fixture-key'):
        source = (ROOT / '.github/workflows/deploy.yml').read_text()
        section = source.split('name: Update trusted deployment receiver without restarting collection', 1)[1]
        block = section.split('        run: |\n', 1)[1].split('      - uses:', 1)[0]
        script = '\n'.join(line[10:] for line in block.splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            folder = pathlib.Path(temporary)
            (folder / 'ops').mkdir()
            (folder / 'ops/receive.py').write_text(payload)
            receiver = folder / 'installed/stream-panel-receive'
            receiver.parent.mkdir()
            receiver.write_text('previous receiver')
            commands = folder / 'bin'
            commands.mkdir()
            stubs = {
                'ssh': r'''remote=${!#}
remote=${remote//\/usr\/local\/sbin/$TEST_RECEIVER_DIR}
bash -c "$remote"
''',
                'chown': 'exit 0\n',
                'systemctl': 'exit 55\n',
            }
            for name, body in stubs.items():
                path = commands / name
                path.write_text('#!/bin/bash\nset -eu\n' + body)
                path.chmod(0o755)
            env = {**os.environ, 'PATH': str(commands) + ':' + os.environ['PATH'],
                   'BOOTSTRAP_KEY': key, 'KNOWN_HOSTS': 'fixture-host', 'DEPLOY_HOST': '192.0.2.1',
                   'DEPLOY_PORT': '22', 'TEST_RECEIVER_DIR': str(receiver.parent)}
            result = subprocess.run(['bash', '-c', script], cwd=folder, env=env, capture_output=True, text=True)
            return result.returncode, receiver.read_text(), receiver.stat().st_mode & 0o777, list(receiver.parent.iterdir())

    def test_verified_receiver_replaces_existing_file_atomically_without_restarting_service(self):
        payload = (ROOT / 'ops/receive.py').read_text()
        code, content, mode, remaining = self.run_update(payload)
        self.assertEqual(code, 0)
        self.assertEqual(content, payload)
        self.assertEqual(mode, 0o755)
        self.assertEqual(len(remaining), 1)

    def test_invalid_python_and_missing_credentials_leave_previous_receiver_intact(self):
        for payload, key in [('def invalid(', 'fixture-key'), ('print("new")', '')]:
            with self.subTest(key=bool(key)):
                code, content, _, remaining = self.run_update(payload, key)
                self.assertNotEqual(code, 0)
                self.assertEqual(content, 'previous receiver')
                self.assertEqual(len(remaining), 1)
