import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamStore} from '../src/store.js';
const at=Date.UTC(2026,9,9,12);
function person(s:StreamStore,id:string){s.youtubeMessages('channel','chat',[{id,snippet:{type:'textMessageEvent',publishedAt:new Date(at).toISOString()},authorDetails:{channelId:id,displayName:id}}]);return `youtube:${id}`;}

test('split undo restores exact Twitch/DA/YouTube memberships without moving events or losing notes on either person',()=>{
 const s=new StreamStore(':memory:');try{
  const source=person(s,'one'),other=person(s,'two');s.merge(other,source,s.personRevision(other),s.personRevision(source),at);
  const identity=(s.person(source).identities as any[]).find(i=>i.external_id==='two');
  const target=s.splitIdentities([identity.id],'Separate',s.personRevision(source),at+1);
  s.createPersonNote(source,'Source note',at+2);s.createPersonNote(target,'Target note',at+2);
  const operation=s.splits()[0]!;assert.equal(operation.target_person_id,target);
  s.undoSplit(String(operation.id),at+3);
  assert.equal((s.person(source).identities as any[]).length,2);assert.equal(s.events(undefined,source).length,2);
  assert.equal(s.personNotes(source).length,1);assert.equal(s.personNotes(target).length,1);
  assert.ok(s.persons().some(p=>p.id===target));assert.ok(s.splits()[0]!.undone_at_ms);
  assert.throws(()=>s.undoSplit(String(operation.id),at+4),/ALREADY_UNDONE/);
 }finally{s.close();}
});

test('split undo rejects later membership or revision changes atomically',()=>{
 const s=new StreamStore(':memory:');try{
  const source=person(s,'one'),identity=(s.person(source).identities as any[])[0];
  const target=s.splitIdentities([identity.id],'Separate',s.personRevision(source),at+1),operation=s.splits()[0]!;
  s.setPersonMetadata(target,['Changed'],true,s.personRevision(target));
  assert.throws(()=>s.undoSplit(String(operation.id),at+2),/UNDO_CONFLICT/);
  assert.equal((s.person(target).identities as any[]).length,1);assert.equal(s.events(undefined,target).length,1);
  assert.equal(s.splits()[0]!.undone_at_ms,null);
  assert.throws(()=>s.undoSplit('missing',at),/SPLIT_NOT_FOUND/);
  assert.throws(()=>s.undoSplit(String(operation.id),NaN),/INVALID_TIMESTAMP/);
 }finally{s.close();}
});
