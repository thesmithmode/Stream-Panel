#!/usr/bin/env python3
"""Enable this project's existing private Storage through a CI payload; never print keys."""
import os,sys,tempfile
from pathlib import Path
from urllib.parse import urlsplit
def configure(payload,config):
    url=(payload/'supabase-url').read_text().strip()
    key=(payload/'supabase-key').read_text().strip()
    parsed=urlsplit(url)
    if url!='https://eyverhyrhibwyiipgozn.supabase.co' or parsed.scheme!='https' or not key or len(key)>8192 or '\n' in key or '\r' in key:
        raise SystemExit('Invalid Stream Panel cloud configuration')
    if not config.is_dir() or config.is_symlink() or not (config/'server.env').is_file() or (config/'server.env').is_symlink():
        raise SystemExit('Existing Stream Panel installation required')
    import grp
    existing=config.joinpath('server.env').read_text()
    configured=next((line.split('=',1)[1].strip().strip('\"').strip("'") for line in existing.splitlines() if line.startswith('STREAM_PANEL_SUPABASE_URL=')),'')
    if configured and configured!=url:raise SystemExit('Different project already configured')
    service_group=grp.getgrnam('stream-panel').gr_gid
    key_target=config/'supabase-key'
    if key_target.is_symlink():raise SystemExit('Unsafe secret path')
    fd,temporary=tempfile.mkstemp(prefix='.supabase-key-',dir=config)
    try:
        with os.fdopen(fd,'w') as target:
            target.write(key);target.flush();os.fsync(target.fileno());os.fchmod(target.fileno(),0o640);os.fchown(target.fileno(),0,service_group)
        os.replace(temporary,key_target)
    finally:
        Path(temporary).unlink(missing_ok=True)
    path=config/'server.env'
    lines=[line for line in path.read_text().splitlines() if not line.startswith(('STREAM_PANEL_SUPABASE_URL=','STREAM_PANEL_SUPABASE_KEY_FILE='))]
    lines+=['STREAM_PANEL_SUPABASE_URL='+url,'STREAM_PANEL_SUPABASE_KEY_FILE='+str(key_target)]
    fd,temporary=tempfile.mkstemp(prefix='.server-env-',dir=config)
    try:
        with os.fdopen(fd,'w') as target:
            target.write('\n'.join(lines)+'\n');target.flush();os.fsync(target.fileno());os.fchmod(target.fileno(),0o640);os.fchown(target.fileno(),0,service_group)
        os.replace(temporary,path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print('Stream Panel cloud settings enabled; existing encryption key preserved')
if __name__=='__main__':
    configure(Path(sys.argv[1]),Path('/etc/stream-panel'))
