#!/usr/bin/python3
"""Root-owned, argument-free forced-command receiver. Never executes uploaded code as root."""
import fcntl, hashlib, json, os, pathlib, pwd, re, shutil, sqlite3, subprocess, sys, tarfile, tempfile, time, urllib.request
BASE = pathlib.Path('/opt/stream-panel')
DATA = pathlib.Path('/var/lib/stream-panel')
STATE = pathlib.Path('/var/lib/stream-panel-deploy')
SERVICE = 'stream-panel.service'
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_EXPANDED = 450 * 1024 * 1024

def unpack(archive, destination):
    if not hasattr(tarfile, 'data_filter'):
        raise RuntimeError('Python security update with tarfile.data_filter required')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        if len(members) > 30000 or sum(m.size for m in members) > MAX_EXPANDED:
            raise RuntimeError('Bundle limit exceeded')
        for member in members:
            parts = pathlib.PurePosixPath(member.name).parts
            if not parts or parts[0] not in {'bin','node_modules','dist','apps','scripts','package.json'} or '..' in parts or member.name.startswith('/'):
                raise RuntimeError('Unsafe bundle path')
            if not (member.isfile() or member.isdir() or member.issym()):
                raise RuntimeError('Unsupported bundle entry')
        tar.extractall(destination, members=members, filter='data')
    for required in ['bin/node','node_modules/better-sqlite3/package.json','dist/apps/daemon/src/index.js','apps/web/dist/index.html','package.json']:
        if not (destination / required).is_file():
            raise RuntimeError('Incomplete bundle')

def atomic_link(target):
    pending = BASE / 'current.next'
    pending.unlink(missing_ok=True)
    pending.symlink_to(target)
    os.replace(pending, BASE / 'current')
    fd = os.open(BASE, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

def health(origin, release):
    from urllib.parse import urlparse
    host = urlparse(origin).netloc
    request = urllib.request.Request('http://127.0.0.1:47831/healthz', headers={'Host':host})
    for _ in range(30):
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                result = json.load(response)
                if result.get('ok') is True and result.get('release') == release: return True
        except (OSError, ValueError): pass
        time.sleep(1)
    return False

def service(action):
    subprocess.run(['/usr/bin/systemctl', action, SERVICE], check=True, timeout=20)

def activate(release, origin, user):
    current = BASE / 'current'
    old = current.resolve() if current.is_symlink() else None
    if old == release: return
    marker = DATA / 'deploying'
    snapshot = STATE / 'snapshots' / (release.name + '-' + str(time.time_ns()))
    snapshot.mkdir(parents=True, mode=0o700, exist_ok=False)
    saved = False
    marker.touch(mode=0o600)
    os.chown(marker, user.pw_uid, user.pw_gid)
    try:
        service('stop')
        if (DATA / 'data.sqlite').exists():
            source = sqlite3.connect(f'file:{DATA / "data.sqlite"}?mode=ro', uri=True)
            target = sqlite3.connect(snapshot / 'data.sqlite')
            try:
                source.backup(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise RuntimeError('Snapshot integrity failed')
            finally: target.close(); source.close()
            if (DATA / 'profiles').exists(): shutil.copytree(DATA / 'profiles', snapshot / 'profiles')
            saved = True
        atomic_link(release)
        service('start')
        if not health(origin, release.name): raise RuntimeError('New release failed health check')
    except Exception:
        service('stop')
        if saved:
            for suffix in ['', '-wal', '-shm']:
                (DATA / ('data.sqlite' + suffix)).unlink(missing_ok=True)
            shutil.copy2(snapshot / 'data.sqlite', DATA / 'data.sqlite')
            os.chown(DATA / 'data.sqlite', user.pw_uid, user.pw_gid)
            os.chmod(DATA / 'data.sqlite', 0o600)
            if (snapshot / 'profiles').exists():
                shutil.rmtree(DATA / 'profiles', ignore_errors=True)
                shutil.copytree(snapshot / 'profiles', DATA / 'profiles')
                for path in (DATA / 'profiles').rglob('*'): os.chown(path, user.pw_uid, user.pw_gid)
                os.chown(DATA / 'profiles', user.pw_uid, user.pw_gid)
        if old:
            atomic_link(old)
            service('start')
            if not health(origin, old.name): raise RuntimeError('Rollback failed; maintenance retained')
        else:
            current.unlink(missing_ok=True)
            # First boot failure: retain its data for investigation, never auto-delete it.
        marker.unlink(missing_ok=True)
        raise
    marker.unlink(missing_ok=True)
    protected = {path for path in [release, old] if path is not None}
    releases = sorted((path for path in (BASE/'releases').iterdir() if re.fullmatch(r'[a-f0-9]{40}',path.name) and not path.is_symlink()), key=lambda p:p.stat().st_mtime, reverse=True)
    keep = protected | set([path for path in releases if path not in protected][:max(0,3-len(protected))])
    for path in releases:
        if path not in keep: shutil.rmtree(path)
    snapshots = sorted((STATE/'snapshots').iterdir(), key=lambda p:p.stat().st_mtime, reverse=True)
    for path in snapshots[3:]:
        if re.fullmatch(r'[a-f0-9]{40}-[0-9]{15,20}',path.name) and not path.is_symlink(): shutil.rmtree(path)

def main():
    if os.geteuid() != 0 or len(sys.argv) != 1: raise RuntimeError('Root forced command only')
    STATE.mkdir(mode=0o700,exist_ok=True)
    with (STATE/'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        header = sys.stdin.buffer.readline(100).decode('ascii').strip()
        match = re.fullmatch(r'([a-f0-9]{40}) ([a-f0-9]{64})',header)
        if not match: raise RuntimeError('Invalid bundle header')
        sha, expected = match.groups()
        origin = pathlib.Path('/etc/stream-panel/public-origin').read_text().strip()
        user = pwd.getpwnam('stream-panel')
        (BASE/'releases').mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='incoming-',dir=STATE) as temp:
            temp = pathlib.Path(temp); archive=temp/'bundle.tar.gz'; digest=hashlib.sha256(); size=0
            with archive.open('wb') as output:
                while chunk := sys.stdin.buffer.read(1024*1024):
                    size += len(chunk)
                    if size > MAX_ARCHIVE: raise RuntimeError('Archive size limit')
                    digest.update(chunk);output.write(chunk)
                output.flush();os.fsync(output.fileno())
            if digest.hexdigest() != expected: raise RuntimeError('Bundle checksum mismatch')
            release = BASE/'releases'/sha
            if release.exists():
                if (release/'.bundle-sha256').read_text().strip() != expected: raise RuntimeError('Existing release differs')
            else:
                unpack(archive,temp/'unpacked')
                # Bundle is immutable to service and SSH deployment users.
                (temp/'unpacked'/'.bundle-sha256').write_text(expected)
                for path in (temp/'unpacked').rglob('*'):
                    if not path.is_symlink(): os.chmod(path, 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
                os.chmod(temp/'unpacked',0o755)
                os.rename(temp/'unpacked',release)
            subprocess.run(['/usr/sbin/runuser','-u','stream-panel','--',str(release/'bin/node'),'-e',"new (require('better-sqlite3'))(':memory:').close()"],cwd=release,check=True,timeout=15,stdout=subprocess.DEVNULL)
            activate(release,origin,user)
        print('Stream Panel release healthy: '+sha)
if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Deployment failed: '+type(error).__name__,file=sys.stderr)
        sys.exit(1)
