import test from 'node:test';
import assert from 'node:assert/strict';
import {PersonPlatformLinks} from '../src/person-platform-links.js';
const yt={id:'yt',source:'youtube',external_id:'UCabcdefghijklmnopqrstuv'};
const twitch=(id:string)=>({id:`identity-${id}`,source:'twitch',external_id:id});
test('profile links use provider IDs and logins, cache by profile scope and expire',async()=>{
 let now=0,calls=0;
 const links=new PersonPlatformLinks(async ids=>{calls++;return ids.map(id=>({id,login:`login_${id}`}));},()=>now);
 const identities=[twitch('42'),{...twitch('42'),id:'another-account'},yt,{id:'donor',source:'donationalerts',external_id:'name:login_42'}];
 const result=await links.list(identities,'owner');assert.equal(result.length,3);
 assert.equal(result[0]!.url,'https://www.twitch.tv/login_42');assert.equal(result[1]!.identityId,'another-account');assert.equal(result[2]!.url,`https://www.youtube.com/channel/${yt.external_id}`);
 await links.list(identities,'owner');assert.equal(calls,1);now=3600000;await links.list(identities,'owner');assert.equal(calls,2);
 await links.list(identities,'other-owner');assert.equal(calls,3);
 assert.deepEqual(await links.list(identities,''),[result[2]]);assert.equal(calls,3);
});
test('provider errors, missing users and unsafe identifiers never produce guessed addresses',async()=>{
 let now=0,calls=0;
 const links=new PersonPlatformLinks(async()=>{calls++;throw new Error('offline');},()=>now);
 const identities=[twitch('42'),twitch('display-name'),{...yt,external_id:'https://evil.invalid'}];
 assert.deepEqual(await links.list(identities,'owner'),[]);assert.equal(calls,1);
 await links.list(identities,'owner');assert.equal(calls,1);now=60000;await links.list(identities,'owner');assert.equal(calls,2);
 const unsafe=new PersonPlatformLinks(async()=>[{id:'42',login:'user/../../evil'},{id:'999',login:'unrelated'}]);
 assert.deepEqual(await unsafe.list([twitch('42')],'owner'),[]);
 const missing=new PersonPlatformLinks(async()=>[]);assert.deepEqual(await missing.list([twitch('42'),yt],'owner'),[{identityId:yt.id,source:'youtube',url:`https://www.youtube.com/channel/${yt.external_id}`}]);
});
test('lookup batches and cache are bounded, and old scope responses cannot populate a new scope',async()=>{
 let largest=0,calls=0;
 const links=new PersonPlatformLinks(async ids=>{largest=Math.max(largest,ids.length);calls++;return ids.map(id=>({id,login:'viewer'}));});
 assert.equal((await links.list(Array.from({length:501},(_,i)=>twitch(String(i))),'owner')).length,501);assert.equal(largest,100);assert.equal(calls,6);
 await links.list([twitch('0')],'owner');assert.equal(calls,7);
 let finish!:(users:{id:string;login:string}[])=>void;
 const pending=new PersonPlatformLinks(()=>new Promise(resolve=>finish=resolve));
 const old=pending.list([twitch('42')],'old');await pending.list([],'new');finish([{id:'42',login:'old'}]);assert.deepEqual(await old,[]);
});
