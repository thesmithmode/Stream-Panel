"""Read-only investigation of the account group explicitly reported by its owner."""
import json, sqlite3, unicodedata
from pathlib import Path

config = {}
for line in Path('/etc/stream-panel/server.env').read_text().splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        config[key] = value.strip().strip('"').strip("'")
path = Path(config.get('STREAM_PANEL_DATA_DIR', '/var/lib/stream-panel')) / 'data.sqlite'
db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
terms = {'chikist007', 'egorbarinov6515', 'егор4ик', 'egor4ik', 'егорчик', 'егор баринов'}
def matches(value):
    return unicodedata.normalize('NFKC', value).strip().lower().lstrip('@#') in terms
for profile in ('ruslan', 'gulnaz'):
    p = 'p_' + profile + '_'
    identities = [dict(r) for r in db.execute(f"SELECT id,person_id,source,external_id,display_name,account_id FROM {p}identities UNION ALL SELECT id,person_id,'youtube',external_id,display_name,account_id FROM {p}youtube_identities")]
    people = {r['id']: dict(r) for r in db.execute(f'SELECT * FROM {p}persons')}
    selected = {r['person_id'] for r in identities if matches(r['display_name'])}
    selected.update(r['id'] for r in people.values() if matches(r['display_name']))
    print('people=' + json.dumps({'profile': profile, 'rows': [people[x] for x in sorted(selected)]}, ensure_ascii=False))
    rows = []
    for row in identities:
        if row['person_id'] not in selected:
            continue
        account = row.pop('account_id')
        row['kind'] = 'correction' if account.startswith('correction:') else 'manual' if account.startswith('manual:') else 'provider'
        row['events'] = db.execute(f'SELECT count(*) FROM {p}events WHERE identity_id=?', (row['id'],)).fetchone()[0]
        row['corrections'] = db.execute(f'SELECT count(*) FROM {p}donation_corrections WHERE identity_id=?', (row['id'],)).fetchone()[0]
        rows.append(row)
    print('accounts=' + json.dumps({'profile': profile, 'rows': rows}, ensure_ascii=False))
    for person in sorted(selected):
        bindings = [dict(r) for r in db.execute(f'SELECT name_key,person_id,identity_id FROM {p}donor_bindings WHERE person_id=?', (person,))]
        merges = [dict(r) for r in db.execute(f'SELECT source_person_id,target_person_id,undone_at_ms FROM {p}person_merges WHERE source_person_id=? OR target_person_id=?', (person, person))]
        print('links=' + json.dumps({'profile': profile, 'person': person, 'bindings': bindings, 'merges': merges}, ensure_ascii=False))
db.close()
