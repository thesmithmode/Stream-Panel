"""Run only inside the disposable CI container, never on a deployment host."""
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import tempfile
import unittest

if os.environ.get('STREAM_PANEL_BOOTSTRAP_CONTAINER') != 'true' or pathlib.Path('/work').is_dir() is False:
    raise RuntimeError('Disposable bootstrap CI container required')

OWNED = [pathlib.Path(p) for p in (
    '/opt/stream-panel', '/etc/stream-panel', '/var/lib/stream-panel',
    '/var/lib/stream-panel-deploy', '/etc/systemd/system/stream-panel.service',
    '/etc/sudoers.d/stream-panel', '/usr/local/sbin/stream-panel-receive',
    '/root/traefik/config/stream-panel.yml',
)]

class BootstrapRuntimeTests(unittest.TestCase):
    def setUp(self):
        for path in OWNED:
            self.assertFalse(path.exists(), f'Fixture dirty: {path}')
        self.temp = tempfile.TemporaryDirectory(prefix='sp-bootstrap-fixture-')
        self.folder = pathlib.Path(self.temp.name)
        self.commands = self.folder / 'commands'
        self.commands.mkdir()
        self.route_dir = pathlib.Path('/root/traefik/config')
        self.route_dir.mkdir(parents=True, exist_ok=True)
        self.sentinel = self.route_dir / 'unrelated.yml'
        self.sentinel.write_text('unrelated-service-preserved')
        self.key = self.folder / 'deploy'
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(self.key)], check=True)
        self.backup_key = self.folder / 'backup-key'
        self.backup_key.write_text('a' * 64)
        self.mock('ip', "printf '2: fixture inet 172.21.0.1/16 scope global fixture\\n'")
        self.mock('ss', 'exit 0')
        self.mock('systemctl', 'exit 0')
        topology = [{
            'State': {'Running': True},
            'NetworkSettings': {'Networks': {'traefik-proxy': {'IPAddress': '172.21.0.2', 'Gateway': '172.21.0.1'}}},
            'Mounts': [{'Source': '/root/traefik/config', 'Destination': '/config'}],
            'Args': ['--providers.file.directory=/config', '--providers.file.watch=true',
                     '--entrypoints.websecure.address=:443', '--certificatesresolvers.letsencrypt.acme.httpchallenge=true'],
        }]
        self.topology = self.folder / 'topology.json'
        self.topology.write_text(json.dumps(topology))
        self.mock('docker', f'cat "{self.topology}"')
        self.mock('install', '/usr/bin/install "$@"\nif [[ ${FAIL_LATE:-} == true && "$*" == *"/etc/systemd/system/stream-panel.service"* ]]; then exit 55; fi')
        self.env = {**os.environ, 'PATH': str(self.commands) + ':' + os.environ['PATH']}

    def mock(self, name, body):
        path = self.commands / name
        path.write_text('#!/bin/bash\nset -euo pipefail\n' + body + '\n')
        path.chmod(0o755)

    def bootstrap(self, **overrides):
        return subprocess.run([
            'bash', '/work/ops/bootstrap-traefik.sh', '8.8.4.4', str(self.key) + '.pub',
            str(self.backup_key), '172.21.0.1', '172.21.0.2',
        ], env={**self.env, **overrides}, capture_output=True, text=True, timeout=30)

    def assert_no_installation(self):
        for path in OWNED:
            self.assertFalse(path.exists(), f'Partial bootstrap retained {path}')
        for user in ('stream-panel', 'stream-panel-deploy'):
            with self.assertRaises(KeyError):
                pwd.getpwnam(user)
        self.assertEqual(self.sentinel.read_text(), 'unrelated-service-preserved')

    def test_success_creates_private_service_and_exclusive_route(self):
        result = self.bootstrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        route = (self.route_dir / 'stream-panel.yml').read_text()
        self.assertIn('Host(`stream-panel.8-8-4-4.sslip.io`)', route)
        self.assertIn('http://172.21.0.1:47831', route)
        self.assertEqual(self.sentinel.read_text(), 'unrelated-service-preserved')
        self.assertEqual(pathlib.Path('/etc/stream-panel/bootstrap-identity.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(pathlib.Path('/etc/stream-panel/backup-key').stat().st_mode & 0o777, 0o640)
        self.assertIn('restrict,command=', pathlib.Path('/var/lib/stream-panel-deploy/.ssh/authorized_keys').read_text())
        retry = self.bootstrap()
        self.assertNotEqual(retry.returncode, 0)
        self.assertEqual((self.route_dir / 'stream-panel.yml').read_text(), route)

    def test_unexpected_topology_fails_before_application_mutations(self):
        topology = json.loads(self.topology.read_text())
        topology[0]['Args'] = [a for a in topology[0]['Args'] if not a.startswith('--entrypoints.websecure')]
        self.topology.write_text(json.dumps(topology))
        self.assertNotEqual(self.bootstrap().returncode, 0)
        self.assert_no_installation()

    def test_late_failure_rolls_back_only_owned_objects(self):
        self.assertNotEqual(self.bootstrap(FAIL_LATE='true').returncode, 0)
        self.assert_no_installation()

    def tearDown(self):
        # These paths exist only in the disposable container; /work is read-only.
        for path in OWNED:
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)
        for user in ('stream-panel', 'stream-panel-deploy'):
            subprocess.run(['userdel', user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(['groupdel', user], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.temp.cleanup()

if __name__ == '__main__':
    unittest.main()
