#!/usr/bin/python3
"""Root-owned liveness watchdog. Every 5 minutes while a stream is live, every 6 hours otherwise.

Restarts stream-panel.service when /healthz fails or collectors stop advancing their
heartbeat or live-stream observations. Database reads run as the service user, read-only.
"""
import fcntl, ipaddress, json, os, pathlib, re, sqlite3, subprocess, sys, time, urllib.request
DATA = pathlib.Path('/var/lib/stream-panel')
DEPLOY_LOCK = pathlib.Path('/var/lib/stream-panel-deploy/deploy.lock')
STATE = pathlib.Path('/var/lib/stream-panel-watchdog/state.json')
CONFIG = pathlib.Path('/etc/stream-panel')
SERVICE = 'stream-panel.service'
MARKERS = ('deploying', 'initializing', 'restoring', 'restore-pending')
OFF_STREAM_INTERVAL_MS = 6 * 3600000
LIVE_WINDOW_MS = 12 * 3600000        # Older open rows are stale history, not a live stream.
OBSERVATION_STALE_MS = 4 * 60000     # Live polls advance every 60 s.
HEARTBEAT_STALE_MS = 2 * 60000       # Collector heartbeat advances every 30 s.
STARTUP_GRACE_MS = 3 * 60000
RESTART_COOLDOWN_MS = 15 * 60000     # Bounds restart loops when a provider itself is down.

def read_snapshot(path, now):
    """Return {'live': bool, 'profiles': {...}} from the profile tables; never writes."""
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
    try:
        profiles = [row[0] for row in db.execute('SELECT profile FROM sp_profile_schema ORDER BY profile')]
        result = {'live': False, 'profiles': {}}
        for profile in profiles:
            if not re.fullmatch(r'[a-z][a-z0-9_]{0,31}', profile): continue
            prefix = f'p_{profile}_'
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?)", (prefix + 'platform_streams', prefix + 'collector_state'))}
            streams = [] if prefix + 'platform_streams' not in tables else db.execute(
                f'SELECT platform,last_observed_at_ms FROM {prefix}platform_streams WHERE ended_at_ms IS NULL AND last_observed_at_ms>=?',
                (now - LIVE_WINDOW_MS,)).fetchall()
            heartbeat = None if prefix + 'collector_state' not in tables else db.execute(
                f'SELECT last_seen_ms,running FROM {prefix}collector_state WHERE id=1').fetchone()
            result['profiles'][profile] = {
                'live': [{'platform': p, 'observedAt': at} for p, at in streams],
                'heartbeat': None if heartbeat is None else {'at': heartbeat[0], 'running': bool(heartbeat[1])},
            }
            result['live'] = result['live'] or bool(streams)
        return result
    finally: db.close()

def problems(snapshot, now, service_started_at):
    """Collection problems; empty list means healthy. Startup grace avoids restart loops."""
    found = []
    if now - service_started_at < STARTUP_GRACE_MS: return found
    for profile, info in sorted(snapshot['profiles'].items()):
        heartbeat = info['heartbeat']
        if heartbeat is None or not heartbeat['running'] or now - heartbeat['at'] > HEARTBEAT_STALE_MS:
            found.append(f'{profile}:heartbeat_stale')
        for stream in info['live']:
            if now - stream['observedAt'] > OBSERVATION_STALE_MS:
                found.append(f"{profile}:{stream['platform']}_observation_stale")
    return found

def due(state, live, now):
    return live or now - state.get('lastCheckAt', 0) >= OFF_STREAM_INTERVAL_MS

def decide(state, now, live, healthy, issues):
    """Return (action, new_state). Action is skip, ok, restart or cooldown."""
    if not due(state, live, now): return 'skip', state
    state = {**state, 'lastCheckAt': now}
    if healthy and not issues: return 'ok', state
    if now - state.get('lastRestartAt', -RESTART_COOLDOWN_MS) < RESTART_COOLDOWN_MS: return 'cooldown', state
    return 'restart', {**state, 'lastRestartAt': now}

