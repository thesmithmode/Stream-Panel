import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {StreamStore} from '../src/store.js';
import {EVENT_RETENTION_MS} from '../src/recent-events.js';
import {openProfileDatabase} from '../src/profile-db.js';

test('clip retention uses the event cutoff and keeps clips isolated by profile',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sp-clip-retention-'));
  const path=join(dir,'data.sqlite');
  const one=new StreamStore(path,'ruslan'),two=new StreamStore(path,'gulnaz');
  const now=Date.now(),old=now-EVENT_RETENTION_MS-1000;
  try{
    const id=one.startSession('42','200',old-1000,'platform',old-1000);
    const other=two.startSession('42','200',old-1000,'platform',old-1000);
    one.saveStreamClip(id,'42','200','old',old,1);
    one.saveStreamClip(id,'42','200','current',now,600);
    assert.deepEqual(one.streamClips(id,'42').clips.map(c=>c.id),['current']);
    assert.equal(two.streamClips(other,'42').clips.length,0);
    one.purgeRecentEvents();
    const db=openProfileDatabase(path,'ruslan');
    try{assert.deepEqual(db.prepare('SELECT id FROM stream_clips').all(),[{id:'current'}]);}
    finally{db.close();}
  }finally{one.close();two.close();rmSync(dir,{recursive:true,force:true});}
});
