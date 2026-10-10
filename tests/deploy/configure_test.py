import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ConfigureInitialTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.payload = self.root / "payload"
        self.payload.mkdir()
        (self.payload / "network").write_text("192.0.2.1\n172.21.0.1\n172.21.0.2\n")
        (self.payload / "accounts.json").write_text(json.dumps([
            {"profile": p, "username": p + "_user", "displayName": p, "password": "p" * 14}
            for p in ("ruslan", "gulnaz")
        ]))
        (self.payload / "deploy.pub").write_text("ssh-ed25519 test\n")
        (self.payload / "backup-key").write_text("a" * 64)
        (self.payload / "server.header").write_text("test header\n")
        (self.payload / "server.tar.gz").write_bytes(b"test archive")
        self.config = self.root / "etc" / "stream-panel"
        self.data = self.root / "var" / "lib" / "stream-panel"
        self.current = self.root / "opt" / "stream-panel" / "current"
        self.current.mkdir(parents=True)
        (self.root / "run" / "lock").mkdir(parents=True)
        self.log = self.root / "commands.log"
        self.bin = self.root / "mock-bin"
        self.bin.mkdir()
        self.write_command("configure-bootstrap", "mkdir -p \"$TEST_CONFIG_DIR\"; test -e \"$TEST_CONFIG_DIR/server.env\" || printf 'STREAM_PANEL_BACKUP_KEY_FILE=%s/backup-key\\n' \"$TEST_DATA_DIR\" > \"$TEST_CONFIG_DIR/server.env\"")
        self.write_command("configure-receive", "echo receive >> \"$TEST_COMMAND_LOG\"")
        self.write_command("configure-systemctl", "echo \"systemctl $*\" >> \"$TEST_COMMAND_LOG\"")
        self.write_command("configure-runuser", """echo \"runuser $*\" >> \"$TEST_COMMAND_LOG\"
case \" $* \" in
  *'--input-type=module'*)
    if [[ ${MOCK_CLOUD_ERROR:-false} == true ]]; then exit 23; fi
    mkdir -p \"$STREAM_PANEL_DATA_DIR/backups\"
    printf 'SPBK1encrypted-test' > \"$STREAM_PANEL_DATA_DIR/backups/stream-panel-test-12345678.spbk\"
    if [[ -n ${STREAM_PANEL_SUPABASE_URL:-} ]]; then echo 'Provisioned local and cloud backups verified'; else echo 'Provisioned encrypted local backup verified'; fi
    ;;
esac""")
        self.write_command("install", """args=(\"$@\"); src=${args[-2]}; dst=${args[-1]}; mkdir -p \"$(dirname \"$dst\")\"; if [[ $src == /dev/null ]]; then : > \"$dst\"; else cp \"$src\" \"$dst\"; fi; chmod \"${args[1]}\" \"$dst\"""")
        self.env = {
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "TEST_CONFIG_DIR": str(self.config),
            "TEST_DATA_DIR": str(self.data),
            "TEST_COMMAND_LOG": str(self.log),
            "STREAM_PANEL_CONFIG_DIR": str(self.config),
            "STREAM_PANEL_DATA_DIR": str(self.data),
            "STREAM_PANEL_CURRENT_DIR": str(self.current),
            "STREAM_PANEL_LOCK_FILE": str(self.root / "run" / "lock" / "configure.lock"),
            "STREAM_PANEL_RECEIVE": str(self.bin / "configure-receive"),
            "STREAM_PANEL_BOOTSTRAP_TRAEFIK": str(self.bin / "configure-bootstrap"),
            "STREAM_PANEL_SYSTEMCTL": str(self.bin / "configure-systemctl"),
            "STREAM_PANEL_RUNUSER": str(self.bin / "configure-runuser"),
        }

    def tearDown(self):
        self.temp.cleanup()

    def write_command(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\nset -euo pipefail\n" + body + "\n")
        path.chmod(0o755)

    def run_configure(self, **extra):
        env = {**self.env, **extra}
        args = ["sudo", "-n", "env", *(f"{key}={value}" for key, value in env.items()), "bash", str(ROOT / "ops/configure-initial.sh")]
        try:
            return subprocess.run(args, cwd=self.payload, text=True, capture_output=True)
        finally:
            self.restore_temp_ownership()

    def restore_temp_ownership(self):
        temp_root = pathlib.Path(tempfile.gettempdir()).resolve()
        root = self.root.resolve(strict=True)
        if root.parent != temp_root or not root.name.startswith("tmp") or self.root.is_symlink():
            raise AssertionError("Refusing to chown outside this TemporaryDirectory")
        script = """import os,stat,sys
root,temp_root,uid,gid=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
if os.path.dirname(root)!=temp_root or not os.path.basename(root).startswith('tmp'):
 raise SystemExit('Temporary directory boundary check failed')
info=os.lstat(root)
if not stat.S_ISDIR(info.st_mode): raise SystemExit('Temporary root is not a real directory')
for current,dirs,files in os.walk(root,topdown=True,followlinks=False):
 dirs[:]=[name for name in dirs if not os.path.islink(os.path.join(current,name))]
 for name in dirs+files:
  os.chown(os.path.join(current,name),uid,gid,follow_symlinks=False)
os.chown(root,uid,gid,follow_symlinks=False)
"""
        subprocess.run(
            ["sudo", "-n", "python3", "-c", script, str(root), str(temp_root), str(os.getuid()), str(os.getgid())],
            check=True,
            capture_output=True,
            text=True,
        )

    def test_partial_supabase_pair_fails_before_any_server_command(self):
        (self.payload / "supabase-url").write_text("https://project.supabase.co")
        result = self.run_configure()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be provided together", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertFalse((self.root / "run" / "lock" / "configure.lock").exists())
        self.assertFalse(self.config.exists())

    def test_local_only_bootstrap_provisions_and_verifies_local_copy(self):
        self.config.mkdir(parents=True)
        (self.config / "server.env").write_text("STREAM_PANEL_BACKUP_KEY_FILE=" + str(self.data / "backup-key") + "\nSTREAM_PANEL_SUPABASE_URL=https://old.supabase.co\nSTREAM_PANEL_SUPABASE_KEY_FILE=/old/key\n")
        (self.config / "supabase-key").write_text("stale-key")
        result = self.run_configure()
        self.assertEqual(result.returncode, 0, result.stderr)
        config = (self.config / "server.env").read_text()
        self.assertNotIn("STREAM_PANEL_SUPABASE_", config)
        self.assertFalse((self.config / "supabase-key").exists())
        self.assertTrue((self.data / "backups/stream-panel-test-12345678.spbk").read_bytes().startswith(b"SPBK1"))
        self.assertIn("Provisioned encrypted local backup verified", result.stdout)

    def test_cloud_backup_failure_fails_configuration(self):
        (self.payload / "supabase-url").write_text("https://project.supabase.co")
        (self.payload / "supabase-key").write_text("service-key")
        result = self.run_configure(MOCK_CLOUD_ERROR="true")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.config / "supabase-key").is_file())
        self.assertTrue((self.data / "initializing").exists())


if __name__ == "__main__":
    unittest.main()
