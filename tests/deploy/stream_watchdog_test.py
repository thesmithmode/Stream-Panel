import importlib.util, json, pathlib, sqlite3, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('watchdog',pathlib.Path(__file__).resolve().parents[2]/'ops/stream-watchdog.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
NOW=1_800_000_000_000
MIN=60000
def snapshot(live_at=None,heartbeat_at=NOW-30000,running=True,profile='ruslan',panel=False):
 return {'live':live_at is not None,'panelActive':panel,'profiles':{profile:{'live':[] if live_at is None else [{'platform':'twitch','observedAt':live_at}],'heartbeat':None if heartbeat_at is None else {'at':heartbeat_at,'running':running}}}}
class WatchdogTests(unittest.TestCase):
 def setUp(self):
  self.folder=tempfile.TemporaryDirectory();root=pathlib.Path(self.folder.name)
  self.data=root/'data';self.data.mkdir();self.state=root/'watchdog'/'state.json'
  self.patch=patch.multiple(w,DATA=self.data,STATE=self.state);self.patch.start()
  self.restarts=[]
 def tearDown(self):self.patch.stop();self.folder.cleanup()
 def run_once(self,snap,now=NOW,healthy=True,started=NOW-60*MIN):
  reader=(lambda _now:snap) if not isinstance(snap,Exception) else (lambda _now:(_ for _ in ()).throw(snap))
  with patch.object(w.subprocess,'run'):
   return w.run(now=now,read=reader,health=lambda:healthy,started=lambda:started,restart=lambda:self.restarts.append(now))
 def test_live_stream_is_checked_every_tick_and_healthy_does_not_restart(self):
  for tick in range(3):self.assertEqual(self.run_once(snapshot(live_at=NOW+tick*5*MIN-MIN,heartbeat_at=NOW+tick*5*MIN-10000),now=NOW+tick*5*MIN),'ok')
  self.assertEqual(self.restarts,[])
 def test_off_stream_checks_only_every_six_hours(self):
  self.assertEqual(self.run_once(snapshot()),'ok')
  self.assertEqual(self.run_once(snapshot(heartbeat_at=None),now=NOW+5*MIN),'skip')
  self.assertEqual(self.run_once(snapshot(heartbeat_at=NOW+6*60*MIN-1000),now=NOW+6*60*MIN),'ok')
  self.assertEqual(self.restarts,[])
 def test_panel_in_use_checks_every_fifteen_minutes(self):
  self.assertEqual(self.run_once(snapshot(panel=True)),'ok')
  self.assertEqual(self.run_once(snapshot(panel=True),now=NOW+10*MIN,healthy=False),'skip')
  self.assertEqual(self.run_once(snapshot(panel=True),now=NOW+15*MIN,healthy=False),'restart')
  self.assertEqual(self.run_once(snapshot(panel=False,heartbeat_at=NOW+30*MIN-1000),now=NOW+30*MIN),'skip')
  self.assertEqual(self.restarts,[NOW+15*MIN])
 def test_failed_health_during_stream_restarts_within_one_tick(self):
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN),healthy=False),'restart')
  self.assertEqual(self.restarts,[NOW])
 def test_alive_but_not_collecting_restarts(self):
  self.assertEqual(self.run_once(snapshot(live_at=NOW-5*MIN)),'restart')
  self.run_once(snapshot(live_at=NOW-MIN,heartbeat_at=NOW-3*MIN),now=NOW+16*MIN)
  self.assertEqual(self.restarts,[NOW,NOW+16*MIN])
 def test_stopped_collectors_and_inactive_service_restart(self):
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN,running=False)),'restart')
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN),now=NOW+20*MIN,started=None),'restart')
 def test_restart_loops_are_bounded_by_cooldown(self):
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN),healthy=False),'restart')
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN),now=NOW+5*MIN,healthy=False,started=NOW-10*MIN),'cooldown')
  self.assertEqual(self.run_once(snapshot(live_at=NOW-MIN),now=NOW+15*MIN,healthy=False,started=NOW-10*MIN),'restart')
  self.assertEqual(len(self.restarts),2)
 def test_startup_grace_and_maintenance_never_restart(self):
  self.assertEqual(self.run_once(snapshot(live_at=NOW-10*MIN),healthy=False,started=NOW-MIN),'starting')
  for marker in w.MARKERS:
   (self.data/marker).touch()
   self.assertEqual(self.run_once(snapshot(live_at=NOW-10*MIN),healthy=False),'maintenance')
   (self.data/marker).unlink()
  self.assertEqual(self.restarts,[])
 def test_unreadable_snapshot_is_treated_as_live_and_relies_on_health(self):
  self.assertEqual(self.run_once(RuntimeError('busy')),'ok')
  self.assertEqual(self.run_once(RuntimeError('busy'),now=NOW+5*MIN,healthy=False),'restart')
 def test_state_survives_corruption(self):
  self.state.parent.mkdir();self.state.write_text('{broken')
  self.assertEqual(self.run_once(snapshot()),'ok')
  self.assertEqual(json.loads(self.state.read_text())['lastCheckAt'],NOW)
 def test_snapshot_reads_profile_tables_read_only(self):
  path=self.data/'data.sqlite';db=sqlite3.connect(path)
  db.executescript('''CREATE TABLE sp_profile_schema(profile TEXT PRIMARY KEY,version INTEGER NOT NULL);
   INSERT INTO sp_profile_schema VALUES('ruslan',9),('gulnaz',9),('Bad-Name',1);
   CREATE TABLE p_ruslan_platform_streams(platform TEXT,account_id TEXT,external_id TEXT,session_id TEXT,started_at_ms INTEGER,ended_at_ms INTEGER,last_observed_at_ms INTEGER);
   CREATE TABLE p_ruslan_collector_state(id INTEGER PRIMARY KEY,last_seen_ms INTEGER,running INTEGER);
   CREATE TABLE p_gulnaz_collector_state(id INTEGER PRIMARY KEY,last_seen_ms INTEGER,running INTEGER);''')
  self.assertFalse(w.read_snapshot(path,NOW)['panelActive'])
  db.execute('CREATE TABLE sp_panel_activity(id INTEGER PRIMARY KEY,last_seen_ms INTEGER NOT NULL)')
  db.execute('INSERT INTO sp_panel_activity VALUES(1,?)',(NOW-21*MIN,));db.commit()
  self.assertFalse(w.read_snapshot(path,NOW)['panelActive'])
  db.execute('UPDATE sp_panel_activity SET last_seen_ms=?',(NOW-19*MIN,));db.commit()
  self.assertTrue(w.read_snapshot(path,NOW)['panelActive'])
  db.execute("INSERT INTO p_ruslan_platform_streams VALUES('twitch','a','1','s',0,NULL,?)",(NOW-MIN,))
  db.execute("INSERT INTO p_ruslan_platform_streams VALUES('youtube','a','2','s',0,NULL,?)",(NOW-13*60*MIN,))
  db.execute("INSERT INTO p_ruslan_platform_streams VALUES('twitch','a','3','s',0,?,?)",(NOW,NOW))
  db.execute('INSERT INTO p_ruslan_collector_state VALUES(1,?,1)',(NOW-10000,))
  db.execute('INSERT INTO p_gulnaz_collector_state VALUES(1,?,0)',(NOW-10000,));db.commit();db.close()
  result=w.read_snapshot(path,NOW)
  self.assertTrue(result['live'])
  self.assertEqual(sorted(result['profiles']),['gulnaz','ruslan'])
  self.assertEqual(result['profiles']['ruslan']['live'],[{'platform':'twitch','observedAt':NOW-MIN}])
  self.assertEqual(result['profiles']['gulnaz'],{'live':[],'heartbeat':{'at':NOW-10000,'running':False}})
  self.assertEqual(w.problems(result,NOW,NOW-60*MIN),['gulnaz:heartbeat_stale'])
  with self.assertRaises(sqlite3.OperationalError):
   ro=sqlite3.connect(f'file:{path}?mode=ro',uri=True);ro.execute('DELETE FROM sp_profile_schema')
 def test_health_url_uses_configured_private_bind_host(self):
  config=pathlib.Path(self.folder.name)/'etc';config.mkdir()
  (config/'public-origin').write_text('https://panel.example.test\n')
  with patch.object(w,'CONFIG',config):
   self.assertEqual(w.health_url(),('http://127.0.0.1:47831/healthz','panel.example.test'))
   (config/'bind-host').write_text('172.21.0.1\n')
   self.assertEqual(w.health_url()[0],'http://172.21.0.1:47831/healthz')
   (config/'bind-host').write_text('8.8.8.8')
   with self.assertRaises(RuntimeError):w.health_url()
   self.assertFalse(w.check_health())
if __name__=='__main__':unittest.main()
