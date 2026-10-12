#!/usr/bin/env python3
"""Read-only DA transport and attribution diagnostics; never print provider data or secrets."""
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
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
        bounds = db.execute(f"SELECT min(started_at_ms),max(coalesce(ended_at_ms,started_at_ms)),count(*) FROM p_{profile}_sessions s WHERE NOT EXISTS(SELECT 1 FROM p_{profile}_session_tombstones t WHERE t.session_id=s.id)").fetchone()
        rows = db.execute(f"SELECT e.occurred_at_ms,c.occurred_at_ms,c.event_id,c.payload_json FROM {table} e LEFT JOIN p_{profile}_donation_corrections c ON c.event_id=e.id WHERE e.source='donationalerts' AND e.type='donation'").fetchall()
        facts = {'streams':bounds[2],'beforeRecordedHistory':0,'afterRecordedHistory':0,'withinHistoryBounds':0,'manualEditsWithEmptyTime':0,'emptyTimeUpdatesPreservedUnknown':0,'explicitTimeClears':0}
        for original,corrected,event_id,payload in rows:
            if original is not None and bounds[0] is not None:
                facts['beforeRecordedHistory' if original<bounds[0] else 'afterRecordedHistory' if original>bounds[1] else 'withinHistoryBounds']+=1
            if event_id and corrected is None and json.loads(payload or '{}').get('corrected'):
                facts['manualEditsWithEmptyTime']+=1
                audit=db.execute(f"SELECT before_json,after_json FROM p_{profile}_donation_audit WHERE event_id=? AND kind='update' ORDER BY revision DESC LIMIT 1",(event_id,)).fetchone()
                if audit and json.loads(audit[1]).get('occurredAtMs') is None:
                    facts['emptyTimeUpdatesPreservedUnknown' if json.loads(audit[0]).get('occurredAtMs') is None else 'explicitTimeClears']+=1
        print('da attribution_facts='+json.dumps(facts,sort_keys=True))
        if profile == 'gulnaz':
            streams=db.execute(f"SELECT started_at_ms,ended_at_ms FROM p_{profile}_sessions s WHERE NOT EXISTS(SELECT 1 FROM p_{profile}_session_tombstones t WHERE t.session_id=s.id)").fetchall()
            def parsed(raw,offset):
                if not isinstance(raw,str):return None
                try:
                    stamp=datetime.fromisoformat(raw.replace('Z','+00:00'))
                    return int(stamp.timestamp()*1000) if stamp.tzinfo else int(stamp.replace(tzinfo=timezone.utc).timestamp()*1000)-offset*60000
                except ValueError:return None
            def fits(at):
                return at is not None and any(start<=at and (end is None or at<end) for start,end in streams)
            target=db.execute(f"SELECT e.source_time,e.payload_json,e.occurred_at_ms,(SELECT count(*) FROM p_{profile}_event_sessions es WHERE es.event_id=e.id) FROM {table} e WHERE e.source='donationalerts' AND e.type='donation' AND json_extract(e.payload_json,'$.amountMinor')='22800' AND json_extract(e.payload_json,'$.currency')='RUB'").fetchall()
            report={'matchingPayments':len(target),'linkedPayments':sum(links>0 for raw,payload,stored,links in target),'createdFitsByOffset':{},'shownFitsByOffset':{},'hasShownTime':0,'rawSourceMatchesStoredCreated':0}
            for raw,payload,stored,links in target:
                original=json.loads(payload).get('raw',{})
                if original.get('shown_at'):report['hasShownTime']+=1
                if original.get('created_at')==raw:report['rawSourceMatchesStoredCreated']+=1
            for offset in [180,0,-180]:
                report['createdFitsByOffset'][str(offset)]=sum(fits(parsed(raw,offset)) for raw,payload,stored,links in target)
                report['shownFitsByOffset'][str(offset)]=sum(fits(parsed(json.loads(payload).get('raw',{}).get('shown_at'),offset)) for raw,payload,stored,links in target)
            print('da selected_payment_time_comparison='+json.dumps(report,sort_keys=True))
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
