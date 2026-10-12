#!/usr/bin/env python3
"""Read-only DA transport and attribution diagnostics; never print provider data or secrets."""
import json
import sqlite3
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

root = Path('/var/lib/stream-panel')
db = sqlite3.connect(f'file:{root / "data.sqlite"}?mode=ro', uri=True)
for profile in ('ruslan', 'gulnaz'):
    path = root / 'profiles' / profile / 'secrets.json'
    config = json.loads(path.read_text()) if path.exists() else {}
    token = config.get('daAccessToken', '')
    print(f'da profile={profile} token_present={bool(token)} utc_offset={config.get("daUtcOffsetMinutes")}')
    table = f'p_{profile}_events'
    if db.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone():
        row = db.execute(f"SELECT count(*),sum(occurred_at_ms IS NULL),sum(EXISTS(SELECT 1 FROM p_{profile}_event_sessions es WHERE es.event_id=e.id)) FROM {table} e WHERE source='donationalerts' AND type='donation'").fetchone()
        print(f'da stored={row[0]} untimed={row[1] or 0} linked_to_stream={row[2] or 0}')
    if not token:
        continue
    for endpoint in ('user/oauth', 'alerts/donations?page=1'):
        try:
            request = Request('https://www.donationalerts.com/api/v1/' + endpoint, headers={'Authorization': 'Bearer ' + token})
            with urlopen(request, timeout=15) as response:
                data = json.loads(response.read(1024 * 1024))
            resource = data.get('data')
            if endpoint == 'user/oauth':
                print(f'da profile_http=200 socket_token_present={bool(resource.get("socket_connection_token"))}')
            else:
                print(f'da history_http=200 first_page_rows={len(resource)} provider_total={data.get("meta", {}).get("total")}')
        except HTTPError as error:
            print(f'da endpoint={endpoint.split("?")[0]} http={error.code}')
        except Exception as error:
            print(f'da endpoint={endpoint.split("?")[0]} error_type={type(error).__name__}')
db.close()
