import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StreamStore} from '../src/store.js';

test('person notes preserve creation time, reject stale edits/deletes and remain isolated between profiles after restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sp-notes-')),path=join(dir,'db.sqlite');
 let a=new StreamStore(path,'ruslan');const b=new StreamStore(path,'gulnaz');
 const event={source:'twitch' as const,accountId:'channel',externalId:'message',type:'chat.message',actor:{externalId:'viewer',displayName:'Viewer'},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider' as const,transport:'eventsub' as const,payload:{text:'hi'}};
 try {
  const person=a.ingest(event).personId!,other=b.ingest(event).personId!;
  const n:any=a.createPersonNote(person,'  First  ',1000);
  assert.equal(n.body,'First');assert.equal(n.revision,0);
  assert.deepEqual(b.personNotes(other),[]);
  assert.throws(()=>b.updatePersonNote(other,n.id,'leak',0,2000),/NOTE_NOT_FOUND/);
  const updated:any=a.updatePersonNote(person,n.id,'Second',0,2000);
  assert.equal(updated.created_at_ms,1000);assert.equal(updated.updated_at_ms,2000);assert.equal(updated.revision,1);
  assert.throws(()=>a.updatePersonNote(person,n.id,'lost update',0,3000),/NOTE_CONFLICT/);
  assert.throws(()=>a.deletePersonNote(person,n.id,0),/NOTE_CONFLICT/);
  assert.throws(()=>a.createPersonNote(person,'  ',3000),/INVALID_NOTE_BODY/);
  assert.throws(()=>a.createPersonNote(person,'x'.repeat(10001),3000),/INVALID_NOTE_BODY/);
  assert.throws(()=>a.updatePersonNote(person,n.id,'bad revision',-1,3000),/INVALID_NOTE_REVISION/);
  assert.throws(()=>a.createPersonNote('missing','note',3000),/PERSON_NOT_FOUND/);
  const earlier:any=a.updatePersonNote(person,n.id,'Clock moved back',1,1500);
  assert.equal(earlier.updated_at_ms,2000);
  a.close();a=new StreamStore(path,'ruslan');
  assert.equal((a.personNotes(person)[0] as any).body,'Clock moved back');
  a.deletePersonNote(person,n.id,2);assert.deepEqual(a.personNotes(person),[]);
 }finally{a.close();b.close();rmSync(dir,{recursive:true,force:true});}
});

test('merged notes remain visible and edits retain their original person after undo',()=>{
 const store=new StreamStore(':memory:');
 const person=(id:string)=>store.ingest({source:'twitch',accountId:'channel',externalId:id,type:'chat.message',actor:{externalId:id,displayName:id},occurredAtMs:1000,receivedAtMs:1000,sourceTime:null,timeQuality:'provider',transport:'eventsub',payload:{text:'hi'}}).personId!;
 try {
  const a=person('a'),b=person('b'),c=person('c');
  const note:any=store.createPersonNote(a,'Original',1000);
  const m=store.merge(a,b,store.personRevision(a),store.personRevision(b),2000),nested=store.merge(b,c,store.personRevision(b),store.personRevision(c),3000);
  assert.equal(store.personNotes(c).length,1);
  store.updatePersonNote(c,note.id,'Edited while merged',0,4000);
  store.undoMerge(nested,5000);assert.throws(()=>store.undoMerge(m,6000),/UNDO_CONFLICT/);
  assert.deepEqual(store.personNotes(c),[]);assert.equal(store.personNotes(b).length,1);
  assert.equal((store.personNotes(a)[0] as any).body,'Edited while merged');
  assert.throws(()=>store.deletePersonNote(c,note.id,1),/NOTE_NOT_FOUND/);
 }finally{store.close();}
});
