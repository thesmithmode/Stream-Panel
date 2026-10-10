import importlib.util, io, os, pathlib, pwd, sqlite3, tarfile, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('receiver',pathlib.Path(__file__).resolve().parents[2]/'ops/receive.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class ReceiverTests(unittest.TestCase):
 def test_failed_release_cleanup_preserves_current_and_unrelated_objects_and_bounds_snapshots(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data,state/'snapshots']:path.mkdir(parents=True)
   old=base/'releases'/('a'*40);failed=base/'releases'/('b'*40)
   old.mkdir();failed.mkdir();(base/'current').symlink_to(old)
   other=state/'snapshots'/'unrelated';other.mkdir();(other/'keep').write_text('keep')
   for index in range(6):
    snap=state/'snapshots'/('b'*40+'-'+str(1700000000000000+index));snap.mkdir();(snap/'data.sqlite').write_text('snapshot')
   with patch.multiple(r,BASE=base,DATA=data,STATE=state):
    r.discard_failed_release(failed)
    r.discard_failed_release(old)
   self.assertFalse(failed.exists());self.assertTrue(old.exists())
   self.assertEqual((other/'keep').read_text(),'keep')
   self.assertEqual(len([p for p in (state/'snapshots').iterdir() if p.name.startswith('b'*40)]),3)
 def test_failed_rollback_retains_release_and_snapshot_evidence(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data,state/'snapshots']:path.mkdir(parents=True)
   failed=base/'releases'/('b'*40);failed.mkdir();(data/'deploying').touch()
   snapshot=state/'snapshots'/('b'*40+'-1700000000000000');snapshot.mkdir()
   with patch.multiple(r,BASE=base,DATA=data,STATE=state):r.discard_failed_release(failed)
   self.assertTrue(failed.exists());self.assertTrue(snapshot.exists());self.assertTrue((data/'deploying').exists())
 def test_repeated_active_release_requires_real_health_and_does_not_restart_or_snapshot(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data,state]:path.mkdir(parents=True)
   release=base/'releases'/('a'*40);release.mkdir();(base/'current').symlink_to(release)
   with patch.multiple(r,BASE=base,DATA=data,STATE=state),patch.object(r,'service') as action,patch.object(r,'health',return_value=True) as health:
    r.activate(release,'https://panel.test',pwd.getpwuid(os.getuid()))
    health.assert_called_once_with('https://panel.test',release.name);action.assert_not_called()
   with patch.multiple(r,BASE=base,DATA=data,STATE=state),patch.object(r,'health',return_value=False):
    with self.assertRaisesRegex(RuntimeError,'Active release'):r.activate(release,'https://panel.test',pwd.getpwuid(os.getuid()))
   self.assertEqual((base/'current').resolve(),release);self.assertFalse((state/'snapshots').exists())
 def test_health_defaults_to_loopback_when_bind_host_file_is_absent(self):
  with tempfile.TemporaryDirectory() as folder:
   missing=pathlib.Path(folder)/'bind-host';requests=[]
   def healthy(request,timeout):
    requests.append(request)
    return io.BytesIO(b'{"ok":true,"release":"release"}')
   with patch.object(r,'BIND_HOST_FILE',missing),patch.object(r.urllib.request,'urlopen',side_effect=healthy):
    self.assertTrue(r.health('https://panel.example.test','release'))
   self.assertEqual(requests[0].full_url,'http://127.0.0.1:47831/healthz')
   self.assertEqual(requests[0].get_header('Host'),'panel.example.test')
 def test_health_uses_validated_bridge_host_and_preserves_public_host_header(self):
  with tempfile.TemporaryDirectory() as folder:
   bind_host=pathlib.Path(folder)/'bind-host';bind_host.write_text('172.21.0.1');requests=[]
   def healthy(request,timeout):
    requests.append(request)
    return io.BytesIO(b'{"ok":true,"release":"release"}')
   with patch.object(r,'BIND_HOST_FILE',bind_host),patch.object(r.urllib.request,'urlopen',side_effect=healthy):
    self.assertTrue(r.health('https://panel.example.test','release'))
   self.assertEqual(requests[0].full_url,'http://172.21.0.1:47831/healthz')
   self.assertEqual(requests[0].get_header('Host'),'panel.example.test')
 def test_health_rejects_untrusted_or_multiline_bind_host_before_request(self):
  with tempfile.TemporaryDirectory() as folder:
   bind_host=pathlib.Path(folder)/'bind-host'
   for value in ['0.0.0.0','8.8.8.8','invalid','172.21.0.1\n127.0.0.1','172.21.0.1\n']:
    bind_host.write_text(value)
    with patch.object(r,'BIND_HOST_FILE',bind_host),patch.object(r.urllib.request,'urlopen',side_effect=AssertionError('request must not be made')):
     with self.assertRaisesRegex(RuntimeError,'Invalid configured health host'):
      r.health('https://panel.example.test','release')
 def test_archive_rejects_escape_links_devices_and_oversize(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder)
   for name,link in [('../escape',''),('/etc/passwd',''),('bin/evil','/etc'),('node_modules/escape','../../../etc')]:
    archive=root/'bundle.tar.gz'
    with tarfile.open(archive,'w:gz') as tar:
     entry=tarfile.TarInfo(name);entry.type=tarfile.SYMTYPE if link else tarfile.REGTYPE;entry.linkname=link;tar.addfile(entry)
    with self.assertRaises((RuntimeError,tarfile.FilterError)):r.unpack(archive,root/'out')
   with tarfile.open(root/'bundle.tar.gz','w:gz') as tar:
    entry=tarfile.TarInfo('bin/dev');entry.type=tarfile.CHRTYPE;tar.addfile(entry)
   with self.assertRaises(RuntimeError):r.unpack(root/'bundle.tar.gz',root/'out')
   self.assertFalse((root.parent/'escape').exists())
 def test_valid_archive_keeps_relative_dependency_links(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder); archive=root/'bundle.tar.gz'
   with tarfile.open(archive,'w:gz') as tar:
    for name in ['bin/node','node_modules/.pnpm/sqlite/package.json','dist/apps/daemon/src/index.js','apps/web/dist/index.html','package.json']:
     entry=tarfile.TarInfo(name);entry.size=2;tar.addfile(entry,io.BytesIO(b'{}'))
    entry=tarfile.TarInfo('node_modules/better-sqlite3');entry.type=tarfile.SYMTYPE;entry.linkname='.pnpm/sqlite';tar.addfile(entry)
   r.unpack(archive,root/'out');self.assertTrue((root/'out/node_modules/better-sqlite3/package.json').is_file())
 def test_failed_health_restores_database_secrets_and_previous_release(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data/'profiles'/'ruslan',state]:path.mkdir(parents=True)
   old=base/'releases'/('a'*40);new=base/'releases'/('b'*40);old.mkdir();new.mkdir();(base/'current').symlink_to(old)
   db=sqlite3.connect(data/'data.sqlite');db.execute('create table important(value text)');db.execute("insert into important values ('original')");db.commit();db.close()
   secrets=data/'profiles'/'ruslan'/'secrets.json';secrets.write_text('original secret')
   actions=[]
   def service(action):
    actions.append(action)
    if action=='start' and (base/'current').resolve()==new:
     self.assertTrue((data/'deploying').exists())
     db=sqlite3.connect(data/'data.sqlite');db.execute('alter table important add column new_version integer');db.execute("update important set value='broken upgrade'");db.commit();db.close();secrets.write_text('changed secret')
   with patch.multiple(r,BASE=base,DATA=data,STATE=state),patch.object(r,'service',side_effect=service),patch.object(r,'health',side_effect=[False,True]):
    with self.assertRaisesRegex(RuntimeError,'health'):r.activate(new,'https://panel.test',pwd.getpwuid(os.getuid()))
   self.assertEqual((base/'current').resolve(),old);self.assertFalse((data/'deploying').exists())
   db=sqlite3.connect(data/'data.sqlite');self.assertEqual(db.execute('select * from important').fetchall(),[('original',)]);db.close()
   self.assertEqual(secrets.read_text(),'original secret');self.assertEqual(actions,['stop','start','stop','start'])
 def test_success_rotates_only_owned_releases_and_leaves_other_services(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data,state]:path.mkdir(parents=True)
   for char in ['a','b','c','d','e']:(base/'releases'/(char*40)).mkdir()
   other=base/'releases'/'unrelated';other.mkdir();(other/'keep').write_text('keep')
   new=base/'releases'/('e'*40);old=base/'releases'/('d'*40);(base/'current').symlink_to(old)
   with patch.multiple(r,BASE=base,DATA=data,STATE=state),patch.object(r,'service'),patch.object(r,'health',return_value=True):r.activate(new,'https://panel.test',pwd.getpwuid(os.getuid()))
   self.assertEqual((base/'current').resolve(),new);self.assertFalse((data/'deploying').exists());self.assertTrue((other/'keep').exists())
   self.assertLessEqual(len([p for p in (base/'releases').iterdir() if len(p.name)==40]),3)
 def test_rollback_copy_failure_does_not_delete_database_and_retains_maintenance(self):
  with tempfile.TemporaryDirectory() as folder:
   root=pathlib.Path(folder);base=root/'app';data=root/'data';state=root/'state'
   for path in [base/'releases',data,state]:path.mkdir(parents=True)
   old=base/'releases'/('a'*40);new=base/'releases'/('b'*40);old.mkdir();new.mkdir();(base/'current').symlink_to(old)
   db=sqlite3.connect(data/'data.sqlite');db.execute('create table important(value text)');db.execute("insert into important values ('original')");db.commit();db.close()
   actions=[]
   def action(command):
    actions.append(command)
    if command=='start' and (base/'current').resolve()==new:
     db=sqlite3.connect(data/'data.sqlite');db.execute("update important set value='failed upgrade preserved'");db.commit();db.close()
   with patch.multiple(r,BASE=base,DATA=data,STATE=state),patch.object(r,'service',side_effect=action),patch.object(r,'health',return_value=False),patch.object(r.shutil,'copy2',side_effect=OSError('disk full')):
    with self.assertRaisesRegex(OSError,'disk full'):r.activate(new,'https://panel.test',pwd.getpwuid(os.getuid()))
   self.assertTrue((data/'data.sqlite').exists());self.assertTrue((data/'deploying').exists())
   db=sqlite3.connect(data/'data.sqlite');self.assertEqual(db.execute('select value from important').fetchone()[0],'failed upgrade preserved');db.close()
   self.assertEqual(actions,['stop','start','stop'])
   snapshots=list((state/'snapshots').iterdir());self.assertEqual(len(snapshots),1)
   saved=sqlite3.connect(snapshots[0]/'data.sqlite');self.assertEqual(saved.execute('select value from important').fetchone()[0],'original');saved.close()
if __name__=='__main__':unittest.main()
