import importlib.util, tempfile, unittest, types, os
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('cloud',Path(__file__).resolve().parents[2]/'ops/configure-cloud.py')
cloud=importlib.util.module_from_spec(spec);spec.loader.exec_module(cloud)
class CloudConfigurationTest(unittest.TestCase):
 def test_configures_only_existing_stream_panel_and_preserves_backup_key_settings(self):
  with tempfile.TemporaryDirectory() as root:
   payload=Path(root)/'payload';payload.mkdir();config=Path(root)/'config';config.mkdir()
   (payload/'supabase-url').write_text('https://eyverhyrhibwyiipgozn.supabase.co');(payload/'supabase-key').write_text('fixture-service-key')
   before='STREAM_PANEL_BACKUP_KEY_FILE=/keep/encryption-key\nSTREAM_PANEL_PORT=47831\n';(config/'server.env').write_text(before)
   with patch('grp.getgrnam',return_value=types.SimpleNamespace(gr_gid=os.getgid())),patch('os.fchown'):
    cloud.configure(payload,config);cloud.configure(payload,config)
   self.assertTrue((config/'server.env').read_text().startswith(before));self.assertEqual((config/'supabase-key').read_text(),'fixture-service-key')
   self.assertEqual((config/'server.env').read_text().count('STREAM_PANEL_SUPABASE_URL='),1)
   self.assertEqual(list(config.glob('.*')),[])
 def test_rejects_another_project_and_unsafe_secret_path_before_writes(self):
  with tempfile.TemporaryDirectory() as root:
   payload=Path(root)/'payload';payload.mkdir();config=Path(root)/'config';config.mkdir();(config/'server.env').write_text('unchanged')
   (payload/'supabase-url').write_text('https://other.supabase.co');(payload/'supabase-key').write_text('fixture')
   with self.assertRaises(SystemExit):cloud.configure(payload,config)
   self.assertEqual((config/'server.env').read_text(),'unchanged');self.assertFalse((config/'supabase-key').exists())
   (payload/'supabase-url').write_text('https://eyverhyrhibwyiipgozn.supabase.co')
   (config/'server.env').write_text('STREAM_PANEL_SUPABASE_URL=https://other.supabase.co\n')
   with self.assertRaises(SystemExit):cloud.configure(payload,config)
   self.assertFalse((config/'supabase-key').exists())
   (config/'server.env').write_text('unchanged');(config/'supabase-key').symlink_to(payload/'supabase-key')
   with patch('grp.getgrnam',return_value=types.SimpleNamespace(gr_gid=os.getgid())),self.assertRaises(SystemExit):cloud.configure(payload,config)
