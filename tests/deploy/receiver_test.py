import importlib.util, io, os, pathlib, pwd, sqlite3, tarfile, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('receiver',pathlib.Path(__file__).resolve().parents[2]/'ops/receive.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class ReceiverTests(unittest.TestCase):
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
if __name__=='__main__':unittest.main()
