-- Run only in the confirmed Stream Panel project. Private bucket, no public policies.
INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES ('stream-panel-backups','stream-panel-backups',false,50331648,ARRAY['application/octet-stream'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
