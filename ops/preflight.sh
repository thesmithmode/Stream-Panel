#!/bin/bash
set -euo pipefail
# Read-only inventory, no provider secrets or other application configurations.
test "$(uname -m)" = x86_64 || { echo 'Unsupported architecture'; exit 1; }
command -v systemctl >/dev/null
python3 - <<'PY'
import os,shutil,tarfile
print('Available memory MiB:',int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemAvailable:'))) // 1024)
print('Available /opt GiB:',round(shutil.disk_usage('/opt').free/2**30,2))
if int(next(x.split()[1] for x in open('/proc/meminfo') if x.startswith('MemAvailable:'))) < 640*1024: raise SystemExit('Need >=640 MiB currently available memory')
if shutil.disk_usage('/opt').free < 3*2**30: raise SystemExit('Need >=3 GiB free for releases and rollback')
if not hasattr(tarfile,'data_filter'): raise SystemExit('Python tar security update required')
PY
if ss -H -ltn '( sport = :80 or sport = :443 or sport = :47831 )' | grep -q .; then
  echo 'Required port occupied; configure existing reverse proxy instead of replacing it.'; exit 1
fi
printf 'OS: '; . /etc/os-release; printf '%s\n' "$PRETTY_NAME"
getconf GNU_LIBC_VERSION
