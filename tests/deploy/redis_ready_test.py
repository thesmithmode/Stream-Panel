import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]

class RedisReadyTest(unittest.TestCase):
    def run_ready(self, ready_at):
        source = (ROOT / 'ops/install-redis.sh').read_text()
        function = source.split('wait_for_redis() {', 1)[1].split('\n}\nwait_for_redis', 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory)
            script = '''set -euo pipefail
# A pipeline executes Redis in a subshell; preserve the counter across attempts.
redis-cli() { local n=0; if [[ -f $COUNTER ]]; then read -r n < "$COUNTER"; fi; n=$((n+1)); echo "$n" > "$COUNTER"; if (( n >= READY_AT )); then echo PONG; else return 1; fi; }
sleep() { :; }
systemctl() { echo 'service status'; return 1; }
journalctl() { echo 'cache diagnostic'; }
wait_for_redis() {
''' + function + '\n}\nwait_for_redis\n'
            result = subprocess.run(['bash', '-c', script], env={'PATH': '/usr/bin:/bin', 'COUNTER': str(path / 'count'), 'READY_AT': str(ready_at)}, capture_output=True, text=True)
            return result, int((path / 'count').read_text())

    def test_delayed_socket_is_awaited(self):
        result, count = self.run_ready(3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(count, 3)
        self.assertNotIn('diagnostic', result.stdout)

    def test_already_ready_socket_has_no_retry(self):
        result, count = self.run_ready(1)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(count, 1)

    def test_failed_socket_is_bounded_and_reports_cache_status(self):
        result, count = self.run_ready(100)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(count, 50)
        self.assertIn('service status', result.stdout)
        self.assertIn('cache diagnostic', result.stdout)