def health_url():
    try: configured = (CONFIG / 'bind-host').read_text().strip() or '127.0.0.1'
    except FileNotFoundError: configured = '127.0.0.1'
    address = ipaddress.ip_address(configured)
    if not isinstance(address, ipaddress.IPv4Address) or not (address.is_loopback or address.is_private):
        raise RuntimeError('Invalid configured health host')
    origin = (CONFIG / 'public-origin').read_text().strip()
    return f'http://{address}:47831/healthz', re.sub(r'^https?://', '', origin).split('/')[0]

def check_health():
    try:
        url, host = health_url()
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Host': host}), timeout=10) as response:
            return json.load(response).get('ok') is True
    except Exception: return False

def service_started_at():
    """Monotonic-free wall time of last activation; 0 when inactive."""
    out = subprocess.run(['/usr/bin/systemctl', 'show', SERVICE, '-p', 'ActiveState', '-p', 'ActiveEnterTimestampMonotonic'], capture_output=True, text=True, timeout=10).stdout
    values = dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
    if values.get('ActiveState') != 'active': return None
    entered_us = int(values.get('ActiveEnterTimestampMonotonic') or 0)
    return int(time.time() * 1000 - (time.monotonic() * 1e6 - entered_us) / 1000)

def snapshot_as_service(now):
    """Read SQLite as the service user so root never creates WAL/SHM files."""
    out = subprocess.run(['/usr/sbin/runuser', '-u', 'stream-panel', '--', sys.executable, __file__, '--snapshot', str(now)],
        capture_output=True, text=True, timeout=30)
    if out.returncode != 0: raise RuntimeError('Snapshot unavailable')
    return json.loads(out.stdout)

def load_state():
    try: return json.loads(STATE.read_text())
    except (FileNotFoundError, ValueError): return {}

def save_state(state):
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATE.with_suffix('.next')
    temporary.write_text(json.dumps(state)); os.replace(temporary, STATE)

def run(now=None, read=snapshot_as_service, health=check_health, started=service_started_at, restart=None):
    now = int(time.time() * 1000) if now is None else now
    if any((DATA / marker).exists() for marker in MARKERS): return 'maintenance'
    restart = restart or (lambda: subprocess.run(['/usr/bin/systemctl', 'restart', SERVICE], check=True, timeout=60))
    state = load_state()
    try: snapshot = read(now)
    except Exception: snapshot = None
    live = True if snapshot is None else snapshot['live']  # Unknown state is checked, not skipped.
    if not due(state, live, now): return 'skip'
    began = started()
    if began is not None and now - began < STARTUP_GRACE_MS: return 'starting'  # Recheck on next tick.
    healthy = began is not None and health()
    # An unreadable snapshot (e.g. busy during backup) alone never restarts; /healthz covers the DB.
    issues = [] if snapshot is None or began is None else problems(snapshot, now, began)
    action, state = decide(state, now, live, healthy, issues)
    detail = ','.join(issues) or ('ok' if healthy else 'health_failed')
    print(f"stream-watchdog live={str(live).lower()} action={action} detail={detail}")
    if action == 'restart':
        save_state(state)
        subprocess.run(['/usr/bin/systemctl', 'reset-failed', SERVICE], timeout=10)
        restart()
    elif action != 'skip': save_state(state)
    return action

def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--snapshot':
        print(json.dumps(read_snapshot(DATA / 'data.sqlite', int(sys.argv[2])))); return
    if os.geteuid() != 0 or len(sys.argv) != 1: raise SystemExit('Root timer only')
    DEPLOY_LOCK.parent.mkdir(mode=0o700, exist_ok=True)
    with DEPLOY_LOCK.open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: print('stream-watchdog action=deploying'); return
        run()

if __name__ == '__main__': main()
