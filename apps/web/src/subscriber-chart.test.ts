import test from 'node:test';import assert from 'node:assert/strict';
import {subscriberSteps,stepPath,publicationGroups} from './subscriber-chart.ts';
test('Twitch steps use reconciled provider time, YouTube retains observation time and count corrections are not invented',()=>{
 const counts=[{at:0,total:10},{at:900,total:12}],follows=[{id:'a',name:'A',at:200},{id:'b',name:'B',at:700}];
 assert.deepEqual(subscriberSteps(counts,follows,'twitch',0),[{at:0,total:10},{at:200,total:11},{at:700,total:12},{at:900,total:12}]);
 assert.deepEqual(subscriberSteps(counts,follows,'youtube',0),counts);assert.deepEqual(subscriberSteps([{at:0,total:10},{at:900,total:9}],follows,'twitch',100),[{at:100,total:10},{at:900,total:9}]);assert.equal(stepPath(counts,n=>n,n=>n),'M0,10 H900V12');assert.equal(stepPath([],n=>n,n=>n),'');
});
test('dense publication markers group by screen distance without dropping any videos',()=>{
 const videos=[0,5,10,80].map((n)=>({id:String(n),title:'Video',publishedAt:n,kind:'video' as const}));
 const mobile=publicationGroups(videos,0,100,100);assert.equal(mobile.length,2);assert.equal(mobile[0]?.items.length,3);assert.equal(mobile.flatMap(g=>g.items).length,4);assert.equal(publicationGroups([],0,1,300).length,0);assert.equal(publicationGroups(videos,0,100,1000).length,4);
});
